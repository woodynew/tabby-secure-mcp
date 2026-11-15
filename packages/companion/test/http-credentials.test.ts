import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClientIdentity } from '../src/http/contracts.js'
import * as implementation from '../src/http/credentials.js'
const directories: string[] = []
const DAY = 86_400_000
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))) })

async function setup(options: { now?: () => number; fs?: Partial<typeof fs> } = {}) {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'http-credentials-'))
  directories.push(dir)
  const file = path.join(dir, 'private', 'credentials.json')
  expect(implementation?.CredentialStore).toBeTypeOf('function')
  const store = new implementation!.CredentialStore(file, options)
  await store.load()
  return { store, file, dir }
}

function latch() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

async function postRenameFailure(phase: 'open' | 'sync' | 'close') {
  let armed = false, renamed = false, parent = ''
  const fixture = await setup({ fs: {
    rename: async (from, to) => { await fs.rename(from, to); if (armed) renamed = true },
    open: async (...args: Parameters<typeof fs.open>) => {
      const fail = armed && renamed && String(args[0]) === parent
      if (fail && phase === 'open') throw new Error('post-rename directory open failed')
      const handle = await fs.open(...args)
      if (fail && phase === 'sync') handle.sync = async () => { throw new Error('post-rename directory sync failed') }
      if (fail && phase === 'close') {
        const close = handle.close.bind(handle)
        handle.close = async () => { await close(); throw new Error('post-rename directory close failed') }
      }
      return handle
    },
  } })
  parent = path.dirname(fixture.file)
  return { ...fixture, arm: () => { armed = true; renamed = false }, stop: () => { armed = false } }
}

