import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CredentialStore } from '../src/http/credentials.js'

const directories: string[] = []
const digest = 'a'.repeat(64)
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))) })
async function fixture(options: { fs?: Partial<typeof fs> } = {}) {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'client-connections-'))
  directories.push(dir)
  const file = path.join(dir, 'private', 'credentials.json')
  const store = new CredentialStore(file, options)
  await store.load()
  const a = await store.create('Agent'), b = await store.create('Agent')
  return { store, file, a, b }
}

describe('client-scoped SSH connection permissions', () => {
  it('preauthorizes one named client and restores only its permission after restart', async () => {
    const { store, file, a, b } = await fixture()
    await store.setConnectionPermission(a, 'ssh-p', digest)
    expect(store.hasConnectionPermission(a, 'ssh-p', digest)).toBe(true)
    expect(store.hasConnectionPermission(b, 'ssh-p', digest)).toBe(false)
    expect(store.hasConnectionPermission(a, 'ssh-p', 'b'.repeat(64))).toBe(false)
    const restarted = new CredentialStore(file)
    await restarted.load()
    expect(restarted.hasConnectionPermission(a, 'ssh-p', digest)).toBe(true)
    expect(restarted.hasConnectionPermission(b, 'ssh-p', digest)).toBe(false)
  })

  it('preserves permissions across rename and pairing edits, but clears them on credential reset', async () => {
    const { store, a } = await fixture()
    await store.setConnectionPermission(a, 'ssh-p', digest)
    await store.rename(a.id, 'Renamed')
    await store.setPermission(a.id, a.generation, 'permanent')
    const updated = store.list()[0]!
    expect(store.hasConnectionPermission(updated, 'ssh-p', digest)).toBe(true)
    expect(store.hasConnectionPermission(a, 'ssh-p', digest)).toBe(false)
    await store.reset(a.id)
    expect(store.connectionGrants(store.list()[0]!)).toEqual([])
  })

  it('rejects an older dialog approval after revocation, including a failed revocation save', async () => {
    let fail = false
    const { store, a } = await fixture({ fs: { rename: async (from, to) => {
      if (fail) throw new Error('disk unavailable')
      await fs.rename(from, to)
    } } })
    await store.setConnectionPermission(a, 'ssh-p', digest)
    const revision = store.connectionRevision(a)
    fail = true
    await expect(store.setConnectionPermission(a, 'ssh-p', null)).rejects.toThrow()
    expect(store.hasConnectionPermission(a, 'ssh-p', digest)).toBe(false)
    expect(store.hasUnpersistedRevocations).toBe(true)
    fail = false
    await expect(store.setConnectionPermission(a, 'ssh-p', digest, revision)).rejects.toThrow()
    await store.rename(a.id, 'Retry unrelated save')
    expect(store.hasConnectionPermission(a, 'ssh-p', digest)).toBe(false)
    expect(store.hasUnpersistedRevocations).toBe(false)
  })

  it('loads version one without granting connections and upgrades without rotating tokens', async () => {
    const { store, file, a } = await fixture()
    await store.grant(a.id, a.generation, 'permanent')
    const token = store.tokenFor(a.id)
    const legacy = JSON.parse(await fs.readFile(file, 'utf8'))
    legacy.version = 1
    delete legacy.defaultCommands
    for (const record of legacy.credentials) { delete record.connections; delete record.commandSets; delete record.fileTransfers }
    await fs.writeFile(file, JSON.stringify(legacy))
    const upgraded = new CredentialStore(file)
    await upgraded.load()
    expect(upgraded.connectionGrants(a)).toEqual([])
    await upgraded.setConnectionPermission(a, 'ssh-p', digest)
    expect(upgraded.tokenFor(a.id)).toBe(token)
    expect(upgraded.permission(a.id).kind).toBe('permanent')
    expect(JSON.parse(await fs.readFile(file, 'utf8')).version).toBe(4)
    expect(upgraded.hasFileTransferPermission(a, 'ssh-p', digest)).toBe(false)
  })

  it('keeps a newer revocation effective while an older approval is committing', async () => {
    let block = false, release!: () => void, entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const { store, file, a } = await fixture({ fs: { rename: async (from, to) => {
      if (block) { block = false; entered(); await new Promise<void>(resolve => { release = resolve }) }
      await fs.rename(from, to)
    } } })
    block = true
    const older = store.setConnectionPermission(a, 'ssh-p', digest)
    const rejected = expect(older).rejects.toThrow()
    await waiting
    const revoke = store.setConnectionPermission(a, 'ssh-p', null)
    expect(store.hasConnectionPermission(a, 'ssh-p', digest)).toBe(false)
    release()
    await rejected
    await revoke
    const restarted = new CredentialStore(file)
    await restarted.load()
    expect(restarted.hasConnectionPermission(a, 'ssh-p', digest)).toBe(false)
  })

  it('refuses malformed or duplicate connection grants without overwriting evidence', async () => {
    const { store, file, a } = await fixture()
    await store.setConnectionPermission(a, 'ssh-p', digest)
    const valid = JSON.parse(await fs.readFile(file, 'utf8'))
    const grant = valid.credentials[0].connections[0]
    for (const connections of [[{ ...grant, profileDigest: 'invalid' }], [grant, grant], [{ ...grant, extra: true }]]) {
      const invalid = structuredClone(valid)
      invalid.credentials[0].connections = connections
      const text = JSON.stringify(invalid)
      await fs.writeFile(file, text)
      await expect(new CredentialStore(file).load()).rejects.toThrow()
      expect(await fs.readFile(file, 'utf8')).toBe(text)
    }
  })
})
