import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CompanionAlreadyRunningError,
  acquireCompanionLock,
  createRuntimePaths,
  writeRuntimeDescriptor,
  type RuntimeDescriptor,
} from '../src/index.js'

const releases: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(releases.splice(0).map((release) => release()))
})

describe('runtime paths and descriptor', () => {
  it('generates Linux and macOS Unix socket paths in a private runtime directory', () => {
    const linux = createRuntimePaths({
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '/run/user/1000' },
      homedir: () => '/home/test',
      tmpdir: () => '/tmp',
      randomBytes: () => Buffer.from('0011223344556677', 'hex'),
    })
    expect(linux.runtimeDirectory).toBe('/run/user/1000/tabby-secure-mcp')
    expect(linux.endpoint).toBe('/run/user/1000/tabby-secure-mcp/companion.sock')
    expect(linux.descriptorPath).toBe('/run/user/1000/tabby-secure-mcp/descriptor.json')

    const macos = createRuntimePaths({
      platform: 'darwin',
      env: {},
      homedir: () => '/Users/test',
      tmpdir: () => '/private/tmp/test',
      randomBytes: () => Buffer.from('0011223344556677', 'hex'),
    })
    expect(macos.runtimeDirectory).toBe('/private/tmp/test/tabby-secure-mcp')
    expect(macos.endpoint.endsWith('/companion.sock')).toBe(true)
  })

  it('generates a random Windows named pipe and LOCALAPPDATA descriptor', () => {
    const paths = createRuntimePaths({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
      homedir: () => 'C:\\Users\\test',
      tmpdir: () => 'C:\\Temp',
      randomBytes: () => Buffer.from('0011223344556677', 'hex'),
    })

    expect(paths.endpoint).toBe('\\\\.\\pipe\\tabby-secure-mcp-0011223344556677')
    expect(paths.runtimeDirectory).toBe(
      'C:\\Users\\test\\AppData\\Local\\tabby-secure-mcp',
    )
    expect(paths.descriptorPath).toBe(
      'C:\\Users\\test\\AppData\\Local\\tabby-secure-mcp\\descriptor.json',
    )
  })

  it('creates a 0700 Unix directory and a 0600 descriptor containing the nonce', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'tabby-runtime-test-'))
    const paths = createRuntimePaths({
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: parent },
      homedir: () => parent,
      tmpdir: () => parent,
      randomBytes: () => Buffer.alloc(8),
    })
    const descriptor: RuntimeDescriptor = {
      protocol_version: 1,
      endpoint: paths.endpoint,
      pid: 123,
      expires_at: 456,
      pairing_nonce: 'descriptor-only-secret',
    }

    await writeRuntimeDescriptor(paths, descriptor, { platform: 'linux' })

    expect((await stat(paths.runtimeDirectory)).mode & 0o777).toBe(0o700)
    expect((await stat(paths.descriptorPath)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(paths.descriptorPath, 'utf8'))).toEqual(descriptor)
  })
})

describe('companion process lock', () => {
  it('rejects contention with a deterministic already-running error', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tabby-lock-test-'))
    const lockPath = path.join(directory, 'companion.lock')
    const first = await acquireCompanionLock(lockPath, {
      pid: 111,
      isProcessAlive: () => true,
      randomBytes: () => Buffer.from('aaaaaaaaaaaaaaaa', 'hex'),
    })
    releases.push(first.release)

    await expect(
      acquireCompanionLock(lockPath, {
        pid: 222,
        isProcessAlive: () => true,
        randomBytes: () => Buffer.from('bbbbbbbbbbbbbbbb', 'hex'),
      }),
    ).rejects.toMatchObject<Partial<CompanionAlreadyRunningError>>({
      code: 'COMPANION_ALREADY_RUNNING',
    })
  })

  it('recovers a stale lock and only its owner removes the replacement', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tabby-lock-stale-test-'))
    const lockPath = path.join(directory, 'companion.lock')
    await mkdir(directory, { recursive: true })
    await writeFile(lockPath, JSON.stringify({ pid: 999, owner: 'stale' }), { mode: 0o600 })

    const lock = await acquireCompanionLock(lockPath, {
      pid: 333,
      isProcessAlive: (pid) => pid !== 999,
      randomBytes: () => Buffer.from('cccccccccccccccc', 'hex'),
    })
    releases.push(lock.release)

    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual({
      pid: 333,
      owner: 'cccccccccccccccc',
    })
    await lock.release()
    releases.pop()
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
