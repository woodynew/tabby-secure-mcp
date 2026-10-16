import { createHmac } from 'node:crypto'

import type { ProfileSecuritySnapshot } from './profile-security-snapshot'

export interface OpenApprovalBinding {
  toolName: string
  profileRef: string
  snapshot: ProfileSecuritySnapshot
  operation: unknown
  leaseEpoch: number
  requestId: string
  deadlineMonotonicMs: number
}

export function buildOpenApprovalDigest(binding: OpenApprovalBinding, runKey: Uint8Array): string {
  const canonical = JSON.stringify({
    deadline_monotonic_ms: binding.deadlineMonotonicMs,
    lease_epoch: binding.leaseEpoch,
    operation: binding.operation,
    profile_ref: binding.profileRef,
    request_id: binding.requestId,
    snapshot: binding.snapshot,
    tool: binding.toolName,
  })
  return createHmac('sha256', Buffer.from(runKey)).update(canonical, 'utf8').digest('hex')
}
