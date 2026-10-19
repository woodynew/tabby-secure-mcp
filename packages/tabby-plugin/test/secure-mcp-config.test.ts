import { describe, expect, it, vi } from 'vitest'

import {
  dedupeAuthorizedSshProfileIds,
  effectivePermanentAuthorization,
  persistPermanentAuthorizations,
  readAuthorizedSshProfileIds,
  readPermanentAuthorizations,
  persistAuthorizedSshProfileIds,
  secureMcpConfigDefaults,
  writeAuthorizedSshProfileIdsToStore,
  type StoredPermanentAuthorization,
} from '../src/config/secure-mcp-config'
import { createTabbyConfigProxyHarness } from './tabby-config-proxy.harness'

describe('secure MCP config helpers', () => {
  it('exposes ConfigProvider defaults with an empty whitelist', () => {
    expect(secureMcpConfigDefaults).toEqual({
      secureMcp: {
        authorizedSshProfileIds: [],
        permanentAuthorizations: [],
      },
    })
  })

  it('reads an empty whitelist from missing or malformed config', () => {
    expect(readAuthorizedSshProfileIds(undefined)).toEqual([])
    expect(readAuthorizedSshProfileIds(null)).toEqual([])
    expect(readAuthorizedSshProfileIds({})).toEqual([])
    expect(readAuthorizedSshProfileIds({ secureMcp: null })).toEqual([])
    expect(readAuthorizedSshProfileIds({ secureMcp: { authorizedSshProfileIds: 'nope' } })).toEqual([])
    expect(readAuthorizedSshProfileIds({ secureMcp: { authorizedSshProfileIds: [1, '', '  ', null] } })).toEqual([])
  })

  it('deduplicates and trims persisted profile ids', () => {
    expect(dedupeAuthorizedSshProfileIds(['a', ' a ', 'b', 'a', 'b'])).toEqual(['a', 'b'])
  })

  it('persists a deduped whitelist via ConfigService.store then save()', async () => {
    const harness = createTabbyConfigProxyHarness()
    const save = vi.fn(async () => undefined)
    const config = { store: harness.store, save }

    const saved = await persistAuthorizedSshProfileIds(config, ['x', 'x', ' y '])

    expect(saved).toEqual(['x', 'y'])
    expect(harness.store.secureMcp.authorizedSshProfileIds).toEqual(['x', 'y'])
    expect(readAuthorizedSshProfileIds(harness.store)).toEqual(['x', 'y'])
    expect(harness.snapshotPersisted().secureMcp).toEqual({ authorizedSshProfileIds: ['x', 'y'] })
    expect(save).toHaveBeenCalledOnce()
  })

  it('persists through ConfigProxy leaf assignment, not structural replacement (Tabby regression)', async () => {
    const harness = createTabbyConfigProxyHarness()
    const save = vi.fn(async () => undefined)
    const config = { store: harness.store, save }
    const storeRecord = config.store as Record<string, unknown>
    const plainSection: Record<string, unknown> = { authorizedSshProfileIds: ['should-not-persist'] }

    expect(() => {
      storeRecord.secureMcp = plainSection
    }).toThrow(/only a getter/i)
    expect(harness.snapshotPersisted().secureMcp).toBeUndefined()

    const saved = await persistAuthorizedSshProfileIds(config, ['ssh-profile-1'])
    expect(saved).toEqual(['ssh-profile-1'])
    expect(harness.snapshotPersisted().secureMcp).toEqual({
      authorizedSshProfileIds: ['ssh-profile-1'],
    })
    expect(readAuthorizedSshProfileIds(harness.store)).toEqual(['ssh-profile-1'])
    expect(writeAuthorizedSshProfileIdsToStore(harness.store, ['ssh-profile-1'])).toEqual([
      'ssh-profile-1',
    ])
  })

  it('stores a permanent grant and drops it when the profile leaves the whitelist', async () => {
    const harness = createTabbyConfigProxyHarness()
    const save = vi.fn(async () => undefined)
    const config = { store: harness.store, save }
    await persistAuthorizedSshProfileIds(config, ['ssh-profile-1'])
    const grant: StoredPermanentAuthorization = {
      profileId: 'ssh-profile-1',
      openSession: true,
      operationTier: 'readonly',
      profileDigest: 'a'.repeat(64),
      updatedAt: '2026-10-19T00:00:00.000Z',
    }

    const saved = await persistPermanentAuthorizations(config, [grant, { ...grant, profileId: 'other' }])

    expect(saved).toEqual([grant])
    expect(readPermanentAuthorizations(harness.store)).toEqual([grant])
    expect(effectivePermanentAuthorization(grant, grant.profileDigest).openSession).toBe(true)
    expect(effectivePermanentAuthorization(grant, 'b'.repeat(64)).operationTier).toBe('none')

    await persistAuthorizedSshProfileIds(config, [])
    expect(readPermanentAuthorizations(harness.store)).toEqual([])
    expect(readAuthorizedSshProfileIds(harness.store)).toEqual([])
    const persisted = harness.snapshotPersisted().secureMcp as Record<string, unknown> | undefined
    expect(persisted?.permanentAuthorizations).toBeUndefined()
    expect(persisted?.authorizedSshProfileIds).toBeUndefined()
  })
})
