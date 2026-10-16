import { isProfileRef } from '../profiles/profile-ref'

const REQUEST_ID_PATTERN = /^[0-9a-fA-F]{32}$/
const OPEN_TOOL_NAME = 'open_authorized_ssh_profile'

export function isValidOpenRequestId(requestId: string): boolean {
  return REQUEST_ID_PATTERN.test(requestId)
}

export function isValidLeaseEpoch(leaseEpoch: number): boolean {
  return Number.isInteger(leaseEpoch) && leaseEpoch > 0
}

export interface OpenAuthorizedOperation {
  method: 'open_authorized_ssh_profile'
  params: {
    profile_ref: string
  }
}

export function validateOpenApprovalRequest(input: {
  requestId: string
  leaseEpoch: number
  profileRef: string
  toolName: string
  operation: OpenAuthorizedOperation
}): { ok: true } | { ok: false; reason: 'invalid_request' | 'invalid_profile_ref' } {
  if (!isValidOpenRequestId(input.requestId)) {
    return { ok: false, reason: 'invalid_request' }
  }
  if (!isValidLeaseEpoch(input.leaseEpoch)) {
    return { ok: false, reason: 'invalid_request' }
  }
  if (input.toolName !== OPEN_TOOL_NAME) {
    return { ok: false, reason: 'invalid_request' }
  }
  if (input.operation.method !== OPEN_TOOL_NAME) {
    return { ok: false, reason: 'invalid_request' }
  }
  if (input.operation.params.profile_ref !== input.profileRef) {
    return { ok: false, reason: 'invalid_request' }
  }
  if (!isProfileRef(input.profileRef)) {
    return { ok: false, reason: 'invalid_profile_ref' }
  }
  return { ok: true }
}

export function computeEffectiveOpenDeadline(receivedAtMonotonicMs: number, callerDeadlineMonotonicMs: number): number {
  const windowCap = receivedAtMonotonicMs + 30_000
  return Math.min(callerDeadlineMonotonicMs, windowCap)
}
