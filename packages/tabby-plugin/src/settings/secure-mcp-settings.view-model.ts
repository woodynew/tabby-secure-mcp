import type { PartialProfile, Profile } from 'tabby-core'
import type { ApprovedCommandRule } from '@tabby-secure-mcp/ipc-contract/command-policy'

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

export interface CommandSetEditor {
  scope: 'global' | 'local'
  targetLabel: string
  rules: ApprovedCommandRule[]
  inheritDefaults: boolean
  stale: boolean
  ruleKind: 'family' | 'exact'
  ruleText: string
  editingIndex: number | null
  pasteText: string
  importPreview: ApprovedCommandRule[] | null
  clearPending: boolean
  error: string | null
  detail: string
}

export interface CommandSetRuleRow {
  key: string
  kind: ApprovedCommandRule['kind']
  label: string
  global: boolean
  local: boolean
  localIndex: number | null
}

export const SETTINGS_OPERATION_TIER_OPTIONS: ReadonlyArray<{
  value: GrantedOperationTier
  labelKey: string
}> = [
  { value: 'none', labelKey: 'secureMcp.commandDisabled' },
  { value: 'ask', labelKey: 'secureMcp.modeAsk' },
  { value: 'auto_edit', labelKey: 'secureMcp.modeAutoEdit' },
  { value: 'full', labelKey: 'secureMcp.modeFull' },
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
