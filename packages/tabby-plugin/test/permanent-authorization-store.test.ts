import { describe, expect, it, vi } from 'vitest'
import type { PartialProfile, Profile } from 'tabby-core'

import { stableProfileDigest } from '../src/approval/profile-security-snapshot'
import { PermanentAuthorizationStore } from '../src/authorization/permanent-authorization-store'
import { readPermanentAuthorizations } from '../src/config/secure-mcp-config'
import { createTabbyConfigProxyHarness } from './tabby-config-proxy.harness'

const profile: PartialProfile<Profile> = {
  id: 'ssh-1',
  type: 'ssh',
  name: 'Prod',
  options: { host: 'secret.example', user: 'root' },
  isBuiltin: false,
  isTemplate: false,
}

describe('PermanentAuthorizationStore', () => {
  it('resets the operation tier when a remembered open sees a new profile digest', async () => {
    const harness = createTabbyConfigProxyHarness()
    const config = { store: harness.store, save: vi.fn(async () => undefined) }
    harness.store.secureMcp.authorizedSshProfileIds = ['ssh-1']
    const store = new PermanentAuthorizationStore(config as never)
    const digest = stableProfileDigest(profile)

    await store.setManagedGrant('ssh-1', profile, { openSession: false, operationTier: 'full' })
    await store.rememberOpen('ssh-1', 'c'.repeat(64))

    expect(readPermanentAuthorizations(harness.store)).toEqual([
      expect.objectContaining({
        profileId: 'ssh-1',
        openSession: true,
        operationTier: 'none',
        profileDigest: 'c'.repeat(64),
      }),
    ])
    expect(store.effectiveGrant('ssh-1', digest)).toEqual({ openSession: false, operationTier: 'none' })
    expect(store.effectiveGrant('ssh-1', 'c'.repeat(64))).toEqual({
      openSession: true,
      operationTier: 'none',
    })
  })

  it('deletes a grant that no longer allows an open or an operation tier', async () => {
    const harness = createTabbyConfigProxyHarness()
    const config = { store: harness.store, save: vi.fn(async () => undefined) }
    harness.store.secureMcp.authorizedSshProfileIds = ['ssh-1']
    const store = new PermanentAuthorizationStore(config as never)

    await store.setManagedGrant('ssh-1', profile, { openSession: true, operationTier: 'readonly' })
    await store.setManagedGrant('ssh-1', profile, { openSession: false, operationTier: 'none' })

    expect(store.list()).toEqual([])
    expect(store.effectiveGrant('ssh-1', stableProfileDigest(profile))).toEqual({
      openSession: false,
      operationTier: 'none',
    })
  })
})
