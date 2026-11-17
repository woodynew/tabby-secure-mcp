import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CredentialStore, type CredentialFileSystem } from '../src/http/credentials.js'

const directories: string[] = []
const digest = 'a'.repeat(64), otherDigest = 'b'.repeat(64)
const rule = { kind: 'family' as const, version: 1 as const, argv: ['uci', 'get'] }
const otherRule = { kind: 'family' as const, version: 1 as const, argv: ['nft', 'list', 'table'] }
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))) })
async function setup(overrides: Partial<CredentialFileSystem> = {}) {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'command-credentials-'))
  directories.push(dir)
  const file = path.join(dir, 'private', 'credentials.json')
  const store = new CredentialStore(file, { fs: overrides })
  await store.load()
  return { store, file }
}

describe('command credentials', () => {
  it.each(['session', '24h', 'permanent', 'none'] as const)('preserves local command rules and default opt-out when pairing changes to %s', async duration => {
    const { store, file } = await setup()
    const client = await store.create('Agent'), token = store.tokenFor(client.id)
    await store.setConnectionPermission(client, 'ssh', digest)
    await store.setDefaultCommandSet([otherRule], store.commandRevision())
    await store.setCommandSet(client, 'ssh', digest, { inheritDefaults: false, rules: [rule] }, store.commandRevision())
    const revision = store.commandRevision()
    const saving = store.setPermission(client.id, client.generation, duration)
    expect(store.isCurrent(client)).toBe(false)
    expect(store.commandRevision()).toBeGreaterThan(revision)
    await saving
    const updated = store.list()[0]!
    expect(updated.generation).toBe(client.generation + 1)
    expect(store.tokenFor(client.id)).toBe(token)
    expect(store.hasConnectionPermission(updated, 'ssh', digest)).toBe(true)
    expect(store.commandSet(updated, 'ssh', digest)).toMatchObject({ inheritDefaults: false, rules: [rule], defaultRules: [] })
    const restarted = new CredentialStore(file)
    await restarted.load()
    expect(restarted.commandSet(updated, 'ssh', digest)).toMatchObject({ inheritDefaults: false, rules: [rule], defaultRules: [] })
  })

  it('preserves command choices when a failed pairing update is flushed by an unrelated save', async () => {
    let fail = false
    const { store, file } = await setup({ rename: async (from, to) => {
      if (fail) throw new Error('disk full')
      await fs.rename(from, to)
    } })
    const client = await store.create('Agent')
    await store.setDefaultCommandSet([otherRule], store.commandRevision())
    await store.setCommandSet(client, 'ssh', digest, { inheritDefaults: false, rules: [rule] }, store.commandRevision())
    fail = true
    await expect(store.setPermission(client.id, client.generation, '24h')).rejects.toThrow()
    expect(store.isCurrent(client)).toBe(false)
    fail = false
    await store.create('Unrelated')
    const restarted = new CredentialStore(file)
    await restarted.load()
    expect(restarted.permission(client.id)).toEqual({ kind: 'none' })
    expect(restarted.commandSet(client, 'ssh', digest)).toMatchObject({ inheritDefaults: false, rules: [rule], defaultRules: [] })
  })

  it('keeps the existing guard when cancellation at the final async check prevents recreating it', async () => {
    let armed = false, current = true, failMarker = false, file = ''
    const fixture = await setup({
      open: async (...args) => {
        if (failMarker && String(args[0]).endsWith('.pending')) {
          throw Object.assign(new Error('no space for marker'), { code: 'ENOSPC' })
        }
        return fs.open(...args)
      },
      lstat: (async (...args: Parameters<typeof fs.lstat>) => {
        const stat = await fs.lstat(...args)
        if (armed && String(args[0]).endsWith('.pending')) {
          const disk = JSON.parse(await fs.readFile(file, 'utf8'))
          if (disk.credentials[0].commandSets[0]?.rules.length) {
            armed = false; current = false; failMarker = true
          }
        }
        return stat
      }) as typeof fs.lstat,
    })
    file = fixture.file
    const client = await fixture.store.create('Agent')
    armed = true
    await expect(fixture.store.setCommandSet(client, 'ssh', digest, { inheritDefaults: false, rules: [rule] }, fixture.store.commandRevision(), () => current)).rejects.toThrow()
    expect(current).toBe(false)
    expect(fixture.store.commandSet(client, 'ssh', digest).rules).toEqual([])
    await expect(new CredentialStore(file).load()).rejects.toThrow()
    expect((await fs.stat(file + '.pending')).size).toBe(0)
  })
  it('keeps the guard after cancellation even when another temporary write cannot succeed', async () => {
    let armed = false, current = true, failRollback = false
    const { store, file } = await setup({
      open: async (...args) => {
        if (failRollback && String(args[0]).includes('.credentials-')) throw new Error('disk full during rollback')
        return fs.open(...args)
      },
      rename: async (from, to) => {
        await fs.rename(from, to)
        if (armed) { armed = false; current = false; failRollback = true }
      },
    })
    let client = await store.create('Agent')
    await store.setPermission(client.id, client.generation, 'permanent')
    client = store.list()[0]!
    await store.setConnectionPermission(client, 'ssh', digest)
    armed = true
    await expect(store.setCommandSet(client, 'ssh', digest, { inheritDefaults: false, rules: [rule] }, store.commandRevision(), () => current)).rejects.toThrow()
    expect(store.commandSet(client, 'ssh', digest).rules).toEqual([])
    await expect(new CredentialStore(file).load()).rejects.toThrow()
    expect((await fs.stat(file + '.pending')).size).toBe(0)
  })

  it('does not persist a connection authorization whose request became invalid during rename', async () => {
    let armed = false, current = true
    const { store, file } = await setup({ rename: async (from, to) => {
      await fs.rename(from, to)
      if (armed) { armed = false; current = false }
    } })
    const client = await store.create('Agent')
    armed = true
    await expect(store.setConnectionPermission(client, 'ssh', digest, store.connectionRevision(client), () => current)).rejects.toThrow()
    expect(store.hasConnectionPermission(client, 'ssh', digest)).toBe(false)
    const restarted = new CredentialStore(file)
    await expect(restarted.load()).rejects.toThrow()
  })
  it('inherits live defaults while keeping local sets isolated and snapshots defensive', async () => {
    const { store, file } = await setup()
    const a = await store.create('same name'), b = await store.create('same name')
    expect(store.defaultCommandSet().rules).toEqual([])
    await store.setDefaultCommandSet([rule], store.commandRevision())
    expect(store.commandSet(a, 'ssh', digest)).toMatchObject({ rules: [], defaultRules: [rule], inheritDefaults: true, stale: false })
    await store.setCommandSet(a, 'ssh', digest, { inheritDefaults: false, rules: [otherRule] }, store.commandRevision())
    expect(store.commandSet(a, 'other', digest).defaultRules).toEqual([rule])
    expect(store.commandSet(b, 'ssh', digest).rules).toEqual([])
    const snapshot = store.defaultCommandSet()
    snapshot.rules[0].kind === 'family' && snapshot.rules[0].argv.push('unsafe')
    expect(store.defaultCommandSet().rules).toEqual([rule])
    await store.setDefaultCommandSet([otherRule], store.commandRevision())
    expect(store.commandSet(a, 'ssh', digest).defaultRules).toEqual([])
    expect(store.commandSet(b, 'ssh', digest).defaultRules).toEqual([otherRule])
    const restarted = new CredentialStore(file)
    await restarted.load()
    expect(restarted.commandSet(a, 'ssh', digest)).toMatchObject({ rules: [otherRule], inheritDefaults: false })
    expect(JSON.parse(await fs.readFile(file, 'utf8')).version).toBe(4)
  })
  it('rejects stale editors and clears effective rules for stale SSH digests', async () => {
    const { store } = await setup()
    const a = await store.create('a')
    await store.setDefaultCommandSet([rule], store.commandRevision())
    const old = store.commandRevision()
    await store.setCommandSet(a, 'ssh', digest, { inheritDefaults: true, rules: [otherRule] }, old)
    await expect(store.setCommandSet(a, 'ssh', digest, { inheritDefaults: false, rules: [] }, old)).rejects.toThrow()
    expect(store.commandSet(a, 'ssh', otherDigest)).toMatchObject({ stale: true, rules: [], defaultRules: [] })
    await store.setCommandSet(a, 'ssh', digest, { inheritDefaults: false, rules: [] }, store.commandRevision())
    expect(store.commandSet(a, 'ssh', digest)).toMatchObject({ rules: [], defaultRules: [], inheritDefaults: false })
  })

  it.each([1, 2])('loads v%s without commands and upgrades without rotating the token', async version => {
    const { store, file } = await setup()
    const a = await store.create('legacy'), token = store.tokenFor(a.id)
    const payload = JSON.parse(await fs.readFile(file, 'utf8'))
    payload.version = version
    delete payload.defaultCommands
    for (const record of payload.credentials) {
      delete record.commandSets
      delete record.fileTransfers
      if (version === 1) delete record.connections
    }
    await fs.writeFile(file, JSON.stringify(payload))
    const legacy = new CredentialStore(file)
    await legacy.load()
    expect(legacy.commandSet(a, 'ssh', digest)).toMatchObject({ rules: [], defaultRules: [], inheritDefaults: true })
    await legacy.setDefaultCommandSet([rule], legacy.commandRevision())
    expect(legacy.tokenFor(a.id)).toBe(token)
    expect(JSON.parse(await fs.readFile(file, 'utf8')).version).toBe(4)
  })

  it.each(['reset', 'revoke'] as const)('invalidates command revisions and local sets on %s', async operation => {
    const { store, file } = await setup()
    const a = await store.create('a')
    await store.setCommandSet(a, 'ssh', digest, { inheritDefaults: false, rules: [rule] }, store.commandRevision())
    const before = store.commandRevision()
    const updating = store[operation](a.id)
    expect(store.commandRevision()).toBeGreaterThan(before)
    await updating
    if (operation === 'reset') {
      expect(store.commandSet({ ...a, generation: a.generation + 1 }, 'ssh', digest).rules).toEqual([])
      expect(JSON.parse(await fs.readFile(file, 'utf8')).credentials[0].commandSets).toEqual([])
    } else expect(store.isCurrent(a)).toBe(false)
  })

  it.each(['global', 'local'] as const)('keeps a failed %s reduction denied through unrelated saves', async target => {
    let fail = false
    const { store, file } = await setup({ rename: async (from, to) => {
      if (fail) throw new Error('disk full')
      await fs.rename(from, to)
    } })
    const a = await store.create('a')
    await store.setDefaultCommandSet([rule], store.commandRevision())
    await store.setCommandSet(a, 'ssh', digest, { inheritDefaults: true, rules: [otherRule] }, store.commandRevision())
    fail = true
    const saving = target === 'global' ? store.setDefaultCommandSet([], store.commandRevision())
      : store.setCommandSet(a, 'ssh', digest, { inheritDefaults: false, rules: [] }, store.commandRevision())
    expect(target === 'global' ? store.defaultCommandSet().rules : store.commandSet(a, 'ssh', digest).rules).toEqual([])
    await expect(saving).rejects.toThrow()
    expect(store.hasUnpersistedRevocations).toBe(true)
    fail = false
    await store.rename(a.id, 'unrelated')
    const restarted = new CredentialStore(file)
    await restarted.load()
    expect(target === 'global' ? restarted.defaultCommandSet().rules : restarted.commandSet(a, 'ssh', digest).rules).toEqual([])
    if (target === 'local') expect(restarted.commandSet(a, 'ssh', digest).defaultRules).toEqual([])
  })

  it.each(['before-queue', 'rename', 'commit-check'] as const)('never remembers a cancelled grant at %s', async phase => {
    let active = true, armed = false
    const { store, file } = await setup({
      rename: async (from, to) => { await fs.rename(from, to); if (armed && phase === 'rename') active = false },
      lstat: (async (...args: Parameters<typeof fs.lstat>) => {
        const stat = await fs.lstat(...args)
        if (armed && phase === 'commit-check' && String(args[0]).endsWith('.pending')) {
          const data = JSON.parse(await fs.readFile(String(args[0]).slice(0, -'.pending'.length), 'utf8'))
          if (data.credentials[0].commandSets[0]?.rules.length) active = false
        }
        return stat
      }) as typeof fs.lstat,
    })
    const a = await store.create('a')
    armed = true
    const saving = store.setCommandSet(a, 'ssh', digest, { inheritDefaults: false, rules: [rule] }, store.commandRevision(), () => active)
    if (phase === 'before-queue') active = false
    await expect(saving).rejects.toThrow()
    expect(store.commandSet(a, 'ssh', digest).rules).toEqual([])
    armed = false
    await store.rename(a.id, 'retry')
    const restarted = new CredentialStore(file)
    await restarted.load()
    expect(restarted.commandSet(a, 'ssh', digest).rules).toEqual([])
  })

  it('clears local grants when the SSH connection permission is revoked', async () => {
    const { store } = await setup()
    const a = await store.create('a')
    await store.setConnectionPermission(a, 'ssh', digest)
    await store.setCommandSet(a, 'ssh', digest, { inheritDefaults: false, rules: [rule] }, store.commandRevision())
    await store.setConnectionPermission(a, 'ssh', null)
    expect(store.commandSet(a, 'ssh', digest).rules).toEqual([])
  })

  it('captures queued inputs and denies queued reductions immediately', async () => {
    let block = false, entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const proceed = new Promise<void>(resolve => { release = resolve })
    const { store } = await setup({ rename: async (from, to) => {
      if (block) { block = false; entered(); await proceed }
      await fs.rename(from, to)
    } })
    const a = await store.create('a')
    await store.setDefaultCommandSet([rule], store.commandRevision())
    await store.setCommandSet(a, 'ssh', digest, { inheritDefaults: true, rules: [otherRule] }, store.commandRevision())
    block = true
    const renaming = store.rename(a.id, 'renamed')
    await started
    const input = { inheritDefaults: false, rules: [structuredClone(rule)] }
    const client = { ...a }
    const saving = store.setCommandSet(client, 'ssh', digest, input, store.commandRevision())
    expect(store.commandSet(a, 'ssh', digest)).toMatchObject({ rules: [], defaultRules: [] })
    input.rules[0].argv.push('unsafe')
    client.id = 'changed'
    release()
    await renaming
    await saving
    expect(store.commandSet(a, 'ssh', digest).rules).toEqual([rule])
  })

  it('prevents an in-flight remembered approval from resurrecting a newer clear', async () => {
    let block = false, entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const proceed = new Promise<void>(resolve => { release = resolve })
    const { store, file } = await setup({ rename: async (from, to) => {
      if (block) { block = false; entered(); await proceed }
      await fs.rename(from, to)
    } })
    const a = await store.create('a')
    block = true
    const saving = store.setCommandSet(a, 'ssh', digest, { inheritDefaults: true, rules: [rule] }, store.commandRevision())
    const rejected = expect(saving).rejects.toThrow()
    await started
    const clearing = store.setCommandSet(a, 'ssh', digest, { inheritDefaults: false, rules: [] }, store.commandRevision())
    expect(store.commandSet(a, 'ssh', digest)).toMatchObject({ rules: [], defaultRules: [] })
    release()
    await rejected
    await clearing
    const restarted = new CredentialStore(file)
    await restarted.load()
    expect(restarted.commandSet(a, 'ssh', digest)).toMatchObject({ rules: [], defaultRules: [], inheritDefaults: false })
  })

  it.each(['global', 'local'] as const)('never activates failed %s additions after replacement or on later saves', async target => {
    let armed = false, replaced = false
    const { store, file } = await setup({
      rename: async (from, to) => { await fs.rename(from, to); if (armed) replaced = true },
      open: async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args)
        if (armed && replaced && path.basename(String(args[0])) === 'private') handle.sync = async () => { throw new Error('sync failed') }
        return handle
      },
    })
    const a = await store.create('a')
    armed = true
    await expect(target === 'global' ? store.setDefaultCommandSet([rule], store.commandRevision())
      : store.setCommandSet(a, 'ssh', digest, { inheritDefaults: true, rules: [rule] }, store.commandRevision())).rejects.toThrow()
    expect(store.defaultCommandSet().rules).toEqual([])
    expect(store.commandSet(a, 'ssh', digest).rules).toEqual([])
    await expect(new CredentialStore(file).load()).rejects.toThrow()
    armed = false
    await store.create('unrelated')
    const restarted = new CredentialStore(file)
    await restarted.load()
    expect(restarted.defaultCommandSet().rules).toEqual([])
    expect(restarted.commandSet(a, 'ssh', digest).rules).toEqual([])
  })

  it('rejects invalid or over-limit rules atomically and enforces the aggregate per-client limit', async () => {
    const { store } = await setup()
    const a = await store.create('a')
    const exact = Array.from({ length: 128 }, (_, i) => ({ kind: 'exact' as const, version: 1 as const, program: 'echo', hash: i.toString(16).padStart(64, '0') }))
    await store.setDefaultCommandSet(exact, store.commandRevision())
    await store.setCommandSet(a, 'one', digest, { inheritDefaults: false, rules: exact.slice(0, 127) }, store.commandRevision())
    await store.setCommandSet(a, 'two', digest, { inheritDefaults: false, rules: [exact[127]] }, store.commandRevision())
    const revision = store.commandRevision()
    await expect(store.setCommandSet(a, 'three', digest, { inheritDefaults: false, rules: [rule] }, revision)).rejects.toThrow()
    await expect(store.setDefaultCommandSet([...exact, rule], revision)).rejects.toThrow()
    await expect(store.setDefaultCommandSet([{ ...rule, argv: ['sh', '-c'] }], revision)).rejects.toThrow()
    expect(store.commandRevision()).toBe(revision)
    expect(store.defaultCommandSet().rules).toHaveLength(128)
    expect(store.commandSet(a, 'one', digest).rules).toHaveLength(127)
  })

  it('checks the 64 KiB combined file limit before invalidating current authorization', async () => {
    const { store, file } = await setup()
    const a = await store.create('a')
    await store.setDefaultCommandSet([rule], store.commandRevision())
    const longProfile = 'p'.repeat(1020)
    for (let i = 0; i < 55; i++) {
      await store.setCommandSet(a, longProfile + i, digest, { inheritDefaults: false, rules: [] }, store.commandRevision())
    }
    const before = await fs.readFile(file, 'utf8'), revision = store.commandRevision()
    const exact = Array.from({ length: 128 }, (_, i) => ({ kind: 'exact' as const, version: 1 as const, program: 'echo', hash: i.toString(16).padStart(64, '0') }))
    await expect(store.setDefaultCommandSet(exact, revision)).rejects.toThrow()
    expect(store.commandRevision()).toBe(revision)
    expect(store.defaultCommandSet().rules).toEqual([rule])
    expect(await fs.readFile(file, 'utf8')).toBe(before)
  })

  it('does not invalidate a command approval when its connection approval is persisted', async () => {
    const { store } = await setup()
    const a = await store.create('a'), revision = store.commandRevision()
    await store.setConnectionPermission(a, 'ssh', digest)
    expect(store.commandRevision()).toBe(revision)
  })

  it('rejects success if a newer command mutation starts in the commit observer', async () => {
    const { store } = await setup()
    const a = await store.create('a')
    let clearing: Promise<void> | undefined, armed = true
    store.onChange(() => {
      if (armed && store.commandSet(a, 'ssh', digest).rules.length) {
        armed = false
        clearing = store.setCommandSet(a, 'ssh', digest, { inheritDefaults: false, rules: [] }, store.commandRevision())
      }
    })
    await expect(store.setCommandSet(a, 'ssh', digest, { inheritDefaults: false, rules: [rule] }, store.commandRevision())).rejects.toThrow()
    await clearing
    expect(store.commandSet(a, 'ssh', digest).rules).toEqual([])
  })

})
