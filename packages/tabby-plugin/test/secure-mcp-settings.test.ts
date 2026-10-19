import { describe, expect, it, vi } from 'vitest'
import type { PartialProfile, Profile } from 'tabby-core'

import { stableProfileDigest } from '../src/approval/profile-security-snapshot'
import { PermanentAuthorizationStore } from '../src/authorization/permanent-authorization-store'
import { readPermanentAuthorizations } from '../src/config/secure-mcp-config'
import { secureMcpSettingsTabMetadata } from '../src/settings/secure-mcp-settings.metadata'
import { SecureMcpSettingsComponent } from '../src/settings/secure-mcp-settings.component'
import { buildSecureMcpSettingsRows } from '../src/settings/secure-mcp-settings.view-model'
import { createTabbyConfigProxyHarness } from './tabby-config-proxy.harness'

describe('Secure MCP settings metadata', () => {
  it('registers settings tab metadata', () => {
    expect(secureMcpSettingsTabMetadata.id).toBe('secure-mcp')
    expect(secureMcpSettingsTabMetadata.title).toBe('Secure MCP')
    expect(secureMcpSettingsTabMetadata.icon).toMatch(/shield|lock/i)
  })
})

describe('Secure MCP settings view model', () => {
  const profiles: PartialProfile<Profile>[] = [
    {
      id: 'ssh-1',
      type: 'ssh',
      name: 'Prod',
      options: { host: 'secret.example', user: 'root' },
      isBuiltin: false,
      isTemplate: false,
    },
    {
      id: 'ssh-2',
      type: 'ssh',
      name: 'Hidden',
      options: { host: 'hidden.example' },
      isBuiltin: false,
      isTemplate: false,
    },
    {
      id: 'builtin',
      type: 'ssh',
      name: 'Builtin',
      options: {},
      isBuiltin: true,
      isTemplate: false,
    },
  ]

  it('lists only eligible SSH display names without leaking sensitive fields', () => {
    const rows = buildSecureMcpSettingsRows(profiles, ['ssh-1'])
    expect(rows).toEqual([
      {
        id: 'ssh-1',
        displayName: 'Prod',
        selected: true,
        openSession: false,
        operationTier: 'none',
        grantStale: false,
      },
      {
        id: 'ssh-2',
        displayName: 'Hidden',
        selected: false,
        openSession: false,
        operationTier: 'none',
        grantStale: false,
      },
    ])
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toMatch(/secret\.example|hidden\.example|root|"options"|"host"/)
  })

  it('marks a grant stale when the profile digest no longer matches', () => {
    const fresh = stableProfileDigest(profiles[0]!)
    const rows = buildSecureMcpSettingsRows(profiles, ['ssh-1'], [
      {
        profileId: 'ssh-1',
        openSession: true,
        operationTier: 'full',
        profileDigest: 'b'.repeat(64),
        updatedAt: '2026-10-19T00:00:00.000Z',
      },
    ])
    expect(rows[0]).toMatchObject({
      openSession: true,
      operationTier: 'full',
      grantStale: true,
    })

    const current = buildSecureMcpSettingsRows(profiles, ['ssh-1'], [
      {
        profileId: 'ssh-1',
        openSession: true,
        operationTier: 'readonly',
        profileDigest: fresh,
        updatedAt: '2026-10-19T00:00:00.000Z',
      },
    ])
    expect(current[0]).toMatchObject({ operationTier: 'readonly', grantStale: false })
  })
})

describe('Secure MCP settings grant management', () => {
  it('persists a tier and clears it when the profile is removed from the whitelist', async () => {
    const harness = createTabbyConfigProxyHarness()
    const save = vi.fn(async () => undefined)
    const config = { store: harness.store, save }
    const profile: PartialProfile<Profile> = {
      id: 'ssh-1',
      type: 'ssh',
      name: 'Prod',
      options: { host: 'secret.example' },
      isBuiltin: false,
      isTemplate: false,
    }
    const profilesService = {
      getProfiles: vi.fn(async () => [profile]),
    }
    const store = new PermanentAuthorizationStore(config as never)
    const component = new SecureMcpSettingsComponent(
      config as never,
      profilesService as never,
      store,
    )

    await component.ngOnInit()
    expect(component.rows[0]).toMatchObject({ selected: false, operationTier: 'none' })

    await component.onToggle(component.rows[0]!, true)
    await component.onTierChange(component.rows[0]!, 'readwrite')

    expect(component.rows[0]).toMatchObject({
      selected: true,
      operationTier: 'readwrite',
      openSession: false,
      grantStale: false,
    })
    expect(readPermanentAuthorizations(harness.store)[0]).toMatchObject({
      profileId: 'ssh-1',
      operationTier: 'readwrite',
      profileDigest: stableProfileDigest(profile),
    })

    await component.onToggle(component.rows[0]!, false)
    expect(readPermanentAuthorizations(harness.store)).toEqual([])
  })
})
