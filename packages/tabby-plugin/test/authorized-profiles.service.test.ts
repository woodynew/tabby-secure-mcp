import { describe, expect, it, vi } from 'vitest'
import type { PartialProfile, Profile } from 'tabby-core'

import { TargetUnavailableError } from '../src/profiles/errors'
import { AuthorizedProfilesService } from '../src/services/authorized-profiles.service'
import { readAuthorizedSshProfileIds } from '../src/config/secure-mcp-config'

const SECRET_HOST = 'secret-host.example'
const SECRET_USER = 'secret-user'
const SECRET_OPTIONS = { host: SECRET_HOST, user: SECRET_USER, password: 'hunter2' }

function sshProfile(overrides: Partial<PartialProfile<Profile>> = {}): PartialProfile<Profile> {
  return {
    id: 'ssh-1',
    type: 'ssh',
    name: 'Primary SSH',
    options: SECRET_OPTIONS,
    isBuiltin: false,
    isTemplate: false,
    ...overrides,
  }
}

function createHarness(profiles: PartialProfile<Profile>[], whitelist: string[] = []) {
  let currentProfiles = profiles.map(p => ({ ...p, options: { ...SECRET_OPTIONS, ...(p.options ?? {}) } }))
  const config = {
    store: { secureMcp: { authorizedSshProfileIds: [...whitelist] } },
    save: vi.fn(async () => undefined),
  }
  const profilesService = {
    getProfiles: vi.fn(async () => currentProfiles.map(p => ({ ...p, options: { ...p.options } }))),
  }
  const service = new AuthorizedProfilesService(profilesService as never, config as never)

  return {
    service,
    config,
    profilesService,
    setProfiles(next: PartialProfile<Profile>[]) {
      currentProfiles = next
    },
    setWhitelist(ids: string[]) {
      config.store.secureMcp.authorizedSshProfileIds = [...ids]
    },
  }
}

describe('AuthorizedProfilesService', () => {
  it('lists only authorized eligible SSH profiles with opaque refs', async () => {
    const harness = createHarness(
      [
        sshProfile({ id: 'allowed', name: 'Allowed' }),
        sshProfile({ id: 'blocked', name: 'Blocked' }),
        sshProfile({ id: 'builtin', name: 'Builtin', isBuiltin: true }),
        sshProfile({ id: 'template', name: 'Template', isTemplate: true }),
        sshProfile({ id: 'local', name: 'Local', type: 'local' }),
        sshProfile({ id: '', name: 'Missing id' }),
      ],
      ['allowed'],
    )

    const listed = await harness.service.listAuthorizedProfiles()

    expect(listed).toEqual([{ profile_ref: expect.any(String), display_name: 'Allowed' }])
    expect(listed[0]!.profile_ref).not.toBe('allowed')
    expect(listed[0]!.profile_ref).toMatch(/^[0-9a-f]{32}$/)
    const serialized = JSON.stringify(listed)
    expect(serialized).not.toMatch(/secret-host|secret-user|hunter2|Blocked|Builtin|Template|Local/i)
    expect(serialized).not.toMatch(/"host"|"user"|"password"|"options"/)
  })

  it('keeps profile_ref stable while authorized and issues a fresh ref after reauthorization', async () => {
    const harness = createHarness([sshProfile({ id: 'a', name: 'A' })], ['a'])

    const first = await harness.service.listAuthorizedProfiles()
    const stableRef = first[0]!.profile_ref

    const second = await harness.service.listAuthorizedProfiles()
    expect(second[0]!.profile_ref).toBe(stableRef)

    harness.setWhitelist([])
    await harness.service.listAuthorizedProfiles()

    harness.setWhitelist(['a'])
    const reauthorized = await harness.service.listAuthorizedProfiles()
    expect(reauthorized[0]!.profile_ref).not.toBe(stableRef)
    expect(reauthorized[0]!.profile_ref).toMatch(/^[0-9a-f]{32}$/)
  })

  it('invalidates refs when a profile is revoked, deleted, or becomes ineligible', async () => {
    const harness = createHarness([sshProfile({ id: 'a', name: 'A' })], ['a'])
    const [{ profile_ref }] = await harness.service.listAuthorizedProfiles()

    harness.setWhitelist([])
    await expect(harness.service.resolveAuthorizedProfile(profile_ref)).rejects.toBeInstanceOf(
      TargetUnavailableError,
    )

    harness.setWhitelist(['a'])
    const [{ profile_ref: ref2 }] = await harness.service.listAuthorizedProfiles()
    harness.setProfiles([])
    await expect(harness.service.resolveAuthorizedProfile(ref2)).rejects.toBeInstanceOf(TargetUnavailableError)
  })

  it('resolve re-queries profiles and rejects TOCTOU whitelist or eligibility changes', async () => {
    const harness = createHarness([sshProfile({ id: 'a', name: 'A' })], ['a'])
    const [{ profile_ref }] = await harness.service.listAuthorizedProfiles()

    harness.profilesService.getProfiles.mockImplementationOnce(async () => [
      sshProfile({ id: 'a', name: 'A', type: 'local' }),
    ])
    await expect(harness.service.resolveAuthorizedProfile(profile_ref)).rejects.toBeInstanceOf(
      TargetUnavailableError,
    )

    harness.setWhitelist(['a'])
    const [{ profile_ref: ref2 }] = await harness.service.listAuthorizedProfiles()
    harness.profilesService.getProfiles.mockImplementationOnce(async () => [sshProfile({ id: 'a', name: 'A' })])
    harness.setWhitelist([])
    await expect(harness.service.resolveAuthorizedProfile(ref2)).rejects.toBeInstanceOf(TargetUnavailableError)
  })

  it('resolve returns a fresh cloned profile internally without exposing the real id via list API', async () => {
    const harness = createHarness([sshProfile({ id: 'a', name: 'A' })], ['a'])
    const [{ profile_ref }] = await harness.service.listAuthorizedProfiles()

    const resolved = await harness.service.resolveAuthorizedProfile(profile_ref)
    expect(resolved.id).toBe('a')
    expect(resolved.options).toEqual(SECRET_OPTIONS)

    const listed = await harness.service.listAuthorizedProfiles()
    expect(JSON.stringify(listed)).not.toContain('"id"')
    expect(listed[0]!.profile_ref).not.toBe('a')
  })

  it('never calls getProfiles with builtin profiles and always clones', async () => {
    const harness = createHarness([sshProfile()], ['ssh-1'])
    await harness.service.listAuthorizedProfiles()
    expect(harness.profilesService.getProfiles).toHaveBeenCalledWith({ includeBuiltin: false, clone: true })
  })

  it('reads whitelist through config helpers only', () => {
    expect(readAuthorizedSshProfileIds({ secureMcp: { authorizedSshProfileIds: ['x'] } })).toEqual(['x'])
  })
})
