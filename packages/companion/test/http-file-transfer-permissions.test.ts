import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CredentialStore, type CredentialFileSystem } from '../src/http/credentials.js'

const directories: string[] = []
const digest = 'a'.repeat(64), otherDigest = 'b'.repeat(64)
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))) })
async function setup(overrides: Partial<CredentialFileSystem> = {}) {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'file-permissions-'))
  directories.push(dir)
  const file = path.join(dir, 'private', 'credentials.json')
  const store = new CredentialStore(file, { fs: overrides })
  await store.load()
  return { store, file }
}

describe('file transfer permissions', () => {
  it('defaults off and persists only the explicitly selected client, profile and digest', async () => {
    const { store, file } = await setup()
    const a = await store.create('Agent'), b = await store.create('Agent')
    expect(store.hasFileTransferPermission(a, 'ssh', digest)).toBe(false)
    await store.setFileTransferPermission(a, 'ssh', digest, store.fileTransferRevision())
    expect(store.hasFileTransferPermission(a, 'ssh', digest)).toBe(true)
    expect(store.hasFileTransferPermission(b, 'ssh', digest)).toBe(false)
    expect(store.hasFileTransferPermission(a, 'other', digest)).toBe(false)
    expect(store.hasFileTransferPermission(a, 'ssh', otherDigest)).toBe(false)
    const restarted = new CredentialStore(file)
    await restarted.load()
    expect(restarted.hasFileTransferPermission(a, 'ssh', digest)).toBe(true)
    expect(JSON.parse(await fs.readFile(file, 'utf8')).version).toBe(4)
  })

  it('publishes grants only after durable commit and captures queued identities', async () => {
    let armed = false, entered!: () => void, release!: () => void
    const staged = new Promise<void>(resolve => { entered = resolve })
    const proceed = new Promise<void>(resolve => { release = resolve })
    const { store } = await setup({ rename: async (from, to) => {
      if (armed) { armed = false; entered(); await proceed }
      await fs.rename(from, to)
    } })
    const client = await store.create('Agent'), input = { ...client }
    const revision = store.fileTransferRevision()
    armed = true
    const saving = store.setFileTransferPermission(input, 'ssh', digest, revision)
    input.id = 'different-client'
    expect(store.fileTransferRevision()).toBeGreaterThan(revision)
    await staged
    expect(store.hasFileTransferPermission(client, 'ssh', digest)).toBe(false)
    release()
    await saving
    expect(store.hasFileTransferPermission(client, 'ssh', digest)).toBe(true)
    const current = store.fileTransferRevision()
    await expect(store.setFileTransferPermission(client, 'ssh', null, revision)).rejects.toThrow()
    expect(store.fileTransferRevision()).toBe(current)
    expect(store.hasFileTransferPermission(client, 'ssh', digest)).toBe(true)
  })

  it.each(['initial', 'same-digest'] as const)('preserves the captured file revision during %s connection approval', async approval => {
    const { store, file } = await setup()
    const client = await store.create('Agent')
    if (approval === 'same-digest') await store.setConnectionPermission(client, 'ssh', digest)
    await store.setFileTransferPermission(client, 'ssh', digest, store.fileTransferRevision())
    const revision = store.fileTransferRevision()
    const current = () => store.isCurrent(client) && store.fileTransferRevision() === revision
    const saving = store.setConnectionPermission(client, 'ssh', digest, store.connectionRevision(client), current)
    expect(current()).toBe(true)
    await saving
    expect(current()).toBe(true)
    expect(store.hasConnectionPermission(client, 'ssh', digest)).toBe(true)
    expect(store.hasFileTransferPermission(client, 'ssh', digest)).toBe(true)
    const restarted = new CredentialStore(file)
    await restarted.load()
    expect(restarted.hasFileTransferPermission(client, 'ssh', digest)).toBe(true)
  })

  it.each(['session', '24h', 'permanent', 'none'] as const)('preserves file choices on ordinary %s pairing updates', async duration => {
    const { store, file } = await setup()
    const client = await store.create('Agent')
    await store.setFileTransferPermission(client, 'ssh', digest, store.fileTransferRevision())
    const before = store.fileTransferRevision()
    const saving = store.setPermission(client.id, client.generation, duration)
    expect(store.hasFileTransferPermission(client, 'ssh', digest)).toBe(false)
    expect(store.fileTransferRevision()).toBeGreaterThan(before)
    await saving
    const current = store.list()[0]!
    expect(store.hasFileTransferPermission(current, 'ssh', digest)).toBe(true)
    const restarted = new CredentialStore(file)
    await restarted.load()
    expect(restarted.hasFileTransferPermission(current, 'ssh', digest)).toBe(true)
  })

  it('preserves file choices through a failed pairing update and unrelated save', async () => {
    let fail = false
    const { store, file } = await setup({ rename: async (from, to) => {
      if (fail) throw new Error('disk full')
      await fs.rename(from, to)
    } })
    const client = await store.create('Agent')
    await store.setFileTransferPermission(client, 'ssh', digest, store.fileTransferRevision())
    fail = true
    await expect(store.setPermission(client.id, client.generation, 'none')).rejects.toThrow()
    expect(store.hasFileTransferPermission(client, 'ssh', digest)).toBe(false)
    fail = false
    await store.create('Unrelated')
    const restarted = new CredentialStore(file)
    await restarted.load()
    expect(restarted.permission(client.id)).toEqual({ kind: 'none' })
    expect(restarted.hasFileTransferPermission(client, 'ssh', digest)).toBe(true)
  })

  it.each(['revoke', 'digest', 'unbound-digest'] as const)('invalidates file grants immediately on connection %s changes', async change => {
    const { store, file } = await setup()
    const client = await store.create('Agent')
    if (change !== 'unbound-digest') await store.setConnectionPermission(client, 'ssh', digest)
    await store.setFileTransferPermission(client, 'ssh', digest, store.fileTransferRevision())
    const before = store.fileTransferRevision()
    const saving = store.setConnectionPermission(client, 'ssh', change === 'revoke' ? null : otherDigest)
    expect(store.hasFileTransferPermission(client, 'ssh', digest)).toBe(false)
    expect(store.fileTransferRevision()).toBeGreaterThan(before)
    await saving
    const restarted = new CredentialStore(file)
    await restarted.load()
    expect(restarted.hasFileTransferPermission(client, 'ssh', digest)).toBe(false)
    expect(restarted.hasFileTransferPermission(client, 'ssh', otherDigest)).toBe(false)
    expect(JSON.parse(await fs.readFile(file, 'utf8')).credentials[0].fileTransfers).toEqual([])
  })

  it.each(['file', 'connection'] as const)('keeps failed %s revocations denied through unrelated saves', async target => {
    let fail = false
    const { store, file } = await setup({ rename: async (from, to) => {
      if (fail) throw new Error('disk full')
      await fs.rename(from, to)
    } })
    const client = await store.create('Agent')
    await store.setConnectionPermission(client, 'ssh', digest)
    await store.setFileTransferPermission(client, 'ssh', digest, store.fileTransferRevision())
    fail = true
    const saving = target === 'file' ? store.setFileTransferPermission(client, 'ssh', null, store.fileTransferRevision())
      : store.setConnectionPermission(client, 'ssh', null)
    expect(store.hasFileTransferPermission(client, 'ssh', digest)).toBe(false)
    await expect(saving).rejects.toThrow()
    expect(store.hasUnpersistedRevocations).toBe(true)
    await expect(new CredentialStore(file).load()).rejects.toThrow()
    fail = false
    await store.rename(client.id, 'Unrelated')
    const restarted = new CredentialStore(file)
    await restarted.load()
    expect(restarted.hasFileTransferPermission(client, 'ssh', digest)).toBe(false)
  })

  it('never activates a failed addition on unrelated saves', async () => {
    let armed = false
    const { store, file } = await setup({ rename: async (from, to) => {
      await fs.rename(from, to)
      if (armed) throw new Error('replacement acknowledgement failed')
    } })
    const client = await store.create('Agent')
    armed = true
    await expect(store.setFileTransferPermission(client, 'ssh', digest, store.fileTransferRevision())).rejects.toThrow()
    expect(store.hasFileTransferPermission(client, 'ssh', digest)).toBe(false)
    await expect(new CredentialStore(file).load()).rejects.toThrow()
    armed = false
    await store.rename(client.id, 'Unrelated')
    const restarted = new CredentialStore(file)
    await restarted.load()
    expect(restarted.hasFileTransferPermission(client, 'ssh', digest)).toBe(false)
  })

  it.each(['before-queue', 'rename', 'commit-check'] as const)('guards request invalidation at %s', async phase => {
    let armed = false, current = true
    const { store, file } = await setup({
      rename: async (from, to) => { await fs.rename(from, to); if (armed && phase === 'rename') current = false },
      lstat: (async (...args: Parameters<typeof fs.lstat>) => {
        const stat = await fs.lstat(...args)
        if (armed && phase === 'commit-check' && String(args[0]).endsWith('.pending')) {
          const data = JSON.parse(await fs.readFile(String(args[0]).slice(0, -8), 'utf8'))
          if (data.credentials[0].fileTransfers.length) current = false
        }
        return stat
      }) as typeof fs.lstat,
    })
    const client = await store.create('Agent')
    armed = true
    const saving = store.setFileTransferPermission(client, 'ssh', digest, store.fileTransferRevision(), () => current)
    if (phase === 'before-queue') current = false
    await expect(saving).rejects.toThrow()
    expect(store.hasFileTransferPermission(client, 'ssh', digest)).toBe(false)
    if (phase !== 'before-queue') await expect(new CredentialStore(file).load()).rejects.toThrow()
    armed = false
    await store.rename(client.id, 'Unrelated')
    const restarted = new CredentialStore(file)
    await restarted.load()
    expect(restarted.hasFileTransferPermission(client, 'ssh', digest)).toBe(false)
  })

  it.each(['file-revoke', 'connection-revoke', 'connection-refresh', 'pairing-update', 'reset', 'revoke'] as const)('does not resurrect an addition racing with %s', async mutation => {
    let armed = false, entered!: () => void, release!: () => void
    const staged = new Promise<void>(resolve => { entered = resolve })
    const proceed = new Promise<void>(resolve => { release = resolve })
    const { store, file } = await setup({ rename: async (from, to) => {
      if (armed) { armed = false; entered(); await proceed }
      await fs.rename(from, to)
    } })
    const client = await store.create('Agent')
    await store.setConnectionPermission(client, 'ssh', digest)
    armed = true
    const saving = store.setFileTransferPermission(client, 'ssh', digest, store.fileTransferRevision())
    const rejected = expect(saving).rejects.toThrow()
    await staged
    const changing = mutation === 'file-revoke' ? store.setFileTransferPermission(client, 'ssh', null, store.fileTransferRevision())
      : mutation === 'connection-revoke' ? store.setConnectionPermission(client, 'ssh', null)
      : mutation === 'connection-refresh' ? store.setConnectionPermission(client, 'ssh', digest)
      : mutation === 'pairing-update' ? store.setPermission(client.id, client.generation, 'permanent') : store[mutation](client.id)
    expect(store.hasFileTransferPermission(client, 'ssh', digest)).toBe(false)
    release()
    await rejected
    await changing
    const restarted = new CredentialStore(file)
    await restarted.load()
    const identity = mutation === 'reset' || mutation === 'pairing-update' ? { ...client, generation: client.generation + 1 } : client
    expect(restarted.hasFileTransferPermission(identity, 'ssh', digest)).toBe(false)
  })

  it.each(['reset', 'revoke'] as const)('clears committed file grants on client %s', async operation => {
    const { store, file } = await setup()
    const client = await store.create('Agent')
    await store.setFileTransferPermission(client, 'ssh', digest, store.fileTransferRevision())
    const changing = store[operation](client.id)
    expect(store.hasFileTransferPermission(client, 'ssh', digest)).toBe(false)
    await changing
    const restarted = new CredentialStore(file)
    await restarted.load()
    const current = operation === 'reset' ? { ...client, generation: client.generation + 1 } : client
    expect(restarted.hasFileTransferPermission(current, 'ssh', digest)).toBe(false)
    if (operation === 'reset') expect(JSON.parse(await fs.readFile(file, 'utf8')).credentials[0].fileTransfers).toEqual([])
  })

  it.each([1, 2, 3])('loads v%s with file transfers off and upgrades without losing existing choices', async version => {
    const { store, file } = await setup()
    const client = await store.create('Agent'), token = store.tokenFor(client.id)
    const rule = { kind: 'family' as const, version: 1 as const, argv: ['pwd'] }
    await store.setDefaultCommandSet([rule], store.commandRevision())
    await store.setCommandSet(client, 'ssh', digest, { inheritDefaults: false, rules: [rule] }, store.commandRevision())
    const data = JSON.parse(await fs.readFile(file, 'utf8'))
    data.version = version
    for (const record of data.credentials) {
      delete record.fileTransfers
      if (version < 3) delete record.commandSets
      if (version === 1) delete record.connections
    }
    if (version < 3) delete data.defaultCommands
    await fs.writeFile(file, JSON.stringify(data))
    const migrated = new CredentialStore(file)
    await migrated.load()
    expect(migrated.hasFileTransferPermission(client, 'ssh', digest)).toBe(false)
    await migrated.setFileTransferPermission(client, 'ssh', digest, migrated.fileTransferRevision())
    expect(migrated.tokenFor(client.id)).toBe(token)
    if (version === 3) {
      expect(migrated.defaultCommandSet().rules).toEqual([rule])
      expect(migrated.commandSet(client, 'ssh', digest)).toMatchObject({ rules: [rule], inheritDefaults: false })
    }
    expect(JSON.parse(await fs.readFile(file, 'utf8')).version).toBe(4)
  })

  it('rejects malformed v4 file grants and unknown keys', async () => {
    const { store, file } = await setup()
    await store.create('Agent')
    const valid = JSON.parse(await fs.readFile(file, 'utf8'))
    const grant = { profileId: 'ssh', profileDigest: digest, updatedAt: 1 }
    for (const fileTransfers of [null, {}, [grant, grant], [{ ...grant, profileDigest: 'bad' }], [{ ...grant, updatedAt: -1 }], [{ ...grant, extra: true }]]) {
      const data = structuredClone(valid)
      data.credentials[0].fileTransfers = fileTransfers
      await fs.writeFile(file, JSON.stringify(data))
      await expect(new CredentialStore(file).load()).rejects.toThrow()
    }
    for (const scope of ['file', 'credential', 'missing'] as const) {
      const data = structuredClone(valid)
      if (scope === 'file') data.extra = true
      else if (scope === 'credential') data.credentials[0].extra = true
      else delete data.credentials[0].fileTransfers
      await fs.writeFile(file, JSON.stringify(data))
      await expect(new CredentialStore(file).load()).rejects.toThrow()
    }
  })

  it('rejects invalid inputs without changing the revision or existing grant', async () => {
    const { store } = await setup()
    const client = await store.create('Agent')
    await store.setFileTransferPermission(client, 'ssh', digest, store.fileTransferRevision())
    const revision = store.fileTransferRevision()
    for (const [profile, hash] of [['', digest], ['ssh', 'bad'], ['x\n', digest], ['x'.repeat(1025), digest]]) {
      await expect(store.setFileTransferPermission(client, profile, hash, revision)).rejects.toThrow()
    }
    await expect(store.setFileTransferPermission(client, 'ssh', null, revision, () => false)).rejects.toThrow()
    expect(store.fileTransferRevision()).toBe(revision)
    expect(store.hasFileTransferPermission(client, 'ssh', digest)).toBe(true)
  })

  it('enforces the combined 64 KiB file limit before accepting an addition', async () => {
    const { store, file } = await setup()
    const client = await store.create('Agent')
    let rejected = false
    for (let index = 0; index < 80; index++) {
      const profile = 'p'.repeat(1000) + index
      const revision = store.fileTransferRevision()
      const before = await fs.readFile(file, 'utf8')
      try { await store.setFileTransferPermission(client, profile, digest, revision) }
      catch {
        rejected = true
        expect(store.fileTransferRevision()).toBe(revision)
        expect(store.hasFileTransferPermission(client, profile, digest)).toBe(false)
        expect(await fs.readFile(file, 'utf8')).toBe(before)
        break
      }
    }
    expect(rejected).toBe(true)
    expect((await fs.stat(file)).size).toBeLessThanOrEqual(64 * 1024)
  })
})
