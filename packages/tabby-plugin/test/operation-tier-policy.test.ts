import { describe, expect, it } from 'vitest'

import {
  evaluateStructuredOperation,
  publicOperationTierPolicy,
  tierAllows,
} from '../src/authorization/operation-tier-policy'

describe('SSH command tier policy', () => {
  it('authorizes SSH command classes and lets a higher tier include lower classes', () => {
    expect(publicOperationTierPolicy().map((entry) => entry.subject)).toEqual([
      'ssh_command',
      'ssh_command',
      'ssh_command',
    ])
    expect(publicOperationTierPolicy().map((entry) => entry.effect)).toEqual([
      'read_only',
      'read_write',
      'full_control',
    ])
    expect(
      evaluateStructuredOperation({
        grantedTier: 'readonly',
        operationClass: 'read_only',
        grantFresh: true,
      }),
    ).toEqual({ allowed: true, tier: 'readonly' })
    expect(
      evaluateStructuredOperation({
        grantedTier: 'readonly',
        operationClass: 'read_write',
        grantFresh: true,
      }),
    ).toEqual({ allowed: false, reason: 'tier_insufficient' })
    expect(
      evaluateStructuredOperation({
        grantedTier: 'full',
        operationClass: 'full_control',
        grantFresh: true,
      }),
    ).toEqual({ allowed: true, tier: 'full' })
  })

  it('orders low, medium, and high as readonly, readwrite, and full', () => {
    expect(publicOperationTierPolicy().map((entry) => entry.label)).toEqual([
      '低级 · 只读',
      '中级 · 读写',
      '高级 · 完全控制',
    ])
    expect(tierAllows('full', 'readonly')).toBe(true)
    expect(tierAllows('readonly', 'readwrite')).toBe(false)
    expect(tierAllows('none', 'readonly')).toBe(false)
  })

  it('allows a fresh grant to cover its class and every lower class', () => {
    expect(
      evaluateStructuredOperation({
        grantedTier: 'readwrite',
        operationClass: 'read_only',
        grantFresh: true,
      }),
    ).toEqual({ allowed: true, tier: 'readonly' })
    expect(
      evaluateStructuredOperation({
        grantedTier: 'readwrite',
        operationClass: 'read_write',
        grantFresh: true,
      }),
    ).toEqual({ allowed: true, tier: 'readwrite' })
    expect(
      evaluateStructuredOperation({
        grantedTier: 'readwrite',
        operationClass: 'full_control',
        grantFresh: true,
      }),
    ).toEqual({ allowed: false, reason: 'tier_insufficient' })
  })

  it('treats a missing or stale grant as unauthorized', () => {
    expect(
      evaluateStructuredOperation({
        grantedTier: 'none',
        operationClass: 'read_only',
        grantFresh: true,
      }),
    ).toEqual({ allowed: false, reason: 'not_granted' })
    expect(
      evaluateStructuredOperation({
        grantedTier: 'full',
        operationClass: 'read_only',
        grantFresh: false,
      }),
    ).toEqual({ allowed: false, reason: 'grant_stale' })
  })
})
