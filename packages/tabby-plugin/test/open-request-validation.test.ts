import { describe, expect, it } from 'vitest'

import {
  computeEffectiveOpenDeadline,
  isValidOpenRequestId,
  validateOpenApprovalRequest,
} from '../src/approval/open-request-validation'

describe('open request validation', () => {
  it('accepts 128-bit request ids as 32-byte hex', () => {
    expect(isValidOpenRequestId('abcdef0123456789abcdef0123456789')).toBe(true)
    expect(isValidOpenRequestId('ABCDEF0123456789ABCDEF0123456789')).toBe(true)
    expect(isValidOpenRequestId('req-1')).toBe(false)
    expect(isValidOpenRequestId('abc')).toBe(false)
  })

  it('caps effective deadline to receivedAt + 30_000ms', () => {
    const receivedAt = 1_000
    expect(computeEffectiveOpenDeadline(receivedAt, receivedAt + 60_000)).toBe(receivedAt + 30_000)
    expect(computeEffectiveOpenDeadline(receivedAt, receivedAt + 10_000)).toBe(receivedAt + 10_000)
  })

  it('requires tool, method, profile_ref binding, and valid profile ref', () => {
    const profileRef = 'abcdef0123456789abcdef0123456789'
    const valid = validateOpenApprovalRequest({
      requestId: '11111111111111111111111111111111',
      leaseEpoch: 1,
      profileRef,
      toolName: 'open_authorized_ssh_profile',
      operation: {
        method: 'open_authorized_ssh_profile',
        params: { profile_ref: profileRef },
      },
    })
    expect(valid).toEqual({ ok: true })

    expect(
      validateOpenApprovalRequest({
        requestId: '11111111111111111111111111111111',
        leaseEpoch: 0,
        profileRef,
        toolName: 'open_authorized_ssh_profile',
        operation: {
          method: 'open_authorized_ssh_profile',
          params: { profile_ref: profileRef },
        },
      }),
    ).toEqual({ ok: false, reason: 'invalid_request' })
  })
})
