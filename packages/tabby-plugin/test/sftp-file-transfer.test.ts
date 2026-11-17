import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { constants } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileTransferError, transferSshFile, type SftpFileHandlePort, type SftpSessionPort } from '../src/ssh/sftp-file-transfer'

// Keep real filesystem operations while allowing one native-open completion to be delayed.
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

async function fixture() {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'sftp-transfer-'))
  directories.push(dir)
  const files = new Map<string, Buffer>()
  const handles: Array<{ closed: boolean; writes: number; mode: number }> = []
  const sftp: SftpSessionPort = {
    stat: vi.fn(async p => {
      const data = files.get(p)
      if (!data) throw Object.assign(new Error('private remote path'), { code: 'ENOENT' })
      return { size: data.length, isDirectory: false, isSymlink: false, mode: 0o100600 }
    }),
    open: vi.fn(async (p, mode) => {
      if (mode === 42) {
        if (files.has(p)) throw Object.assign(new Error('private destination'), { code: 'EEXIST' })
        files.set(p, Buffer.alloc(0))
      } else if (mode !== 1 || !files.has(p)) throw new Error('bad flags or missing file')
      const state = { closed: false, writes: 0, mode }
      handles.push(state)
      let position = 0
      const handle: SftpFileHandlePort = {
        read: async () => {
          const data = files.get(p)!
          const chunk = data.subarray(position, position + 17113)
          position += chunk.length
          return chunk
        },
        write: async chunk => {
          expect(state.closed).toBe(false)
          expect(chunk.length).toBeLessThanOrEqual(256 * 1024)
          state.writes++
          files.set(p, Buffer.concat([files.get(p)!, chunk]))
        },
        close: async () => { state.closed = true },
      }
      return handle
    }),
    unlink: vi.fn(async p => { files.delete(p) }),
  }
  const abort = new AbortController()
  const options = { localPath: path.join(dir, 'file.bin'), remotePath: '/fixture/file.bin', sftp,
    current: () => true, signal: abort.signal, deadlineMonotonicMs: performance.now() + 5000 }
  return { dir, files, handles, sftp, abort, options }
}

