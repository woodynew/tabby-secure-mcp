import type { PartialProfile, Profile, ProfilesService } from 'tabby-core'

const PROXY_METHODS = new Set(['__getValue', '__setValue', '__getDefault', '__setDefaults', '__cleanup'])

export function resolveEffectiveProfile(
  profile: PartialProfile<Profile>,
  profiles: Pick<ProfilesService, 'getConfigProxyForProfile'>,
): PartialProfile<Profile> {
  const effective = profiles.getConfigProxyForProfile(structuredClone(profile))
  const copy = (value: unknown, seen = new Set<object>()): any => {
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
        throw new Error('unsupported effective profile value')
      }
      return value
    }
    if (seen.has(value)) {
      throw new Error('cyclic effective profile')
    }
    seen.add(value)
    const result: any = Array.isArray(value) ? [] : {}
    for (const key of Object.keys(value)) {
      if (PROXY_METHODS.has(key)) {
        continue
      }
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new Error('unsafe effective profile key')
      }
      result[key] = copy((value as Record<string, unknown>)[key], seen)
    }
    seen.delete(value)
    return Object.freeze(result)
  }
  return copy(effective)
}
