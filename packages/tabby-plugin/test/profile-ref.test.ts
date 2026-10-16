import { describe, expect, it } from 'vitest'

import { generateProfileRef, isProfileRef } from '../src/profiles/profile-ref'

describe('profile_ref generation', () => {
  it('generates 128-bit opaque hex refs', () => {
    const first = generateProfileRef()
    const second = generateProfileRef()
    expect(isProfileRef(first)).toBe(true)
    expect(isProfileRef(second)).toBe(true)
    expect(first).not.toBe(second)
  })

  it('rejects malformed profile_ref strings', () => {
    expect(isProfileRef('')).toBe(false)
    expect(isProfileRef('abc')).toBe(false)
    expect(isProfileRef('g'.repeat(32))).toBe(false)
    expect(isProfileRef(`${'a'.repeat(31)}A`)).toBe(false)
    expect(isProfileRef(`${'a'.repeat(32)}extra`)).toBe(false)
  })
})
