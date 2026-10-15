import type { PartialProfile, Profile } from 'tabby-core'

import { readEligibleSshDisplayName, isEligibleSshProfile } from '../profiles/profile-eligibility'

export interface SecureMcpSettingsRow {
  id: string
  displayName: string
  selected: boolean
}

export function buildSecureMcpSettingsRows(
  profiles: readonly PartialProfile<Profile>[],
  authorizedIds: readonly string[],
): SecureMcpSettingsRow[] {
  const authorized = new Set(authorizedIds)
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
    rows.push({
      id,
      displayName,
      selected: authorized.has(id),
    })
  }
  return rows
}
