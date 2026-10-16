import { describe, expect, it } from 'vitest'
import type { PartialProfile, Profile } from 'tabby-core'

import { secureMcpSettingsTabMetadata } from '../src/settings/secure-mcp-settings.metadata'
import { buildSecureMcpSettingsRows } from '../src/settings/secure-mcp-settings.view-model'

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
      { id: 'ssh-1', displayName: 'Prod', selected: true },
      { id: 'ssh-2', displayName: 'Hidden', selected: false },
    ])
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toMatch(/secret\.example|hidden\.example|root|"options"|"host"/)
  })
})
