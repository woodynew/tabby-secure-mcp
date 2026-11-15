import type { PartialProfile, Profile } from 'tabby-core'

import { stableProfileDigest } from '../approval/profile-security-snapshot'
import type { GrantedOperationTier } from '../authorization/operation-tier-policy'
import type { StoredPermanentAuthorization } from '../config/secure-mcp-config'
import { readEligibleSshDisplayName, isEligibleSshProfile } from '../profiles/profile-eligibility'

export interface SecureMcpSettingsRow {
  id: string
  displayName: string
  selected: boolean
  openSession: boolean
  operationTier: GrantedOperationTier
  grantStale: boolean
}

export const SETTINGS_OPERATION_TIER_OPTIONS: ReadonlyArray<{
  value: GrantedOperationTier
  labelKey: string
}> = [
  { value: 'none', labelKey: 'secureMcp.tierNone' },
  { value: 'readonly', labelKey: 'secureMcp.tierReadOnly' },
  { value: 'readwrite', labelKey: 'secureMcp.tierReadWrite' },
  { value: 'full', labelKey: 'secureMcp.tierFull' },
]

export function buildSecureMcpSettingsRows(
  profiles: readonly PartialProfile<Profile>[],
  authorizedIds: readonly string[],
  grants: readonly StoredPermanentAuthorization[] = [],
): SecureMcpSettingsRow[] {
  const authorized = new Set(authorizedIds)
  const grantsById = new Map(grants.map(grant => [grant.profileId, grant]))
  const rows: SecureMcpSettingsRow[] = []
  for (const profile of profiles) {
    if (!isEligibleSshProfile(profile)) {
      continue
    }
    const displayName = readEligibleSshDisplayName(profile)
    const id = profile.id
    if (!displayName || typeof id !== 'string') {
      continue
    }
    const selected = authorized.has(id)
    const grant = selected ? grantsById.get(id) : undefined
    let grantStale = false
    if (grant) {
      try {
        grantStale = stableProfileDigest(profile) !== grant.profileDigest
      } catch {
        grantStale = true
      }
    }
    rows.push({
      id,
      displayName,
      selected,
      openSession: grant?.openSession ?? false,
      operationTier: grant?.operationTier ?? 'none',
      grantStale,
    })
  }
  return rows
}