describe('CredentialStore', () => {
  it.skipIf(process.platform === 'win32').each(['open', 'sync', 'close'] as const)('denies permission changes after a post-rename %s failure until an explicit retry', async phase => {
    const f = await postRenameFailure(phase)
    const client = await f.store.create('Agent'), token = f.store.tokenFor(client.id)
    await f.store.grant(client.id, client.generation, 'permanent')
    f.arm()
    await expect(f.store.setPermission(client.id, client.generation, 'session')).rejects.toThrow()
    expect(f.store.authenticate(token)).toBeUndefined()
    expect(f.store.consumeSessionPermission(client.id, client.generation + 1)).toBe(false)
    await expect(new implementation.CredentialStore(f.file).load()).rejects.toThrow()
    f.stop()
    await f.store.setPermission(client.id, client.generation, 'none')
    expect(f.store.tokenFor(client.id)).toBe(token)
    expect(f.store.permission(client.id)).toEqual({ kind: 'none' })
  })

  it('refuses stale or invalid permission edits without disconnecting a current client', async () => {
    const { store } = await setup()
    const client = await store.create('Agent'), token = store.tokenFor(client.id)
    await expect(store.setPermission(client.id, client.generation + 1, 'none')).rejects.toThrow()
    await expect(store.setPermission(client.id, client.generation, 'unexpected' as never)).rejects.toThrow()
    expect(store.authenticate(token)).toMatchObject({ id: client.id, generation: client.generation })
  })

  it('changes permission without changing the token and makes session-only approval one use and nonpersistent', async () => {
    const { store, file } = await setup({ now: () => 1_000 })
    const client = await store.create('Agent'), neighbor = await store.create('Other')
    const token = store.tokenFor(client.id)
    let generation = client.generation
    for (const duration of ['permanent', '24h', 'session', 'none'] as const) {
      const changing = store.setPermission(client.id, generation, duration)
      expect(store.authenticate(token)).toBeUndefined()
      expect(store.isCurrent(neighbor)).toBe(true)
      await changing
      generation++
      expect(store.authenticate(token)?.generation).toBe(generation)
      expect(store.tokenFor(client.id)).toBe(token)
      expect(store.permission(client.id).kind).toBe(duration === '24h' ? 'until' : duration)
      const restarted = new implementation.CredentialStore(file, { now: () => 1_000 })
      await restarted.load()
      expect(restarted.permission(client.id).kind).toBe(duration === 'session' ? 'none' : duration === '24h' ? 'until' : duration)
      if (duration === 'session') {
        expect(store.consumeSessionPermission(client.id, generation - 1)).toBe(false)
        expect(store.consumeSessionPermission(client.id, generation)).toBe(true)
        expect(store.consumeSessionPermission(client.id, generation)).toBe(false)
      }
    }
    expect(store.permission(neighbor.id)).toEqual({ kind: 'none' })
  })

  it('keeps a failed permission change denied and allows an explicit retry', async () => {
    let fail = false
    const { store } = await setup({ fs: { rename: async (from, to) => {
      if (fail) throw new Error('disk full')
      await fs.rename(from, to)
    } } })
    const client = await store.create('Agent'), token = store.tokenFor(client.id)
    await store.grant(client.id, client.generation, 'permanent')
    fail = true
    await expect(store.setPermission(client.id, client.generation, 'none')).rejects.toThrow()
    expect(store.authenticate(token)).toBeUndefined()
    expect(store.hasUnpersistedRevocations).toBe(true)
    fail = false
    await store.setPermission(client.id, client.generation, 'none')
    expect(store.authenticate(token)).toBeDefined()
    expect(store.permission(client.id)).toEqual({ kind: 'none' })
    expect(store.hasUnpersistedRevocations).toBe(false)
  })

  it.each(['rename', 'create', 'grant'] as const)('keeps a failed permission edit recoverable after another client %s succeeds', async operation => {
    let fail = false
    const { store, file } = await setup({ fs: { rename: async (from, to) => {
      if (fail) throw new Error('disk full')
      await fs.rename(from, to)
    } } })
    const a = await store.create('Agent A'), b = await store.create('Agent B')
    const token = store.tokenFor(a.id)
    await store.grant(a.id, a.generation, 'permanent')
    fail = true
    await expect(store.setPermission(a.id, a.generation, '24h')).rejects.toThrow()
    fail = false
    if (operation === 'rename') await store.rename(b.id, 'Renamed B')
    else if (operation === 'create') await store.create('Agent C')
    else await store.grant(b.id, b.generation, 'permanent')
    expect(store.list().some(client => client.id === a.id)).toBe(true)
    expect(store.authenticate(token)).toBeUndefined()
    expect(store.hasUnpersistedRevocations).toBe(true)
    const restarted = new implementation.CredentialStore(file)
    await restarted.load()
    expect(restarted.authenticate(token)?.id).toBe(a.id)
    expect(restarted.permission(a.id)).toEqual({ kind: 'none' })
    await store.setPermission(a.id, a.generation, '24h')
    expect(store.tokenFor(a.id)).toBe(token)
    expect(store.permission(a.id).kind).toBe('until')
  })

  it('never restores a later revocation when an earlier permission change finishes saving', async () => {
    let block = false
    const entered = latch(), proceed = latch()
    const { store } = await setup({ fs: { rename: async (from, to) => {
      if (block) { block = false; entered.release(); await proceed.promise }
      await fs.rename(from, to)
    } } })
    const client = await store.create('Agent'), token = store.tokenFor(client.id)
    block = true
    const changing = store.setPermission(client.id, client.generation, 'permanent')
    const rejected = expect(changing).rejects.toThrow()
    await entered.promise
    const revoking = store.revoke(client.id)
    proceed.release()
    await rejected
    await revoking
    expect(store.authenticate(token)).toBeUndefined()
    expect(store.list()).toEqual([])
  })

  it.each(['none', '24h', 'session'] as const)('commits a newer %s permission when an older update advances generation during save', async duration => {
    let block = false
    const entered = latch(), proceed = latch()
    const { store, file } = await setup({ fs: { rename: async (from, to) => {
      if (block) { block = false; entered.release(); await proceed.promise }
      await fs.rename(from, to)
    } } })
    const client = await store.create('Agent'), token = store.tokenFor(client.id)
    block = true
    const earlier = store.setPermission(client.id, client.generation, 'permanent')
    const rejected = expect(earlier).rejects.toThrow()
    await entered.promise
    const latest = store.setPermission(client.id, client.generation, duration)
    proceed.release()
    await rejected
    await latest
    expect(store.tokenFor(client.id)).toBe(token)
    expect(store.permission(client.id).kind).toBe(duration === '24h' ? 'until' : duration)
    const restarted = new implementation.CredentialStore(file)
    await restarted.load()
    expect(restarted.authenticate(token)).toBeDefined()
    expect(restarted.permission(client.id).kind).toBe(duration === '24h' ? 'until' : 'none')
  })

  it('isolates identically named clients and reveals tokens only to explicit tokenFor calls', async () => {
    const { store } = await setup()
    const first = await store.create('  editor  ')
    const second = await store.create('editor')
    expect(first.name).toBe('editor')
    expect(first.id).not.toBe(second.id)
    const token = store.tokenFor(first.id)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(store.tokenFor(second.id)).not.toBe(token)
    expect(store.authenticate(token)).toEqual({ id: first.id, name: 'editor', generation: first.generation })
    expect(store.authenticate('bad')).toBeUndefined()
    expect(store.authenticate('x'.repeat(43))).toBeUndefined()
    expect(JSON.stringify([first, store.list(), store.authenticate(token)])).not.toContain(token)
    await store.grant(first.id, first.generation, 'permanent')
    expect(store.permission(second.id)).toEqual({ kind: 'none' })
    await store.revoke(first.id)
    expect(store.authenticate(token)).toBeUndefined()
    expect(store.isCurrent(second)).toBe(true)
  })

  it('validates trimmed Unicode names and preserves token, generation and permission across rename/restart', async () => {
    const { store, file } = await setup({ now: () => 100 })
    for (const name of ['', '   ', 'a\nb', '\u007f', '🙂'.repeat(81)]) {
      await expect(store.create(name)).rejects.toThrow()
    }
    const client = await store.create('🙂'.repeat(80))
    const token = store.tokenFor(client.id)
    await store.grant(client.id, client.generation, 'permanent')
    await expect(store.rename(client.id, '\u0000')).rejects.toThrow()
    await store.rename(client.id, '  renamed  ')
    expect(store.list()).toEqual([{ ...client, name: 'renamed', permission: { kind: 'permanent', approvedAt: 100 } }])
    expect(store.tokenFor(client.id)).toBe(token)
    expect(store.isCurrent(client)).toBe(true)
    const restarted = new implementation!.CredentialStore(file, { now: () => DAY * 30 })
    await restarted.load()
    expect(restarted.tokenFor(client.id)).toBe(token)
    expect(restarted.permission(client.id)).toEqual({ kind: 'permanent', approvedAt: 100 })
    const views = restarted.list()
    views[0]!.name = 'mutated'
    views[0]!.permission.kind = 'none'
    expect(restarted.list()[0]!.name).toBe('renamed')
    expect(restarted.permission(client.id).kind).toBe('permanent')
  })

  it('expires 24h from approval, rejects backward clocks, and never expires permanent permission', async () => {
    let now = 1_000
    const { store, file } = await setup({ now: () => now })
    const client = await store.create('editor')
    await store.grant(client.id, client.generation, '24h')
    expect(store.permission(client.id)).toEqual({ kind: 'until', approvedAt: 1_000, expiresAt: 86_401_000 })
    now = DAY
    const restarted = new implementation!.CredentialStore(file, { now: () => now })
    await restarted.load()
    expect(restarted.permission(client.id).kind).toBe('until')
    now = DAY + 1_000
    expect(restarted.permission(client.id)).toEqual({ kind: 'none' })
    now = 2_000
    expect(restarted.permission(client.id)).toEqual({ kind: 'none' })
    await store.grant(client.id, client.generation, '24h')
    now = 1_999
    expect(store.permission(client.id)).toEqual({ kind: 'none' })
    await store.grant(client.id, client.generation, 'permanent')
    now = DAY * 1_000
    expect(store.permission(client.id)).toEqual({ kind: 'permanent', approvedAt: 1_999 })
    const permanent = new implementation!.CredentialStore(file, { now: () => now })
    await permanent.load()
    expect(permanent.permission(client.id).kind).toBe('permanent')
    expect(JSON.parse(await fs.readFile(file, 'utf8')).credentials[0].permission).not.toHaveProperty('expiresAt')
  })

  it('rejects a finite permission loaded before its approval time', async () => {
    const { store, file } = await setup({ now: () => 1_000 })
    const client = await store.create('editor')
    await store.grant(client.id, client.generation, '24h')
    const restarted = new implementation!.CredentialStore(file, { now: () => 999 })
    await restarted.load()
    expect(restarted.permission(client.id)).toEqual({ kind: 'none' })
  })

  it('starts 24h at approval invocation even when another transaction delays persistence', async () => {
    let now = 1_000, block = false
    const entered = latch(), proceed = latch()
    const { store } = await setup({ now: () => now, fs: { rename: async (from, to) => {
      if (block) { block = false; entered.release(); await proceed.promise }
      return fs.rename(from, to)
    } } })
    const client = await store.create('editor')
    block = true
    const renaming = store.rename(client.id, 'renamed')
    await entered.promise
    const granting = store.grant(client.id, client.generation, '24h')
    now = 2_000
    proceed.release()
    await renaming; await granting
    expect(store.permission(client.id)).toEqual({ kind: 'until', approvedAt: 1_000, expiresAt: 86_401_000 })
  })

  it('cannot hide a clock rollback for one client by granting another client', async () => {
    let now = 1_000
    const { store } = await setup({ now: () => now })
    const a = await store.create('a'), b = await store.create('b')
    await store.grant(a.id, a.generation, '24h')
    now = 5_000
    expect(store.permission(a.id).kind).toBe('until')
    now = 2_000
    await store.grant(b.id, b.generation, 'permanent')
    expect(store.permission(a.id)).toEqual({ kind: 'none' })
    now = 6_000
    expect(store.permission(a.id)).toEqual({ kind: 'none' })
    await store.grant(a.id, a.generation, '24h')
    expect(store.permission(a.id).kind).toBe('until')
  })

  it('observes the startup clock before the first permission query', async () => {
    let now = 1_000
    const { store, file } = await setup({ now: () => now })
    const client = await store.create('editor')
    await store.grant(client.id, client.generation, '24h')
    now = 5_000
    const restarted = new implementation.CredentialStore(file, { now: () => now })
    await restarted.load()
    now = 2_000
    expect(restarted.permission(client.id)).toEqual({ kind: 'none' })
  })

  it('notifies a newly observed finite expiry once without recursive observer loops', async () => {
    let now = 1_000
    const { store } = await setup({ now: () => now })
    const client = await store.create('editor')
    await store.grant(client.id, client.generation, '24h')
    let changes = 0
    store.onChange(() => { changes++; store.list() })
    now = 86_401_000
    expect(store.permission(client.id)).toEqual({ kind: 'none' })
    expect(changes).toBe(1)
    expect(store.permission(client.id)).toEqual({ kind: 'none' })
    expect(changes).toBe(1)
  })

  it('does not publish a pending grant before its atomic replacement', async () => {
    let block = false
    const entered = latch(), proceed = latch()
    const { store } = await setup({ fs: { rename: async (from, to) => {
      if (block) { block = false; entered.release(); await proceed.promise }
      return fs.rename(from, to)
    } } })
    const client = await store.create('editor')
    block = true
    const granting = store.grant(client.id, client.generation, 'permanent')
    await entered.promise
    expect(store.permission(client.id)).toEqual({ kind: 'none' })
    proceed.release()
    await granting
    expect(store.permission(client.id).kind).toBe('permanent')
  })

  it('bounds credentials to 32 and serializes concurrent creates', async () => {
    const { store, file } = await setup()
    await Promise.all(Array.from({ length: 32 }, () => store.create('same')))
    await expect(store.create('overflow')).rejects.toThrow()
    expect(store.list()).toHaveLength(32)
    const restarted = new implementation!.CredentialStore(file)
    await restarted.load()
    expect(restarted.list()).toHaveLength(32)
  })

  it('requires a real expected generation even for runtime callers outside TypeScript', async () => {
    const { store } = await setup()
    const client = await store.create('editor')
    for (const generation of [undefined, NaN, 0, -1]) {
      await expect(store.grant(client.id, generation as number, 'permanent')).rejects.toThrow()
    }
    expect(store.permission(client.id)).toEqual({ kind: 'none' })
    expect(store.isCurrent({ id: 'missing', name: '', generation: undefined as unknown as number })).toBe(false)
  })

  it('blocks reset immediately, invalidates synchronously, and activates the new token only after persistence', async () => {
    let pause = false
    const entered = latch(), proceed = latch()
    const { store, file } = await setup({ fs: { rename: async (from, to) => {
      if (pause) { entered.release(); await proceed.promise }
      return fs.rename(from, to)
    } } })
    const client = await store.create('editor')
    const token = store.tokenFor(client.id)
    await store.grant(client.id, client.generation, 'permanent')
    const invalidations: string[] = [], changes: boolean[] = []
    store.onInvalidated(id => invalidations.push(id))
    store.onChange(() => changes.push(store.isCurrent(client)))
    pause = true
    const resetting = store.reset(client.id)
    expect(invalidations).toEqual([client.id])
    expect(store.authenticate(token)).toBeUndefined()
    expect(store.isCurrent(client)).toBe(false)
    expect(store.hasUnpersistedRevocations).toBe(true)
    expect(() => store.tokenFor(client.id)).toThrow()
    await entered.promise
    expect(store.permission(client.id)).toEqual({ kind: 'none' })
    proceed.release()
    await resetting
    expect(store.hasUnpersistedRevocations).toBe(false)
    expect(changes).toContain(false)
    expect(store.tokenFor(client.id)).not.toBe(token)
    const newClient = store.authenticate(store.tokenFor(client.id))!
    expect(newClient.generation).toBeGreaterThan(client.generation)
    expect(store.permission(client.id)).toEqual({ kind: 'none' })
    await expect(store.grant(client.id, client.generation, 'permanent')).rejects.toThrow()
    const restarted = new implementation!.CredentialStore(file)
    await restarted.load()
    expect(restarted.authenticate(token)).toBeUndefined()
  })

  it('keeps failed revocation blocked through later rename/grant', async () => {
    let fail = false
    const { store, file } = await setup({ fs: { rename: async (from, to) => {
      if (fail) throw new Error('injected write failure')
      return fs.rename(from, to)
    } } })
    const a = await store.create('same'), b = await store.create('same')
    const token = store.tokenFor(a.id)
    await store.grant(a.id, a.generation, 'permanent')
    fail = true
    const revoking = store.revoke(a.id)
    expect(store.authenticate(token)).toBeUndefined()
    await expect(revoking).rejects.toThrow()
    expect(store.hasUnpersistedRevocations).toBe(true)
    await expect(store.rename(a.id, 'revive')).rejects.toThrow()
    await expect(store.grant(a.id, a.generation, 'permanent')).rejects.toThrow()
    expect(store.permission(a.id)).toEqual({ kind: 'none' })
    fail = false
    await store.rename(b.id, 'other')
    await store.grant(b.id, b.generation, 'permanent')
    expect(store.authenticate(token)).toBeUndefined()
    expect(store.hasUnpersistedRevocations).toBe(false)
    const restarted = new implementation!.CredentialStore(file)
    await restarted.load()
    expect(restarted.authenticate(token)).toBeUndefined()
    expect(store.isCurrent(b)).toBe(true)
  })

  it('keeps a failed reset denied across load/grant/rename and permits an explicit reset retry', async () => {
    let fail = false
    const { store, file } = await setup({ fs: { rename: async (from, to) => {
      if (fail) throw new Error('write failed')
      return fs.rename(from, to)
    } } })
    const client = await store.create('editor')
    const token = store.tokenFor(client.id)
    fail = true
    await expect(store.reset(client.id)).rejects.toThrow()
    await store.load()
    await expect(store.grant(client.id, client.generation, 'permanent')).rejects.toThrow()
    await expect(store.rename(client.id, 'revive')).rejects.toThrow()
    expect(store.authenticate(token)).toBeUndefined()
    expect(store.hasUnpersistedRevocations).toBe(true)
    fail = false
    await store.reset(client.id)
    expect(store.hasUnpersistedRevocations).toBe(false)
    expect(store.authenticate(token)).toBeUndefined()
    const replacement = store.tokenFor(client.id)
    const restarted = new implementation.CredentialStore(file)
    await restarted.load()
    expect(restarted.authenticate(replacement)?.id).toBe(client.id)
    expect(restarted.authenticate(token)).toBeUndefined()
  })

  it('a successful old grant cannot clear the barrier of a concurrent failed revoke', async () => {
    let block = false, fail = false
    const entered = latch(), proceed = latch()
    const { store } = await setup({ fs: { rename: async (from, to) => {
      if (block) { block = false; entered.release(); await proceed.promise; return fs.rename(from, to) }
      if (fail) throw new Error('write failed')
      return fs.rename(from, to)
    } } })
    const client = await store.create('editor')
    const token = store.tokenFor(client.id)
    block = true
    const granting = store.grant(client.id, client.generation, 'permanent')
    const caught = granting.catch(() => undefined)
    await entered.promise
    const revoking = store.revoke(client.id)
    const caughtRevoke = revoking.catch(() => undefined)
    fail = true
    proceed.release()
    await caught; await caughtRevoke
    await expect(granting).rejects.toThrow()
    await expect(revoking).rejects.toThrow()
    expect(store.authenticate(token)).toBeUndefined()
    expect(store.permission(client.id)).toEqual({ kind: 'none' })
    expect(store.hasUnpersistedRevocations).toBe(true)
  })

  it('never lets a pending earlier grant/rename or its failure override a newer revoke', async () => {
    let block = false, fail = false
    const entered = latch(), proceed = latch()
    const { store } = await setup({ fs: { rename: async (from, to) => {
      if (block) { block = false; entered.release(); await proceed.promise; if (fail) throw new Error('write failed') }
      return fs.rename(from, to)
    } } })
    const client = await store.create('editor'), other = await store.create('other')
    const token = store.tokenFor(client.id)
    block = true
    const granting = store.grant(client.id, client.generation, 'permanent')
    const caught = granting.catch(() => undefined)
    await entered.promise
    const renamed = store.rename(other.id, 'renamed')
    const revoked = store.revoke(client.id)
    expect(store.authenticate(token)).toBeUndefined()
    fail = true
    proceed.release()
    await caught
    await expect(granting).rejects.toThrow()
    await renamed
    await revoked
    expect(store.authenticate(token)).toBeUndefined()
    expect(store.isCurrent(client)).toBe(false)
    expect(store.hasUnpersistedRevocations).toBe(false)
  })

  it('a newer revoke wins over a pending successful reset without exposing its replacement token', async () => {
    let block = false
    const entered = latch(), proceed = latch()
    const { store, file } = await setup({ fs: { rename: async (from, to) => {
      if (block) { block = false; entered.release(); await proceed.promise }
      return fs.rename(from, to)
    } } })
    const client = await store.create('editor')
    const token = store.tokenFor(client.id)
    block = true
    const reset = store.reset(client.id)
    const caught = reset.catch(() => undefined)
    await entered.promise
    const revoke = store.revoke(client.id)
    proceed.release()
    await caught
    await expect(reset).rejects.toThrow()
    await revoke
    expect(store.authenticate(token)).toBeUndefined()
    expect(() => store.tokenFor(client.id)).toThrow()
    const restarted = new implementation!.CredentialStore(file)
    await restarted.load()
    expect(restarted.list()).toHaveLength(0)
  })

  it('publishes create/grant/rename only after flush and atomic replacement and reports write failure', async () => {
    let fail = false
    const { store, file } = await setup({ fs: { open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args)
      if (fail && args[1] !== 'r') handle.sync = async () => { throw new Error('flush failed') }
      return handle
    } } })
    const client = await store.create('editor')
    const before = await fs.readFile(file, 'utf8')
    fail = true
    await expect(store.create('failed')).rejects.toThrow()
    await expect(store.grant(client.id, client.generation, 'permanent')).rejects.toThrow()
    await expect(store.rename(client.id, 'failed')).rejects.toThrow()
    expect(store.list()).toEqual([client])
    expect(await fs.readFile(file, 'utf8')).toBe(before)
    expect(await fs.readdir(path.dirname(file))).toEqual(['credentials.json'])
    fail = false
    await store.reset(client.id)
    expect(store.isCurrent(client)).toBe(false)
    expect(store.hasUnpersistedRevocations).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('creates private modes and rejects unsafe modes without repairing evidence', async () => {
    const { store, file } = await setup()
    await store.create('editor')
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700)
    await fs.chmod(file, 0o644)
    const original = await fs.readFile(file, 'utf8')
    await expect(new implementation!.CredentialStore(file).load()).rejects.toThrow()
    await expect(store.create('unsafe')).rejects.toThrow()
    expect(await fs.readFile(file, 'utf8')).toBe(original)
    await fs.chmod(file, 0o600)
    await fs.chmod(path.dirname(file), 0o755)
    await expect(new implementation!.CredentialStore(file).load()).rejects.toThrow()
  })

  it('rejects file and parent symlinks without touching their targets', async () => {
    const { store, file, dir } = await setup()
    await store.create('editor')
    const target = path.join(dir, 'target.json')
    await fs.rename(file, target)
    await fs.symlink(target, file)
    const original = await fs.readFile(target, 'utf8')
    await expect(new implementation!.CredentialStore(file).load()).rejects.toThrow()
    await expect(store.create('unsafe')).rejects.toThrow()
    expect(await fs.readFile(target, 'utf8')).toBe(original)
    const link = path.join(dir, 'linked')
    await fs.symlink(path.dirname(file), link, 'dir')
    await expect(new implementation!.CredentialStore(path.join(link, 'other.json')).load()).rejects.toThrow()
  })

  it('rejects oversized or malformed strict schemas and preserves the bad file', async () => {
    const { store, file } = await setup()
    await store.create('editor')
    const valid = JSON.parse(await fs.readFile(file, 'utf8'))
    const bad: unknown[] = [
      null, {}, { ...valid, extra: true }, { ...valid, version: 3 },
      { ...valid, credentials: [...valid.credentials, ...valid.credentials] },
      { ...valid, credentials: [...valid.credentials, { ...valid.credentials[0], id: '00000000-0000-4000-8000-000000000001' }] },
      { ...valid, credentials: Array(33).fill(valid.credentials[0]) },
      { ...valid, credentials: [{ ...valid.credentials[0], generation: 0 }] },
      { ...valid, credentials: [{ ...valid.credentials[0], token: 'bad' }] },
      { ...valid, credentials: [{ ...valid.credentials[0], name: ' untrimmed ' }] },
      { ...valid, credentials: [{ ...valid.credentials[0], permission: { kind: 'permanent', approvedAt: 1, expiresAt: 2 } }] },
      { ...valid, credentials: [{ ...valid.credentials[0], permission: { kind: 'until', approvedAt: 2, expiresAt: 1 } }] },
    ]
    for (const value of bad) {
      const text = JSON.stringify(value)
      await fs.writeFile(file, text)
      await expect(new implementation!.CredentialStore(file).load()).rejects.toThrow()
      expect(await fs.readFile(file, 'utf8')).toBe(text)
    }
    for (const text of ['{broken', ' '.repeat(65_537)]) {
      await fs.writeFile(file, text)
      await expect(new implementation!.CredentialStore(file).load()).rejects.toThrow()
      expect(await fs.readFile(file, 'utf8')).toBe(text)
    }
  })

  it('uses exclusive temporary creation and leaves a preexisting symlink target untouched', async () => {
    let attack = false
    const targetDir = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'http-credentials-target-'))
    directories.push(targetDir)
    const target = path.join(targetDir, 'untouched')
    await fs.writeFile(target, 'sentinel', { mode: 0o600 })
    let planted: string | undefined
    const { store } = await setup({ fs: { open: async (...args: Parameters<typeof fs.open>) => {
      if (attack && String(args[0]).endsWith('.tmp')) {
        planted = String(args[0])
        await fs.symlink(target, planted)
      }
      return fs.open(...args)
    } } })
    attack = true
    await expect(store.create('blocked')).rejects.toThrow()
    expect(store.list()).toEqual([])
    expect(await fs.readFile(target, 'utf8')).toBe('sentinel')
    expect((await fs.lstat(planted!)).isSymbolicLink()).toBe(true)
  })

  it('notifies visible durable changes and supports listener removal without leaking mutable identity', async () => {
    const { store } = await setup()
    let changes = 0, invalidations = 0
    const off = store.onChange(() => { changes++ })
    const offInvalidated = store.onInvalidated(() => { invalidations++ })
    const client = await store.create('editor')
    expect(changes).toBeGreaterThan(0)
    const token = store.tokenFor(client.id)
    const identity = store.authenticate(token) as ClientIdentity
    identity.generation++
    expect(store.authenticate(token)?.generation).toBe(client.generation)
    await store.reset(client.id)
    expect(invalidations).toBe(1)
    off(); offInvalidated()
    const count = changes
    await store.revoke(client.id)
    expect(changes).toBe(count)
    expect(invalidations).toBe(1)
  })

  describe.skipIf(process.platform === 'win32')('durable pending commit boundary', () => {
    it.each([false, true])('rechecks pending and data identity when a writer fails during load (retried: %s)', async retry => {
      const { store, file, arm, stop } = await postRenameFailure('sync')
      const client = await store.create('editor')
      let intercept = true, pendingChecks = 0
      const restarted = new implementation.CredentialStore(file, { fs: { lstat: (async (...args: Parameters<typeof fs.lstat>) => {
        if (String(args[0]) === `${file}.pending` && ++pendingChecks === 2 && retry) {
          stop()
          await store.rename(client.id, 'retry')
        }
        if (String(args[0]) === file && intercept) {
          intercept = false
          arm()
          await expect(store.grant(client.id, client.generation, 'permanent')).rejects.toThrow()
        }
        return fs.lstat(...args)
      }) as typeof fs.lstat } })
      await expect(restarted.load()).rejects.toThrow()
      expect(restarted.permission(client.id)).toEqual({ kind: 'none' })
    })

    for (const duration of ['24h', 'permanent'] as const) {
      it.each(['open', 'sync', 'close'] as const)(`does not reload a rejected ${duration} grant after parent %s failure`, async phase => {
        const { store, file, arm, stop } = await postRenameFailure(phase)
        const client = await store.create('editor')
        const token = store.tokenFor(client.id)
        arm()
        await expect(store.grant(client.id, client.generation, duration)).rejects.toThrow()
        expect(store.permission(client.id)).toEqual({ kind: 'none' })
        // Prove this failure happens after data replacement, not at temporary-file sync.
        const replaced = JSON.parse(await fs.readFile(file, 'utf8'))
        expect(replaced.credentials[0].permission.kind).toBe(duration === '24h' ? 'until' : 'permanent')
        const restarted = new implementation.CredentialStore(file)
        await expect(restarted.load()).rejects.toThrow()
        expect(restarted.authenticate(token)).toBeUndefined()
        expect(restarted.permission(client.id)).toEqual({ kind: 'none' })
        const pending = `${file}.pending`
        const marker = await fs.lstat(pending)
        expect(marker.mode & 0o777).toBe(0o600)
        expect(await fs.readFile(pending, 'utf8')).toBe('')
        stop()
        // A different mutation must use committed memory, never the rejected disk permission.
        await store.rename(client.id, 'retry')
        expect(store.permission(client.id)).toEqual({ kind: 'none' })
        expect(store.tokenFor(client.id)).toBe(token)
        await restarted.load()
        expect(restarted.permission(client.id)).toEqual({ kind: 'none' })
        await expect(fs.lstat(pending)).rejects.toMatchObject({ code: 'ENOENT' })
        await store.grant(client.id, client.generation, duration)
        const committed = new implementation.CredentialStore(file)
        await committed.load()
        expect(committed.permission(client.id).kind).toBe(duration === '24h' ? 'until' : 'permanent')
      })
    }

    it.each(['create', 'reset'] as const)('does not reload the replacement token from a rejected %s', async operation => {
      const { store, file, arm, stop } = await postRenameFailure('sync')
      const a = await store.create('a'), b = await store.create('b')
      const old = store.tokenFor(a.id)
      arm()
      await expect(operation === 'create' ? store.create('new') : store.reset(a.id)).rejects.toThrow()
      const replaced = JSON.parse(await fs.readFile(file, 'utf8')).credentials
      const newRecord = replaced.find((record: { id: string }) => operation === 'create' ? record.id !== a.id && record.id !== b.id : record.id === a.id)
      expect(newRecord.token).not.toBe(old)
      expect(store.authenticate(newRecord.token)).toBeUndefined()
      await expect(new implementation.CredentialStore(file).load()).rejects.toThrow()
      stop()
      if (operation === 'reset') {
        expect(store.authenticate(old)).toBeUndefined()
        expect(store.hasUnpersistedRevocations).toBe(true)
        await store.reset(a.id)
        expect(store.tokenFor(a.id)).not.toBe(newRecord.token)
        expect(store.hasUnpersistedRevocations).toBe(false)
      } else await store.rename(b.id, 'retry')
      const restarted = new implementation.CredentialStore(file)
      await restarted.load()
      expect(restarted.authenticate(newRecord.token)).toBeUndefined()
      expect(restarted.isCurrent(b)).toBe(true)
      expect(restarted.list()).toHaveLength(2)
    })

    it('refuses a replaced owned marker on retry and preserves both marker identities', async () => {
      const { store, file, arm, stop } = await postRenameFailure('sync')
      const client = await store.create('editor')
      arm()
      await expect(store.grant(client.id, client.generation, 'permanent')).rejects.toThrow()
      const pending = `${file}.pending`, retained = `${file}.retained-pending`
      await fs.rename(pending, retained)
      await fs.writeFile(pending, '', { mode: 0o600 })
      const replacement = await fs.lstat(pending)
      const data = await fs.readFile(file, 'utf8')
      stop()
      await expect(store.rename(client.id, 'retry')).rejects.toThrow()
      expect((await fs.lstat(pending)).ino).toBe(replacement.ino)
      expect((await fs.lstat(retained)).ino).not.toBe(replacement.ino)
      expect(await fs.readFile(file, 'utf8')).toBe(data)
      expect(store.permission(client.id)).toEqual({ kind: 'none' })
      await expect(new implementation.CredentialStore(file).load()).rejects.toThrow()
    })

    it('keeps newer revocation denied when post-rename sync and the subsequent revoke both fail', async () => {
      let armed = false, renamed = false, parent = ''
      const entered = latch(), proceed = latch()
      let first = true
      const { store, file } = await setup({ fs: {
        rename: async (from, to) => { await fs.rename(from, to); if (armed) renamed = true },
        open: async (...args: Parameters<typeof fs.open>) => {
          const handle = await fs.open(...args)
          if (armed && renamed && String(args[0]) === parent) handle.sync = async () => {
            if (first) { first = false; entered.release(); await proceed.promise }
            throw new Error('directory sync failed')
          }
          return handle
        },
      } })
      parent = path.dirname(file)
      const client = await store.create('editor'), token = store.tokenFor(client.id)
      armed = true
      const grant = store.grant(client.id, client.generation, 'permanent')
      const caughtGrant = grant.catch(() => undefined)
      await entered.promise
      const revoke = store.revoke(client.id), caughtRevoke = revoke.catch(() => undefined)
      expect(store.authenticate(token)).toBeUndefined()
      proceed.release()
      await caughtGrant; await caughtRevoke
      await expect(grant).rejects.toThrow()
      await expect(revoke).rejects.toThrow()
      expect(store.permission(client.id)).toEqual({ kind: 'none' })
      expect(store.hasUnpersistedRevocations).toBe(true)
      await expect(new implementation.CredentialStore(file).load()).rejects.toThrow()
      armed = false
      await store.revoke(client.id)
      expect(store.hasUnpersistedRevocations).toBe(false)
      const restarted = new implementation.CredentialStore(file)
      await restarted.load()
      expect(restarted.authenticate(token)).toBeUndefined()
      expect(restarted.list()).toEqual([])
    })

    it.each(['marker-open', 'marker-sync', 'marker-close', 'marker-parent-sync', 'data-rename'] as const)('denies failed grants and supports retry after %s failure', async phase => {
      let armed = false, parent = ''
      const { store, file } = await setup({ fs: {
        rename: async (from, to) => {
          if (armed && phase === 'data-rename') throw new Error('data rename failed')
          return fs.rename(from, to)
        },
        open: async (...args: Parameters<typeof fs.open>) => {
          const marker = String(args[0]).endsWith('.pending')
          if (armed && marker && phase === 'marker-open') throw new Error('marker open failed')
          const handle = await fs.open(...args)
          if (armed && ((marker && phase === 'marker-sync') || (String(args[0]) === parent && phase === 'marker-parent-sync'))) {
            handle.sync = async () => { throw new Error('prepare sync failed') }
          }
          if (armed && marker && phase === 'marker-close') {
            const close = handle.close.bind(handle)
            handle.close = async () => { await close(); throw new Error('marker close failed') }
          }
          return handle
        },
      } })
      parent = path.dirname(file)
      const client = await store.create('editor')
      const before = await fs.readFile(file, 'utf8')
      armed = true
      await expect(store.grant(client.id, client.generation, 'permanent')).rejects.toThrow()
      expect(store.permission(client.id)).toEqual({ kind: 'none' })
      expect(await fs.readFile(file, 'utf8')).toBe(before)
      const restarted = new implementation.CredentialStore(file)
      if (phase === 'marker-open') {
        await restarted.load()
        expect(restarted.permission(client.id)).toEqual({ kind: 'none' })
      } else await expect(restarted.load()).rejects.toThrow()
      armed = false
      await store.rename(client.id, 'retry')
      const committed = new implementation.CredentialStore(file)
      await committed.load()
      expect(committed.permission(client.id)).toEqual({ kind: 'none' })
    })

    it('retries initial-load persistence from empty committed memory when its own marker remains', async () => {
      const dir = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'http-credentials-startup-'))
      directories.push(dir)
      const file = path.join(dir, 'private', 'credentials.json')
      let fail = true, replaced = false
      const store = new implementation.CredentialStore(file, { fs: {
        rename: async (from, to) => { await fs.rename(from, to); replaced = true },
        open: async (...args: Parameters<typeof fs.open>) => {
          const handle = await fs.open(...args)
          if (fail && replaced && String(args[0]) === path.dirname(file)) handle.sync = async () => { throw new Error('startup sync failed') }
          return handle
        },
      } })
      await expect(store.load()).rejects.toThrow()
      await expect(new implementation.CredentialStore(file).load()).rejects.toThrow()
      expect(store.list()).toEqual([])
      fail = false
      await store.load()
      const client = await store.create('editor')
      const restarted = new implementation.CredentialStore(file)
      await restarted.load()
      expect(restarted.isCurrent(client)).toBe(true)
    })

    it('has no fallible filesystem work after final marker removal', async () => {
      let armed = false, released = false
      const assertNotReleased = () => { if (released) throw new Error('operation after commit') }
      const { store, file } = await setup({ fs: {
        open: async (...args: Parameters<typeof fs.open>) => {
          assertNotReleased()
          const handle = await fs.open(...args)
          const sync = handle.sync.bind(handle), close = handle.close.bind(handle)
          handle.sync = async () => { assertNotReleased(); return sync() }
          handle.close = async () => { assertNotReleased(); return close() }
          return handle
        },
        lstat: (async (...args: Parameters<typeof fs.lstat>) => { assertNotReleased(); return fs.lstat(...args) }) as typeof fs.lstat,
        unlink: async target => {
          assertNotReleased()
          await fs.unlink(target)
          if (armed && String(target).endsWith('.pending')) released = true
        },
      } })
      const client = await store.create('editor')
      armed = true
      await store.grant(client.id, client.generation, 'permanent')
      expect(released).toBe(true)
      const restarted = new implementation.CredentialStore(file)
      await restarted.load()
      expect(restarted.permission(client.id).kind).toBe('permanent')
    })
  })

  it('refuses a foreign pending marker without deleting evidence or reclaiming it in the loaded instance', async () => {
    const { store, file } = await setup()
    const client = await store.create('editor')
    const pending = `${file}.pending`
    await fs.writeFile(pending, '', { mode: 0o600 })
    const stat = await fs.lstat(pending), before = await fs.readFile(file, 'utf8')
    await expect(new implementation.CredentialStore(file).load()).rejects.toThrow()
    await expect(store.grant(client.id, client.generation, 'permanent')).rejects.toThrow()
    expect((await fs.lstat(pending)).ino).toBe(stat.ino)
    expect(await fs.readFile(file, 'utf8')).toBe(before)
  })

  it('retains pending evidence on final unlink failure and can retry from committed memory', async () => {
    let fail = false
    const { store, file } = await setup({ fs: { unlink: async target => {
      if (fail && String(target).endsWith('.pending')) throw new Error('marker unlink failed')
      return fs.unlink(target)
    } } })
    const client = await store.create('editor')
    fail = true
    await expect(store.grant(client.id, client.generation, 'permanent')).rejects.toThrow()
    expect(store.permission(client.id)).toEqual({ kind: 'none' })
    await expect(new implementation.CredentialStore(file).load()).rejects.toThrow()
    fail = false
    await store.rename(client.id, 'retry')
    const restarted = new implementation.CredentialStore(file)
    await restarted.load()
    expect(restarted.permission(client.id)).toEqual({ kind: 'none' })
  })

  describe('committed baseline compare-and-swap', () => {
    for (const change of ['revoke', 'reset', 'reset-and-grant', 'grant'] as const) {
      it.each(['create', 'rename', 'grant'] as const)(`refuses stale %s after another Store commits ${change}`, async mutation => {
        const { store: a, file } = await setup()
        const client = await a.create('client'), neighbor = await a.create('neighbor')
        if (change !== 'grant') await a.grant(client.id, client.generation, 'permanent')
        const oldToken = a.tokenFor(client.id)
        const b = new implementation.CredentialStore(file)
        await b.load()
        const invalidated: string[] = []
        b.onInvalidated(id => invalidated.push(id))
        if (change === 'revoke') await a.revoke(client.id)
        else if (change === 'grant') await a.grant(client.id, client.generation, 'permanent')
        else {
          await a.reset(client.id)
          if (change === 'reset-and-grant') await a.grant(client.id, client.generation + 1, 'permanent')
        }
        const before = await fs.readFile(file, 'utf8')
        if (change === 'revoke') {
          const check = new implementation.CredentialStore(file)
          await check.load()
          expect(check.authenticate(oldToken)).toBeUndefined()
        }
        await expect(mutation === 'create' ? b.create('unrelated')
          : mutation === 'rename' ? b.rename(neighbor.id, 'unrelated')
            : b.grant(neighbor.id, neighbor.generation, 'permanent')).rejects.toThrow()
        expect(await fs.readFile(file, 'utf8')).toBe(before)
        expect(b.authenticate(oldToken)).toBeUndefined()
        expect(b.isCurrent(client)).toBe(false)
        expect(b.permission(client.id)).toEqual({ kind: 'none' })
        expect(invalidated).toContain(client.id)
        await expect(b.load()).rejects.toThrow()
        await expect(fs.lstat(`${file}.pending`)).rejects.toMatchObject({ code: 'ENOENT' })
        const fresh = new implementation.CredentialStore(file)
        await fresh.load()
        if (change === 'grant') {
          expect(fresh.authenticate(oldToken)?.generation).toBe(client.generation)
          expect(fresh.permission(client.id).kind).toBe('permanent')
        } else {
          expect(fresh.authenticate(oldToken)).toBeUndefined()
          if (change !== 'revoke') {
            expect(fresh.authenticate(a.tokenFor(client.id))?.generation).toBe(client.generation + 1)
            expect(fresh.permission(client.id).kind).toBe(change === 'reset' ? 'none' : 'permanent')
          }
        }
        // Rejecting the stale writer must not strand a marker that blocks the current writer.
        await a.create('current writer still works')
      })
    }

    it('does not lose a newly created credential when another initially empty Store creates later', async () => {
      const { store: a, file } = await setup()
      const b = new implementation.CredentialStore(file)
      await b.load()
      const client = await a.create('winner'), token = a.tokenFor(client.id)
      await expect(b.create('stale')).rejects.toThrow()
      const fresh = new implementation.CredentialStore(file)
      await fresh.load()
      expect(fresh.list()).toEqual([client])
      expect(fresh.authenticate(token)?.id).toBe(client.id)
    })

    it.each(['revoke', 'reset'] as const)('cannot grant the old generation after another Store commits %s', async change => {
      const { store: a, file } = await setup()
      const client = await a.create('client'), token = a.tokenFor(client.id)
      const b = new implementation.CredentialStore(file)
      await b.load()
      if (change === 'revoke') await a.revoke(client.id)
      else await a.reset(client.id)
      await expect(b.grant(client.id, client.generation, 'permanent')).rejects.toThrow()
      const fresh = new implementation.CredentialStore(file)
      await fresh.load()
      expect(fresh.authenticate(token)).toBeUndefined()
      expect(fresh.permission(client.id)).toEqual({ kind: 'none' })
    })

    it('checks again after acquiring pending when another Store commits between check and lock', async () => {
      const { store: a, file } = await setup()
      const client = await a.create('client')
      await a.grant(client.id, client.generation, 'permanent')
      const token = a.tokenFor(client.id)
      let intercept = true
      const b = new implementation.CredentialStore(file, { fs: { open: async (...args: Parameters<typeof fs.open>) => {
        if (intercept && String(args[0]) === `${file}.pending`) {
          intercept = false
          await a.revoke(client.id)
        }
        return fs.open(...args)
      } } })
      await b.load()
      await expect(b.create('stale')).rejects.toThrow()
      expect(intercept).toBe(false)
      expect(b.authenticate(token)).toBeUndefined()
      await expect(fs.lstat(`${file}.pending`)).rejects.toMatchObject({ code: 'ENOENT' })
      const fresh = new implementation.CredentialStore(file)
      await fresh.load()
      expect(fresh.authenticate(token)).toBeUndefined()
      expect(fresh.list()).toEqual([])
      await a.create('current writer still works')
    })

    it('retains its marker and committed denial if stale-marker release fails', async () => {
      const { store: a, file } = await setup()
      const client = await a.create('client')
      await a.grant(client.id, client.generation, 'permanent')
      const token = a.tokenFor(client.id)
      const b = new implementation.CredentialStore(file, { fs: { unlink: async target => {
        if (String(target) === `${file}.pending`) throw new Error('release failed')
        return fs.unlink(target)
      } } })
      await b.load()
      await a.revoke(client.id)
      const before = await fs.readFile(file, 'utf8')
      await expect(b.create('stale')).rejects.toThrow()
      expect(b.authenticate(token)).toBeUndefined()
      expect(await fs.readFile(file, 'utf8')).toBe(before)
      expect(await fs.readFile(`${file}.pending`, 'utf8')).toBe('')
      await expect(new implementation.CredentialStore(file).load()).rejects.toThrow()
    })

    it('does not delete a foreign marker substituted before stale-marker release', async () => {
      const { store: a, file } = await setup()
      const client = await a.create('client')
      await a.grant(client.id, client.generation, 'permanent')
      const token = a.tokenFor(client.id), marker = `${file}.pending`, retained = `${file}.retained-marker`
      let intercept = true, owned = false, checkedData = false, substituted = false, committed = ''
      const b = new implementation.CredentialStore(file, { fs: {
        open: async (...args: Parameters<typeof fs.open>) => {
          if (intercept && String(args[0]) === marker) {
            intercept = false
            await a.revoke(client.id)
            committed = await fs.readFile(file, 'utf8')
            const handle = await fs.open(...args)
            owned = true
            return handle
          }
          return fs.open(...args)
        },
        lstat: (async (...args: Parameters<typeof fs.lstat>) => {
          if (owned && String(args[0]) === file) checkedData = true
          if (checkedData && String(args[0]) === marker && !substituted) {
            substituted = true
            await fs.rename(marker, retained)
            await fs.writeFile(marker, '', { mode: 0o600 })
          }
          return fs.lstat(...args)
        }) as typeof fs.lstat,
      } })
      await b.load()
      await expect(b.create('stale')).rejects.toThrow()
      expect(substituted).toBe(true)
      expect((await fs.lstat(marker)).ino).not.toBe((await fs.lstat(retained)).ino)
      expect(await fs.readFile(file, 'utf8')).toBe(committed)
      expect(b.authenticate(token)).toBeUndefined()
      await expect(new implementation.CredentialStore(file).load()).rejects.toThrow()
    })

    it.skipIf(process.platform === 'win32')('retries an owned failed replacement even after a later rename fails before replacement', async () => {
      let phase = 'ok', replaced = false, parent = ''
      const { store, file } = await setup({ fs: {
        rename: async (from, to) => {
          if (phase === 'rename') throw new Error('rename failed before replacement')
          await fs.rename(from, to)
          if (phase === 'parent') replaced = true
        },
        open: async (...args: Parameters<typeof fs.open>) => {
          const handle = await fs.open(...args)
          if (phase === 'parent' && replaced && String(args[0]) === parent) handle.sync = async () => { throw new Error('post-rename sync failed') }
          return handle
        },
      } })
      parent = path.dirname(file)
      const client = await store.create('client'), token = store.tokenFor(client.id)
      phase = 'parent'
      await expect(store.grant(client.id, client.generation, 'permanent')).rejects.toThrow()
      phase = 'rename'
      await expect(store.rename(client.id, 'uncommitted name')).rejects.toThrow()
      expect(store.permission(client.id)).toEqual({ kind: 'none' })
      await expect(new implementation.CredentialStore(file).load()).rejects.toThrow()
      phase = 'ok'
      await store.create('retry')
      const fresh = new implementation.CredentialStore(file)
      await fresh.load()
      expect(fresh.authenticate(token)?.name).toBe('client')
      expect(fresh.permission(client.id)).toEqual({ kind: 'none' })
      expect(fresh.list()).toHaveLength(2)
    })

    it.skipIf(process.platform === 'win32')('clears owned retry versions after commit instead of accepting them as future baselines', async () => {
      const { store, file, arm, stop } = await postRenameFailure('sync')
      const client = await store.create('client')
      arm()
      await expect(store.grant(client.id, client.generation, 'permanent')).rejects.toThrow()
      // Reuse the exact failed candidate later as a legitimate commit by another Store.
      const failed = JSON.parse(await fs.readFile(file, 'utf8'))
      stop()
      await store.rename(client.id, 'client')
      const a = new implementation.CredentialStore(file, { now: () => failed.credentials[0].permission.approvedAt })
      await a.load()
      await a.grant(client.id, client.generation, 'permanent')
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(failed)
      await expect(store.create('stale')).rejects.toThrow()
      const fresh = new implementation.CredentialStore(file)
      await fresh.load()
      expect(fresh.list()).toHaveLength(1)
      expect(fresh.permission(client.id).kind).toBe('permanent')
    })
  })
})
