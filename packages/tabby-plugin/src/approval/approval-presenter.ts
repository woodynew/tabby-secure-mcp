import type { AnalyzedSshCommand } from '@tabby-secure-mcp/ipc-contract/command-policy'
import { sanitizeApprovalDisplayText } from './display-sanitizer'

export type ApprovalDecision = 'allow' | 'deny'
export type CommandApprovalDecision = ApprovalDecision | 'remember'

export interface ApprovalPresentationContext {
  signal: AbortSignal
  deadlineMonotonicMs: number
  remainingSeconds(): number
}

export interface PairingApprovalViewModel {
  clientIdentity: string
  companionLabel: string
  remainingSeconds: number
  allowDuration?: boolean
}

export interface OpenApprovalViewModel {
  clientIdentity: string
  toolName: string
  targetDisplayName: string
  operationDisplay: string
  remainingSeconds: number
}

export interface CommandApprovalViewModel extends OpenApprovalViewModel {
  risk: 'low' | 'high' | 'unknown'
  riskReasonKey: string
  ruleKind: 'family' | 'exact'
  ruleText: string
  ruleFingerprint: string
  allowRemember: boolean
  approveConnection: boolean
}

export function buildCommandApprovalDetails(analysis: AnalyzedSshCommand): {
  riskReasonKey: string
  ruleKind: 'family' | 'exact'
  ruleText: string
  ruleFingerprint: string
} {
  const rule = analysis.rule
  return {
    riskReasonKey: 'secureMcp.commandReason_' + analysis.reasonCode,
    ruleKind: rule.kind,
    ruleText: rule.kind === 'family' ? rule.argv.join(' ') : rule.program,
    ruleFingerprint: rule.kind === 'exact' ? rule.hash : '',
  }
}

export interface ApprovalPresenter {
  presentPairing(
    viewModel: PairingApprovalViewModel,
    context: ApprovalPresentationContext,
  ): Promise<ApprovalDecision>

  presentOpen(viewModel: OpenApprovalViewModel, context: ApprovalPresentationContext): Promise<ApprovalDecision>
  presentCommand?(viewModel: CommandApprovalViewModel, context: ApprovalPresentationContext): Promise<CommandApprovalDecision>
}

export function buildOpenApprovalViewModel(input: {
  clientIdentity: string
  toolName: string
  targetDisplayName: string
  operation: unknown
  remainingSeconds: number
}): OpenApprovalViewModel {
  return {
    clientIdentity: sanitizeApprovalDisplayText(input.clientIdentity),
    toolName: sanitizeApprovalDisplayText(input.toolName),
    targetDisplayName: sanitizeApprovalDisplayText(input.targetDisplayName),
    operationDisplay: sanitizeApprovalDisplayText(JSON.stringify(input.operation, null, 2)),
    remainingSeconds: input.remainingSeconds,
  }
}

export function buildPairingApprovalViewModel(input: {
  clientIdentity: string
  companionLabel: string
  remainingSeconds: number
}): PairingApprovalViewModel {
  return {
    clientIdentity: sanitizeApprovalDisplayText(input.clientIdentity),
    companionLabel: sanitizeApprovalDisplayText(input.companionLabel),
    remainingSeconds: input.remainingSeconds,
  }
}
