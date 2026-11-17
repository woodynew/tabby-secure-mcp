import type { ErrorCode } from '../runtime/ipc-contract-api'
import { constants, type Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'

const MAX_BYTES = 64 * 1024 * 1024
const CHUNK_BYTES = 256 * 1024
const CLEANUP_MS = 1000

async function cleanup(operation: () => Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(operation).then(() => true, () => false),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), CLEANUP_MS) }),
    ])
  } finally { clearTimeout(timer) }
}

function errorCode(error: unknown): ErrorCode {
  if (error instanceof FileTransferError) return error.code
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'EEXIST' || code === 11) return 'file_exists'
  if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'EISDIR' || code === 'EINVAL') return 'invalid_path'
  return 'file_transfer_failed'
}

function checkSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new FileTransferError('file_transfer_failed')
  if (size > MAX_BYTES) throw new FileTransferError('file_too_large')
}

function checkRemoteFile(stat: Awaited<ReturnType<SftpSessionPort['stat']>>): void {
  const type = stat.mode === undefined ? 0 : stat.mode & 0o170000
  if (stat.isDirectory || stat.isSymlink || (type !== 0 && type !== 0o100000)) throw new FileTransferError('invalid_path')
  checkSize(stat.size)
}

async function removeLocalDestination(localPath: string, handle: FileHandle, identity?: Stats): Promise<void> {
  const owned = identity ?? await handle.stat()
  let current: Stats
  try { current = await fs.lstat(localPath) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  if (current.dev !== owned.dev || current.ino !== owned.ino) throw new FileTransferError('outcome_unknown')
  await fs.unlink(localPath)
}

export interface SftpFileHandlePort {
  read(): Promise<Uint8Array>
  write(chunk: Uint8Array): Promise<void>
  close(): Promise<void>
}

export interface SftpSessionPort {
  stat(path: string): Promise<{ size: number; isDirectory: boolean; isSymlink?: boolean; mode?: number }>
  open(path: string, mode: number): Promise<SftpFileHandlePort>
  unlink(path: string): Promise<void>
}

export class FileTransferError extends Error {
  constructor(readonly code: ErrorCode) {
    super(`File transfer failed (${code}).`)
    this.name = 'FileTransferError'
  }
}

export async function transferSshFile(input: {
  direction: 'upload' | 'download'
  localPath: string
  remotePath: string
  sftp: SftpSessionPort
  current: () => boolean
  signal: AbortSignal
  deadlineMonotonicMs: number
}): Promise<{ bytesTransferred: number }> {
  const check = (): void => {
    if (input.signal.aborted) throw new FileTransferError('cancelled')
    let current = false
    try { current = input.current() } catch { /* A failed authorization check denies the operation. */ }
    if (input.signal.aborted) throw new FileTransferError('cancelled')
    if (!Number.isFinite(input.deadlineMonotonicMs) || performance.now() >= input.deadlineMonotonicMs) throw new FileTransferError('expired')
    if (!current) throw new FileTransferError('not_approved')
  }
  // Race even non-cancellable native SFTP promises; a late open still owns its cleanup.
  const io = <T>(operation: () => Promise<T>, late?: (value: T) => void): Promise<T> => {
    check()
    return new Promise<T>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (error?: unknown, value?: T): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        input.signal.removeEventListener('abort', aborted)
        if (error) reject(error)
        else resolve(value!)
      }
      const aborted = (): void => finish(new FileTransferError('cancelled'))
      const poll = (): void => {
        try { check() } catch (error) { finish(error); return }
        timer = setTimeout(poll, Math.min(25, Math.max(1, input.deadlineMonotonicMs - performance.now())))
      }
      input.signal.addEventListener('abort', aborted, { once: true })
      poll()
      if (settled) return
      let pending: Promise<T>
      try { pending = operation() } catch (error) { finish(error); return }
      pending.then(value => {
        if (settled) { late?.(value); return }
        try { check() } catch (error) { late?.(value); finish(error); return }
        finish(undefined, value)
      }, error => finish(error))
    })
  }

  let local: FileHandle | undefined
  let remote: SftpFileHandlePort | undefined
  let localOwned = false, remoteOwned = false, creationPending = false, remoteCreationFailed = false
  let localIdentity: Stats | undefined
  let lateCleanup: Promise<boolean> | undefined
  const lateLocal = (handle: FileHandle, destination: boolean): void => {
    lateCleanup = (async () => {
      const removed = !destination || await cleanup(() => removeLocalDestination(input.localPath, handle))
      const closed = await cleanup(() => handle.close())
      return removed && closed
    })()
  }
  const lateRemote = (handle: SftpFileHandlePort, destination: boolean): void => {
    lateCleanup = (async () => {
      const closed = await cleanup(() => handle.close())
      return !destination && closed
    })()
  }
  try {
    check()
    const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
    if (!['upload', 'download'].includes(input.direction) || typeof input.localPath !== 'string' || typeof input.remotePath !== 'string'
      || !path.isAbsolute(input.localPath) || !path.posix.isAbsolute(input.remotePath)
      || controls.test(input.localPath) || controls.test(input.remotePath)
      || /\/$/.test(input.remotePath) || ['.', '..'].includes(path.posix.basename(input.remotePath))) throw new FileTransferError('invalid_path')

    let size: number
    if (input.direction === 'upload') {
      const source = await io(() => fs.lstat(input.localPath))
      if (!source.isFile()) throw new FileTransferError('invalid_path')
      local = await io(() => fs.open(input.localPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)), handle => lateLocal(handle, false))
      const stat = await io(() => local!.stat())
      if (!stat.isFile()) throw new FileTransferError('invalid_path')
      size = stat.size
      checkSize(size)
      let exists = false
      try { await io(() => input.sftp.stat(input.remotePath)); exists = true }
      catch (error) { if (error instanceof FileTransferError) throw error }
      if (exists) throw new FileTransferError('file_exists')
      remote = await io(() => {
        creationPending = true
        return input.sftp.open(input.remotePath, 2 | 8 | 32)
          .catch(error => { remoteCreationFailed = errorCode(error) !== 'file_exists'; throw error })
          .finally(() => { creationPending = false })
      }, handle => lateRemote(handle, true))
      remoteOwned = true
    } else {
      const stat = await io(() => input.sftp.stat(input.remotePath))
      checkRemoteFile(stat)
      size = stat.size
      remote = await io(() => input.sftp.open(input.remotePath, 1), handle => lateRemote(handle, false))
      local = await io(() => {
        creationPending = true
        return fs.open(input.localPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
          .finally(() => { creationPending = false })
      }, handle => lateLocal(handle, true))
      localOwned = true
      localIdentity = await io(() => local!.stat())
      if (!localIdentity.isFile()) throw new FileTransferError('invalid_path')
    }

    let bytesTransferred = 0
    const buffer = Buffer.alloc(CHUNK_BYTES)
    while (true) {
      const chunk = input.direction === 'upload'
        ? buffer.subarray(0, (await io(() => local!.read(buffer, 0, buffer.length, null))).bytesRead)
        : await io(() => remote!.read())
      if (!(chunk instanceof Uint8Array) || chunk.length > CHUNK_BYTES) throw new FileTransferError('file_transfer_failed')
      if (!chunk.length) break
      checkSize(bytesTransferred + chunk.length)
      if (bytesTransferred + chunk.length > size) throw new FileTransferError('file_transfer_failed')
      if (input.direction === 'upload') await io(() => remote!.write(chunk))
      else {
        let offset = 0
        while (offset < chunk.length) {
          const { bytesWritten } = await io(() => local!.write(chunk, offset, chunk.length - offset, null))
          if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > chunk.length - offset) throw new FileTransferError('file_transfer_failed')
          offset += bytesWritten
        }
      }
      bytesTransferred += chunk.length
    }
    if (bytesTransferred !== size) throw new FileTransferError('file_transfer_failed')
    const localStat = await io(() => local!.stat())
    if (!localStat.isFile() || localStat.size !== size) throw new FileTransferError('file_transfer_failed')
    await io(() => remote!.close())
    remote = undefined
    const remoteStat = await io(() => input.sftp.stat(input.remotePath))
    checkRemoteFile(remoteStat)
    if (remoteStat.size !== size) throw new FileTransferError('file_transfer_failed')
    if (input.direction === 'download') await io(() => local!.sync())
    await io(() => local!.close())
    local = undefined
    check()
    return { bytesTransferred }
  } catch (error) {
    // The SFTP port cannot identify a replaced pathname; retain partial uploads rather than deleting another actor's file.
    let uncertain = creationPending || remoteOwned || remoteCreationFailed
    if (localOwned) {
      const handle = local
      uncertain = !await cleanup(() => removeLocalDestination(input.localPath, handle!, localIdentity)) || uncertain
    }
    if (local) uncertain = !await cleanup(() => local!.close()) || uncertain
    if (remote) uncertain = !await cleanup(() => remote!.close()) || uncertain
    if (lateCleanup) uncertain = !await lateCleanup || uncertain
    throw new FileTransferError(uncertain ? 'outcome_unknown' : errorCode(error))
  }
}
