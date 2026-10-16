import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'

interface LockRecord {
  pid: number
  owner: string
}

export interface CompanionLockDependencies {
  pid?: number
  isProcessAlive?: (pid: number) => boolean | Promise<boolean>
  randomBytes?: (size: number) => Uint8Array
}

export interface CompanionLock {
  readonly path: string
  readonly pid: number
  release(): Promise<void>
}

export class CompanionAlreadyRunningError extends Error {
  readonly code = 'COMPANION_ALREADY_RUNNING'

  constructor(readonly existingPid?: number) {
    super(
      existingPid === undefined
        ? 'companion is already running'
        : `companion is already running (pid ${existingPid})`,
    )
    this.name = 'CompanionAlreadyRunningError'
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function parseLockRecord(contents: string): LockRecord | undefined {
  try {
    const value = JSON.parse(contents) as Partial<LockRecord>
    if (
      Number.isInteger(value.pid) &&
      (value.pid ?? 0) > 0 &&
      typeof value.owner === 'string' &&
      value.owner.length > 0
    ) {
      return { pid: value.pid as number, owner: value.owner }
    }
  } catch {
    // An unreadable lock cannot be proven stale, so callers leave it in place.
  }
  return undefined
}

export async function acquireCompanionLock(
  lockPath: string,
  dependencies: CompanionLockDependencies = {},
): Promise<CompanionLock> {
  const pid = dependencies.pid ?? process.pid
  const isProcessAlive = dependencies.isProcessAlive ?? defaultIsProcessAlive
  const randomBytes = dependencies.randomBytes ?? nodeRandomBytes
  const owner = Buffer.from(randomBytes(8)).toString('hex')

  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 })

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid, owner }), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }

      let released = false
      return {
        path: lockPath,
        pid,
        release: async () => {
          if (released) {
            return
          }
          released = true
          let current: LockRecord | undefined
          try {
            current = parseLockRecord(await readFile(lockPath, 'utf8'))
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              return
            }
            throw error
          }
          if (current !== undefined && current.pid === pid && current.owner === owner) {
            await unlink(lockPath)
          }
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    }

    let existing: LockRecord | undefined
    try {
      existing = parseLockRecord(await readFile(lockPath, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      throw error
    }
    if (!existing || (await isProcessAlive(existing.pid))) {
      throw new CompanionAlreadyRunningError(existing?.pid)
    }

    try {
      const currentContents = await readFile(lockPath, 'utf8')
      const current = parseLockRecord(currentContents)
      if (current?.pid !== existing.pid || current.owner !== existing.owner) {
        continue
      }
      await unlink(lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }

  throw new CompanionAlreadyRunningError()
}
