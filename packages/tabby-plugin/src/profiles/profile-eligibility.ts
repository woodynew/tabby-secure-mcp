import type { PartialProfile, Profile } from 'tabby-core'

export function isEligibleSshProfile(profile: PartialProfile<Profile>): boolean {
  if (profile.type !== 'ssh') {
    return false
  }
  if (profile.isBuiltin) {
    return false
  }
  if (profile.isTemplate) {
    return false
  }
  const id = profile.id
  return typeof id === 'string' && id.trim().length > 0
}

export function readEligibleSshDisplayName(profile: PartialProfile<Profile>): string | null {
  if (!isEligibleSshProfile(profile)) {
    return null
  }
  const name = profile.name
  if (typeof name !== 'string' || name.trim().length === 0) {
    return null
  }
  return name
}
