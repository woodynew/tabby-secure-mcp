import { describe, expect, it, vi } from 'vitest'
import { AuthorizedProfilesService } from '../src/services/authorized-profiles.service'
import { PermanentAuthorizationStore } from '../src/authorization/permanent-authorization-store'
import { stableProfileDigest } from '../src/approval/profile-security-snapshot'
import { SecureMcpSettingsComponent } from '../src/settings/secure-mcp-settings.component'
import { persistAuthorizedSshProfileIds } from '../src/config/secure-mcp-config'

const profile = { id: 'p', name: 'SSH', type: 'ssh', group: 'g', options: {}, isBuiltin: false, isTemplate: false }
function fixture() {
  const config = { store: { secureMcp: { authorizedSshProfileIds: ['p'], permanentAuthorizations: [] as any[] } }, save: vi.fn(async () => undefined) }
  let host = 'a.invalid'
  const profiles = {
    getProfiles: async () => [structuredClone(profile)],
    getConfigProxyForProfile: (p: any) => ({ ...p, options: { host, user: 'test', ...p.options } }),
  }
  return { config, profiles, setHost: (next: string) => { host = next }, memory: new PermanentAuthorizationStore(config as never) }
}

describe('authorization security regressions', () => {
  it('materializes Tabby 1.0.238 ConfigProxy getters without copying its refresh methods', async () => {
    const f = fixture()
    f.profiles.getConfigProxyForProfile = (p: any) => ({ ...p, options: { host: 'a.invalid' }, __setDefaults() {} })
    const service = new AuthorizedProfilesService(f.profiles as never, f.config as never)
    const [entry] = await service.listAuthorizedProfiles()
    const effective = await service.resolveAuthorizedProfile(entry.profile_ref)
    expect(effective.options.host).toBe('a.invalid')
    expect(effective).not.toHaveProperty('__setDefaults')
  })

  it('does not let Tabby default materialization mutate the stored SSH profile', async () => {
    const f = fixture()
    ;(f.config.store as any).profiles = [structuredClone(profile)]
    f.profiles.getConfigProxyForProfile = (p: any) => { p.options.host = 'inherited.invalid'; return p }
    const service = new AuthorizedProfilesService(f.profiles as never, f.config as never)
    const [entry] = await service.listAuthorizedProfiles()
    expect(service.resolveAuthorizedProfileNow(entry.profile_ref).options.host).toBe('inherited.invalid')
    expect((f.config.store as any).profiles[0].options).toEqual({})
  })
  it('binds the digest to effective inherited connection options', async () => {
    const f = fixture()
    const service = new AuthorizedProfilesService(f.profiles as never, f.config as never)
    const [entry] = await service.listAuthorizedProfiles()
    const before = await service.resolveAuthorizedProfile(entry.profile_ref)
    f.setHost('b.invalid')
    const after = await service.resolveAuthorizedProfile(entry.profile_ref)
    expect(before.options.host).toBe('a.invalid')
    expect(after.options.host).toBe('b.invalid')
    expect(stableProfileDigest(before)).not.toBe(stableProfileDigest(after))
  })

  it('revoking a stale open never refreshes its command authorization', async () => {
    const f = fixture()
    await f.memory.setManagedGrant('p', { ...profile, options: { host: 'old.invalid' } }, { openSession: true, operationTier: 'full' })
    const component = new SecureMcpSettingsComponent(f.config as never, f.profiles as never, f.memory)
    await component.reload()
    expect(component.rows[0].grantStale).toBe(true)
    await component.onRevokeOpen(component.rows[0])
    const effective = f.profiles.getConfigProxyForProfile(profile)
    expect(f.memory.effectiveGrant('p', stableProfileDigest(effective))).toEqual({ openSession: false, operationTier: 'none' })
    expect(component.rows[0].grantStale).toBe(true)
  })

  it('does not activate a failed permission increase and keeps the error visible', async () => {
    const f = fixture()
    const component = new SecureMcpSettingsComponent(f.config as never, f.profiles as never, f.memory)
    await component.reload()
    f.config.save.mockRejectedValueOnce(new Error('disk full'))
    await component.onTierChange(component.rows[0], 'full')
    expect(f.memory.effectiveGrant('p', stableProfileDigest(f.profiles.getConfigProxyForProfile(profile)))).toEqual({ openSession: false, operationTier: 'none' })
    expect(component.error).toMatch(/not persisted|save/i)
  })

  it('keeps a failed revocation denied and serializes an earlier failed increase', async () => {
    const f = fixture()
    const effective = f.profiles.getConfigProxyForProfile(profile)
    const digest = stableProfileDigest(effective)
    await f.memory.setManagedGrant('p', effective, { openSession: true, operationTier: 'readonly' })
    let rejectSave!: (reason: Error) => void
    f.config.save.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSave = reject }))
    const increase = f.memory.setManagedGrant('p', effective, { openSession: true, operationTier: 'full' })
    const failedIncrease = expect(increase).rejects.toThrow('first failure')
    await vi.waitFor(() => expect(rejectSave).toBeTypeOf('function'))
    const revoke = f.memory.setManagedGrant('p', effective, { openSession: false, operationTier: 'none' })
    f.config.save.mockRejectedValueOnce(new Error('revoke failure'))
    const failedRevoke = expect(revoke).rejects.toThrow('revoke failure')
    expect(f.memory.effectiveGrant('p', digest)).toEqual({ openSession: false, operationTier: 'none' })
    rejectSave(new Error('first failure'))
    await failedIncrease
    await failedRevoke
    expect(f.memory.effectiveGrant('p', digest)).toEqual({ openSession: false, operationTier: 'none' })
  })

  it('keeps a failed revocation denied after Tabby replaces the config store', async () => {
    const f = fixture()
    const effective = f.profiles.getConfigProxyForProfile(profile)
    const digest = stableProfileDigest(effective)
    await f.memory.setManagedGrant('p', effective, { openSession: true, operationTier: 'full' })
    const disk = structuredClone(f.config.store)
    f.config.save.mockRejectedValueOnce(new Error('disk full'))
    await expect(f.memory.setManagedGrant('p', effective, { openSession: false, operationTier: 'none' })).rejects.toThrow()
    expect(f.memory.effectiveGrant('p', digest).operationTier).toBe('none')
    f.config.store = structuredClone(disk)
    expect(f.memory.effectiveGrant('p', digest)).toEqual({ openSession: false, operationTier: 'none' })
  })

  it('does not restore a failed revocation when another profile is whitelisted', async () => {
    const f = fixture()
    const effective = f.profiles.getConfigProxyForProfile(profile)
    const digest = stableProfileDigest(effective)
    await f.memory.setManagedGrant('p', effective, { openSession: true, operationTier: 'full' })
    f.config.save.mockRejectedValueOnce(new Error('disk full'))
    await expect(f.memory.revokeOpen('p')).rejects.toThrow()
    await persistAuthorizedSshProfileIds(f.config as never, ['p', 'other'])
    expect(f.memory.effectiveGrant('p', digest)).toEqual({ openSession: false, operationTier: 'none' })
    expect(f.config.store.secureMcp.permanentAuthorizations).toEqual([])
  })

  it('does not restore an old command grant when a failed whitelist removal is re-enabled', async () => {
    const f = fixture()
    const effective = f.profiles.getConfigProxyForProfile(profile)
    const digest = stableProfileDigest(effective)
    await f.memory.setManagedGrant('p', effective, { openSession: true, operationTier: 'full' })
    f.config.save.mockRejectedValueOnce(new Error('disk full'))
    await expect(persistAuthorizedSshProfileIds(f.config as never, [])).rejects.toThrow()
    await persistAuthorizedSshProfileIds(f.config as never, ['p'])
    expect(f.memory.effectiveGrant('p', digest)).toEqual({ openSession: false, operationTier: 'none' })
  })
})