describe('standalone SFTP file transfers', () => {
  it('reports a lost exclusive-create response as uncertain without deleting the remote destination', async () => {
    const f = await fixture()
    await fs.writeFile(f.options.localPath, 'SOURCE')
    vi.mocked(f.sftp.open).mockImplementationOnce(async p => {
      f.files.set(p, Buffer.alloc(0))
      throw new Error('lost create response')
    })
    await expect(transferSshFile({ ...f.options, direction: 'upload' })).rejects.toMatchObject({ code: 'outcome_unknown' })
    expect(f.files.has(f.options.remotePath)).toBe(true)
    expect(f.sftp.unlink).not.toHaveBeenCalled()
  })

  it('retains a remote replacement after upload failure instead of unlinking a pathname it cannot identify', async () => {
    const f = await fixture()
    await fs.writeFile(f.options.localPath, 'SOURCE')
    const open = f.sftp.open
    f.sftp.open = async (...args) => {
      const handle = await open(...args)
      handle.write = async () => {
        f.files.set(f.options.remotePath, Buffer.from('OTHER REMOTE OWNER'))
        throw new Error('remote write failed')
      }
      return handle
    }
    await expect(transferSshFile({ ...f.options, direction: 'upload' })).rejects.toMatchObject({ code: 'outcome_unknown' })
    expect(f.files.get(f.options.remotePath)?.toString()).toBe('OTHER REMOTE OWNER')
    expect(f.sftp.unlink).not.toHaveBeenCalled()
    expect(f.handles[0].closed).toBe(true)
    expect(await fs.readFile(f.options.localPath, 'utf8')).toBe('SOURCE')
  })

  it('requires local download sync before reporting success and removes its destination if sync fails', async () => {
    const f = await fixture()
    f.files.set(f.options.remotePath, Buffer.from('SOURCE'))
    const probe = await fs.open(path.join(f.dir, 'probe'), 'w')
    const prototype = Object.getPrototypeOf(probe)
    await probe.close()
    const sync = vi.spyOn(prototype, 'sync').mockRejectedValueOnce(new Error('private disk error'))
    await expect(transferSshFile({ ...f.options, direction: 'download' })).rejects.toMatchObject({ code: 'file_transfer_failed' })
    expect(sync).toHaveBeenCalledOnce()
    await expect(fs.stat(f.options.localPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.files.get(f.options.remotePath)?.toString()).toBe('SOURCE')
  })

  it('uploads binary data in bounded chunks with numeric exclusive-create flags', async () => {
    const f = await fixture()
    const data = Buffer.alloc(600_001)
    for (let i = 0; i < data.length; i++) data[i] = i % 256
    await fs.writeFile(f.options.localPath, data)
    expect(await transferSshFile({ ...f.options, direction: 'upload' })).toEqual({ bytesTransferred: data.length })
    expect(f.files.get(f.options.remotePath)?.equals(data)).toBe(true)
    expect((await fs.readFile(f.options.localPath)).equals(data)).toBe(true)
    expect(f.handles).toEqual([{ closed: true, writes: 3, mode: 42 }])
  })

  it('downloads varying binary chunks into a private exclusive file, handling partial local writes', async () => {
    const f = await fixture()
    const probe = await fs.open(path.join(f.dir, 'probe'), 'w')
    const prototype = Object.getPrototypeOf(probe)
    const original = prototype.write
    await probe.close()
    const sync = vi.spyOn(prototype, 'sync')
    vi.spyOn(prototype, 'write').mockImplementation(function (this: unknown, buffer: Uint8Array, offset: number, length: number, position: number | null) {
      return original.call(this, buffer, offset, Math.min(length, 701), position)
    })
    const data = Buffer.from(Array.from({ length: 100_003 }, (_, i) => i % 256))
    f.files.set(f.options.remotePath, data)
    expect(await transferSshFile({ ...f.options, direction: 'download' })).toEqual({ bytesTransferred: data.length })
    expect(await fs.readFile(f.options.localPath)).toEqual(data)
    expect(sync).toHaveBeenCalledOnce()
    if (process.platform !== 'win32') expect((await fs.stat(f.options.localPath)).mode & 0o777).toBe(0o600)
    expect(f.files.get(f.options.remotePath)).toEqual(data)
    expect(f.handles).toEqual([{ closed: true, writes: 0, mode: 1 }])
  })

  it.each(['upload', 'download'] as const)('transfers an empty %s file', async direction => {
    const f = await fixture()
    if (direction === 'upload') await fs.writeFile(f.options.localPath, '')
    else f.files.set(f.options.remotePath, Buffer.alloc(0))
    expect(await transferSshFile({ ...f.options, direction })).toEqual({ bytesTransferred: 0 })
  })

  it.each(['upload', 'download'] as const)('preserves preexisting %s destinations and both sources', async direction => {
    const f = await fixture()
    await fs.writeFile(f.options.localPath, 'LOCAL')
    f.files.set(f.options.remotePath, Buffer.from('REMOTE'))
    await expect(transferSshFile({ ...f.options, direction })).rejects.toMatchObject({ code: 'file_exists' })
    expect(await fs.readFile(f.options.localPath, 'utf8')).toBe('LOCAL')
    expect(f.files.get(f.options.remotePath)?.toString()).toBe('REMOTE')
    expect(f.sftp.unlink).not.toHaveBeenCalled()
  })

  it('refuses a racing remote destination using EXCL without retry or unlink', async () => {
    const f = await fixture()
    await fs.writeFile(f.options.localPath, 'source')
    const open = f.sftp.open
    f.sftp.open = async (p, flags) => { f.files.set(p, Buffer.from('racing owner')); return open(p, flags) }
    await expect(transferSshFile({ ...f.options, direction: 'upload' })).rejects.toMatchObject({ code: 'file_exists' })
    expect(f.files.get(f.options.remotePath)?.toString()).toBe('racing owner')
    expect(f.sftp.unlink).not.toHaveBeenCalled()
  })

  it.each(['upload', 'download'] as const)('rejects a %s source larger than 64 MiB before creating a destination', async direction => {
    const f = await fixture()
    if (direction === 'upload') {
      await fs.writeFile(f.options.localPath, '')
      await fs.truncate(f.options.localPath, 64 * 1024 * 1024 + 1)
    } else f.sftp.stat = async () => ({ size: 64 * 1024 * 1024 + 1, isDirectory: false })
    await expect(transferSshFile({ ...f.options, direction })).rejects.toMatchObject({ code: 'file_too_large' })
    expect(f.handles).toEqual([])
    expect(f.sftp.unlink).not.toHaveBeenCalled()
  })

  it.each([
    { localPath: 'relative' }, { localPath: '/tmp/a\nb' }, { remotePath: 'relative' },
    { remotePath: '/tmp/a\u0000b' }, { remotePath: '/tmp/a\u2028b' }, { remotePath: '/' }, { remotePath: '/directory/' },
  ])('rejects invalid paths before touching either filesystem: %j', async update => {
    const f = await fixture()
    await expect(transferSshFile({ ...f.options, ...update, direction: 'download' })).rejects.toMatchObject({ code: 'invalid_path' })
    expect(f.sftp.stat).not.toHaveBeenCalled()
    expect(f.handles).toEqual([])
  })

  it('rejects a local source symlink and directory, preserving their contents', async () => {
    const f = await fixture()
    const source = path.join(f.dir, 'source')
    await fs.writeFile(source, 'keep')
    await fs.symlink(source, f.options.localPath)
    await expect(transferSshFile({ ...f.options, direction: 'upload' })).rejects.toMatchObject({ code: 'invalid_path' })
    await expect(transferSshFile({ ...f.options, localPath: f.dir, direction: 'upload' })).rejects.toMatchObject({ code: 'invalid_path' })
    expect(await fs.readFile(source, 'utf8')).toBe('keep')
    expect(f.handles).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('rejects a FIFO source without waiting for a writer', async () => {
    const f = await fixture()
    execFileSync('mkfifo', [f.options.localPath])
    // Unblock a broken implementation's pending native open so the regression cannot strand the test worker.
    const unblock = setTimeout(() => { void fs.open(f.options.localPath, constants.O_WRONLY | constants.O_NONBLOCK)
      .then(handle => handle.close()).catch(() => {}) }, 150)
    await expect(transferSshFile({ ...f.options, direction: 'upload', deadlineMonotonicMs: performance.now() + 75 })).rejects.toMatchObject({ code: 'invalid_path' })
    clearTimeout(unblock)
  })

  it('never follows or removes an existing local destination symlink', async () => {
    const f = await fixture()
    const existing = path.join(f.dir, 'existing')
    await fs.writeFile(existing, 'keep')
    await fs.symlink(existing, f.options.localPath)
    f.files.set(f.options.remotePath, Buffer.from('incoming'))
    await expect(transferSshFile({ ...f.options, direction: 'download' })).rejects.toMatchObject({ code: 'file_exists' })
    expect(await fs.readFile(existing, 'utf8')).toBe('keep')
    expect((await fs.lstat(f.options.localPath)).isSymbolicLink()).toBe(true)
  })

  it.each([{ isDirectory: true }, { isSymlink: true }, { mode: 0o010600 }])('rejects nonordinary remote files: %j', async flags => {
    const f = await fixture()
    f.sftp.stat = async () => ({ size: 1, isDirectory: false, ...flags })
    await expect(transferSshFile({ ...f.options, direction: 'download' })).rejects.toMatchObject({ code: 'invalid_path' })
    expect(f.handles).toEqual([])
    await expect(fs.stat(f.options.localPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not create missing parent directories', async () => {
    const f = await fixture()
    f.files.set(f.options.remotePath, Buffer.from('incoming'))
    await expect(transferSshFile({ ...f.options, localPath: path.join(f.dir, 'missing', 'file'), direction: 'download' })).rejects.toMatchObject({ code: 'file_transfer_failed' })
    await expect(fs.stat(path.join(f.dir, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.handles.every(handle => handle.closed)).toBe(true)
  })

  it.each(['revoke', 'abort', 'deadline'] as const)('stops upload after %s without writing another chunk and retains the uncertain partial', async kind => {
    const f = await fixture()
    const data = Buffer.alloc(600_000, 172)
    await fs.writeFile(f.options.localPath, data)
    let valid = true
    const options = { ...f.options, current: () => valid, deadlineMonotonicMs: performance.now() + (kind === 'deadline' ? 200 : 5000) }
    const open = f.sftp.open
    f.sftp.open = async (...args) => {
      const handle = await open(...args)
      const write = handle.write
      handle.write = async chunk => {
        await write(chunk)
        if (kind === 'abort') f.abort.abort()
        else if (kind === 'revoke') valid = false
        else await new Promise(resolve => setTimeout(resolve, Math.max(1, options.deadlineMonotonicMs - performance.now() + 10)))
      }
      return handle
    }
    await expect(transferSshFile({ ...options, direction: 'upload' })).rejects.toMatchObject({ code: 'outcome_unknown' })
    expect(f.handles[0].writes).toBe(1)
    expect(f.handles[0].closed).toBe(true)
    expect(f.files.get(f.options.remotePath)).toEqual(data.subarray(0, 256 * 1024))
    expect(f.sftp.unlink).not.toHaveBeenCalled()
    expect(await fs.readFile(f.options.localPath)).toEqual(data)
  })

  it('revocation during a remote read prevents the first local write and preserves the source', async () => {
    const f = await fixture()
    f.files.set(f.options.remotePath, Buffer.from('SOURCE'))
    let valid = true
    let reads = 0
    const open = f.sftp.open
    f.sftp.open = async (...args) => {
      const handle = await open(...args)
      handle.read = async () => { reads++; valid = false; return Buffer.from('SOURCE') }
      return handle
    }
    await expect(transferSshFile({ ...f.options, direction: 'download', current: () => valid })).rejects.toMatchObject({ code: 'not_approved' })
    expect(reads).toBe(1)
    expect(f.files.get(f.options.remotePath)?.toString()).toBe('SOURCE')
    await expect(fs.stat(f.options.localPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['short', 'growing', 'oversized-chunk'] as const)('rejects %s remote data and removes the incomplete local destination', async kind => {
    const f = await fixture()
    f.files.set(f.options.remotePath, Buffer.from('SOURCE'))
    const open = f.sftp.open
    f.sftp.open = async (...args) => {
      const handle = await open(...args)
      handle.read = async () => kind === 'short' ? Buffer.alloc(0) : Buffer.alloc(kind === 'growing' ? 7 : 256 * 1024 + 1)
      return handle
    }
    await expect(transferSshFile({ ...f.options, direction: 'download' })).rejects.toMatchObject({ code: 'file_transfer_failed' })
    await expect(fs.stat(f.options.localPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.handles.every(handle => handle.closed)).toBe(true)
  })

  it('returns a sanitized unknown-outcome error while retaining a failed upload', async () => {
    const f = await fixture()
    await fs.writeFile(f.options.localPath, 'SOURCE')
    const open = f.sftp.open
    f.sftp.open = async (...args) => {
      const handle = await open(...args)
      handle.write = async () => { throw new Error('secret path /home/private/key') }
      return handle
    }
    let failure: unknown
    try { await transferSshFile({ ...f.options, direction: 'upload' }) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(FileTransferError)
    expect(failure).toMatchObject({ code: 'outcome_unknown', message: 'File transfer failed (outcome_unknown).' })
    expect(f.sftp.unlink).not.toHaveBeenCalled()
    expect(f.files.has(f.options.remotePath)).toBe(true)
    expect(await fs.readFile(f.options.localPath, 'utf8')).toBe('SOURCE')
  })

  it.each(['abort', 'revoke', 'deadline'] as const)('bounds a stalled read on %s, closes its file handle, and never writes a late chunk', async kind => {
    const f = await fixture()
    f.files.set(f.options.remotePath, Buffer.from('SOURCE'))
    let entered = false, valid = true
    let release!: (value: Uint8Array) => void
    const open = f.sftp.open
    f.sftp.open = async (...args) => {
      const handle = await open(...args)
      handle.read = () => { entered = true; return new Promise(resolve => { release = resolve }) }
      return handle
    }
    const result = transferSshFile({ ...f.options, direction: 'download', current: () => valid,
      deadlineMonotonicMs: performance.now() + (kind === 'deadline' ? 300 : 5000) })
    const rejection = expect(result).rejects.toMatchObject({ code: kind === 'abort' ? 'cancelled' : kind === 'revoke' ? 'not_approved' : 'expired' })
    await vi.waitFor(() => expect(entered).toBe(true))
    if (kind === 'abort') f.abort.abort()
    if (kind === 'revoke') valid = false
    await rejection
    expect(f.handles[0].closed).toBe(true)
    release(Buffer.from('SOURCE'))
    await Promise.resolve()
    await expect(fs.stat(f.options.localPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.files.get(f.options.remotePath)?.toString()).toBe('SOURCE')
  })

  it('closes a late-opened source handle after cancellation without creating a local destination', async () => {
    const f = await fixture()
    f.files.set(f.options.remotePath, Buffer.from('SOURCE'))
    let release!: () => void
    const open = f.sftp.open
    f.sftp.open = async (...args) => { await new Promise<void>(resolve => { release = resolve }); return open(...args) }
    const result = transferSshFile({ ...f.options, direction: 'download' })
    const rejection = expect(result).rejects.toMatchObject({ code: 'cancelled' })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    f.abort.abort()
    await rejection
    release()
    await vi.waitFor(() => expect(f.handles[0]?.closed).toBe(true))
    await expect(fs.stat(f.options.localPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.sftp.unlink).not.toHaveBeenCalled()
  })

  it('reports uncertainty for an unresolved exclusive create, then closes its late handle without unlinking', async () => {
    const f = await fixture()
    await fs.writeFile(f.options.localPath, 'SOURCE')
    let release!: () => void
    const open = f.sftp.open
    f.sftp.open = async (...args) => { await new Promise<void>(resolve => { release = resolve }); return open(...args) }
    const result = transferSshFile({ ...f.options, direction: 'upload' })
    const rejection = expect(result).rejects.toMatchObject({ code: 'outcome_unknown' })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    f.abort.abort()
    await rejection
    expect(f.files.has(f.options.remotePath)).toBe(false)
    release()
    await vi.waitFor(() => expect(f.handles[0]?.closed).toBe(true))
    expect(f.files.has(f.options.remotePath)).toBe(true)
    expect(f.sftp.unlink).not.toHaveBeenCalled()
    expect(await fs.readFile(f.options.localPath, 'utf8')).toBe('SOURCE')
  })

  it('never removes a replacement local file during rollback', async () => {
    const f = await fixture()
    f.files.set(f.options.remotePath, Buffer.from('SOURCE'))
    const open = f.sftp.open
    f.sftp.open = async (...args) => {
      const handle = await open(...args)
      handle.read = async () => {
        await fs.rename(f.options.localPath, path.join(f.dir, 'owned-partial'))
        await fs.writeFile(f.options.localPath, 'OTHER OWNER')
        throw new Error('read failed')
      }
      return handle
    }
    await expect(transferSshFile({ ...f.options, direction: 'download' })).rejects.toMatchObject({ code: 'outcome_unknown' })
    expect(await fs.readFile(f.options.localPath, 'utf8')).toBe('OTHER OWNER')
    expect(await fs.readFile(path.join(f.dir, 'owned-partial'))).toEqual(Buffer.alloc(0))
  })

  it('never retries exclusive creation with weaker flags after an ambiguous open failure', async () => {
    const f = await fixture()
    await fs.writeFile(f.options.localPath, 'SOURCE')
    f.sftp.open = vi.fn(async () => { throw new Error('Unsupported flags') })
    await expect(transferSshFile({ ...f.options, direction: 'upload' })).rejects.toMatchObject({ code: 'outcome_unknown' })
    expect(f.sftp.open).toHaveBeenCalledExactlyOnceWith(f.options.remotePath, 42)
    expect(f.sftp.unlink).not.toHaveBeenCalled()
    expect(await fs.readFile(f.options.localPath, 'utf8')).toBe('SOURCE')
  })

  it('cleans a late local exclusive open after cancellation without leaving a file handle open', async () => {
    const f = await fixture()
    f.files.set(f.options.remotePath, Buffer.from('SOURCE'))
    const originalOpen = fs.open
    let release!: () => void
    let closed = false
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      const close = handle.close.bind(handle)
      handle.close = async () => { await close(); closed = true }
      await new Promise<void>(resolve => { release = resolve })
      return handle
    })
    const result = transferSshFile({ ...f.options, direction: 'download' })
    const rejection = expect(result).rejects.toMatchObject({ code: 'outcome_unknown' })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    f.abort.abort()
    await rejection
    release()
    await vi.waitFor(() => expect(closed).toBe(true))
    await expect(fs.stat(f.options.localPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.handles[0].closed).toBe(true)
  })

  it('checks a failed final upload size verification and retains the uncertain destination', async () => {
    const f = await fixture()
    await fs.writeFile(f.options.localPath, 'SOURCE')
    const stat = f.sftp.stat
    f.sftp.stat = async p => { const value = await stat(p); return { ...value, size: value.size + 1 } }
    await expect(transferSshFile({ ...f.options, direction: 'upload' })).rejects.toMatchObject({ code: 'outcome_unknown' })
    expect(f.files.get(f.options.remotePath)?.toString()).toBe('SOURCE')
    expect(f.sftp.unlink).not.toHaveBeenCalled()
    expect(f.handles[0].closed).toBe(true)
    expect(await fs.readFile(f.options.localPath, 'utf8')).toBe('SOURCE')
  })

  it.each(['abort', 'revoke', 'deadline'] as const)('rejects an already invalid %s request before opening anything', async kind => {
    const f = await fixture()
    if (kind === 'abort') f.abort.abort()
    await expect(transferSshFile({ ...f.options, direction: 'download', current: () => kind !== 'revoke',
      deadlineMonotonicMs: kind === 'deadline' ? performance.now() - 1 : f.options.deadlineMonotonicMs }))
      .rejects.toMatchObject({ code: kind === 'abort' ? 'cancelled' : kind === 'revoke' ? 'not_approved' : 'expired' })
    expect(f.sftp.stat).not.toHaveBeenCalled()
    expect(f.handles).toEqual([])
  })

  it('reports revocation before a destination open as denied, not an uncertain creation', async () => {
    const f = await fixture()
    await fs.writeFile(f.options.localPath, 'SOURCE')
    let current = true
    f.sftp.stat = async () => { current = false; throw new Error('missing') }
    await expect(transferSshFile({ ...f.options, direction: 'upload', current: () => current })).rejects.toMatchObject({ code: 'not_approved' })
    expect(f.handles).toEqual([])
    expect(f.sftp.unlink).not.toHaveBeenCalled()
  })
})
