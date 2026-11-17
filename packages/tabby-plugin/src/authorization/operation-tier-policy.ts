import type { ApprovalMode, CommandRisk } from '@tabby-secure-mcp/ipc-contract/command-policy'

export const OPERATION_TIERS = ['ask', 'auto_edit', 'full'] as const
export type OperationTier = ApprovalMode
export type GrantedOperationTier = 'none' | ApprovalMode
export type SshCommandClass = 'read_only' | 'read_write' | 'full_control'
export type StructuredOperationClass = SshCommandClass
export const SSH_COMMAND_AUTHORIZATION_SUBJECT = 'ssh_command' as const

export interface OperationTierPolicy {
  mode: ApprovalMode
  label: string
  auto_approve: 'none' | 'low_risk' | 'all'
}

export const OPERATION_TIER_POLICY: readonly OperationTierPolicy[] = [
  { mode: 'ask', label: '请求审批', auto_approve: 'none' },
  { mode: 'auto_edit', label: '自动编辑', auto_approve: 'low_risk' },
  { mode: 'full', label: '完全访问', auto_approve: 'all' },
]

export function isGrantedOperationTier(value: string): value is GrantedOperationTier {
  return value === 'none' || (OPERATION_TIERS as readonly string[]).includes(value)
}

export type StructuredOperationDecision =
  | { allowed: true; tier: ApprovalMode }
  | { allowed: false; reason: 'not_granted' | 'tier_insufficient' | 'grant_stale' }

export function evaluateStructuredOperation(input: {
  grantedTier: GrantedOperationTier
  operationClass: StructuredOperationClass
  risk?: CommandRisk
  grantFresh: boolean
}): StructuredOperationDecision {
  if (!input.grantFresh) return { allowed: false, reason: 'grant_stale' }
  if (input.grantedTier === 'none') return { allowed: false, reason: 'not_granted' }
  if (input.grantedTier === 'full' || (input.grantedTier === 'auto_edit' && input.risk === 'low')) return { allowed: true, tier: input.grantedTier }
  return { allowed: false, reason: 'tier_insufficient' }
}

export function publicOperationTierPolicy(): OperationTierPolicy[] {
  return OPERATION_TIER_POLICY.map(policy => ({ ...policy }))
}
