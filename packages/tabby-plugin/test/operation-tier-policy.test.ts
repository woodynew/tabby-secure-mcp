import { describe, expect, it } from 'vitest'
import { evaluateStructuredOperation, isGrantedOperationTier, publicOperationTierPolicy } from '../src/authorization/operation-tier-policy'

describe('SSH command approval mode policy', () => {
  it('publishes real modes and automatic approval behavior', () => {
    expect(publicOperationTierPolicy()).toEqual([
      { mode: 'ask', label: '请求审批', auto_approve: 'none' },
      { mode: 'auto_edit', label: '自动编辑', auto_approve: 'low_risk' },
      { mode: 'full', label: '完全访问', auto_approve: 'all' },
    ])
    for (const mode of ['none', 'ask', 'auto_edit', 'full']) expect(isGrantedOperationTier(mode)).toBe(true)
    for (const mode of ['readonly', 'readwrite', 'invalid']) expect(isGrantedOperationTier(mode)).toBe(false)
  })

  it('auto approves only low risk in auto edit and always asks in ask', () => {
    for (const risk of ['low', 'high', 'unknown'] as const) {
      expect(evaluateStructuredOperation({ grantedTier: 'ask', operationClass: 'read_only', risk, grantFresh: true })).toEqual({ allowed: false, reason: 'tier_insufficient' })
      expect(evaluateStructuredOperation({ grantedTier: 'auto_edit', operationClass: 'read_write', risk, grantFresh: true }).allowed).toBe(risk === 'low')
      expect(evaluateStructuredOperation({ grantedTier: 'full', operationClass: 'full_control', risk, grantFresh: true }).allowed).toBe(true)
    }
    expect(evaluateStructuredOperation({ grantedTier: 'auto_edit', operationClass: 'read_only', grantFresh: true }).allowed).toBe(false)
  })

  it('fails closed for disabled or stale grants', () => {
    expect(evaluateStructuredOperation({ grantedTier: 'none', operationClass: 'read_only', risk: 'low', grantFresh: true })).toEqual({ allowed: false, reason: 'not_granted' })
    expect(evaluateStructuredOperation({ grantedTier: 'full', operationClass: 'read_only', risk: 'low', grantFresh: false })).toEqual({ allowed: false, reason: 'grant_stale' })
  })
})
