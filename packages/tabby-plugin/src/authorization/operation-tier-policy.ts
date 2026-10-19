export const OPERATION_TIERS = ['readonly', 'readwrite', 'full'] as const

export type OperationTier = (typeof OPERATION_TIERS)[number]

export type GrantedOperationTier = 'none' | OperationTier

/** Class of SSH command authorized by a tier. A higher tier includes every lower class. */
export type SshCommandClass = 'read_only' | 'read_write' | 'full_control'

export type StructuredOperationClass = SshCommandClass

export const SSH_COMMAND_AUTHORIZATION_SUBJECT = 'ssh_command' as const

export interface OperationTierPolicy {
  tier: OperationTier
  rank: number
  label: string
  subject: typeof SSH_COMMAND_AUTHORIZATION_SUBJECT
  effect: SshCommandClass
  permits: readonly string[]
  denies: readonly string[]
}

export const OPERATION_TIER_POLICY: readonly OperationTierPolicy[] = [
  {
    tier: 'readonly',
    rank: 1,
    label: '低级 · 只读',
    subject: SSH_COMMAND_AUTHORIZATION_SUBJECT,
    effect: 'read_only',
    permits: ['read-only SSH commands'],
    denies: ['read-write SSH commands', 'full-control SSH commands'],
  },
  {
    tier: 'readwrite',
    rank: 2,
    label: '中级 · 读写',
    subject: SSH_COMMAND_AUTHORIZATION_SUBJECT,
    effect: 'read_write',
    permits: ['read-only SSH commands', 'read-write SSH commands'],
    denies: ['full-control SSH commands'],
  },
  {
    tier: 'full',
    rank: 3,
    label: '高级 · 完全控制',
    subject: SSH_COMMAND_AUTHORIZATION_SUBJECT,
    effect: 'full_control',
    permits: ['read-only SSH commands', 'read-write SSH commands', 'full-control SSH commands'],
    denies: [],
  },
]

const GRANTED_TIER_VALUES = ['none', 'readonly', 'readwrite', 'full'] as const

export function isGrantedOperationTier(value: string): value is GrantedOperationTier {
  return (GRANTED_TIER_VALUES as readonly string[]).includes(value)
}

const TIER_RANK: Record<GrantedOperationTier, number> = {
  none: 0,
  readonly: 1,
  readwrite: 2,
  full: 3,
}

const CLASS_TIER: Record<StructuredOperationClass, OperationTier> = {
  read_only: 'readonly',
  read_write: 'readwrite',
  full_control: 'full',
}

export type StructuredOperationDecision =
  | { allowed: true; tier: OperationTier }
  | { allowed: false; reason: 'not_granted' | 'tier_insufficient' | 'grant_stale' }

export function requiredTierForClass(operationClass: StructuredOperationClass): OperationTier {
  return CLASS_TIER[operationClass]
}

export function tierAllows(granted: GrantedOperationTier, required: OperationTier): boolean {
  return TIER_RANK[granted] >= TIER_RANK[required]
}

export function evaluateStructuredOperation(input: {
  grantedTier: GrantedOperationTier
  operationClass: StructuredOperationClass
  grantFresh: boolean
}): StructuredOperationDecision {
  if (!input.grantFresh) {
    return { allowed: false, reason: 'grant_stale' }
  }
  const required = requiredTierForClass(input.operationClass)
  if (input.grantedTier === 'none') {
    return { allowed: false, reason: 'not_granted' }
  }
  if (!tierAllows(input.grantedTier, required)) {
    return { allowed: false, reason: 'tier_insufficient' }
  }
  return { allowed: true, tier: required }
}

export function publicOperationTierPolicy(): Array<
  Pick<OperationTierPolicy, 'tier' | 'rank' | 'label' | 'subject' | 'effect'>
> {
  return OPERATION_TIER_POLICY.map(({ tier, rank, label, subject, effect }) => ({
    tier,
    rank,
    label,
    subject,
    effect,
  }))
}
