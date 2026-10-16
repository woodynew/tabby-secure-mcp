import { sanitizeApprovalDisplayText } from './display-sanitizer'

export type ApprovalDecision = 'allow' | 'deny'

export interface ApprovalPresentationContext {
  signal: AbortSignal
  deadlineMonotonicMs: number
  remainingSeconds(): number
}

export interface PairingApprovalViewModel {
  clientIdentity: string
  companionLabel: string
  remainingSeconds: number
}

export interface OpenApprovalViewModel {
  clientIdentity: string
  toolName: string
  targetDisplayName: string
  operationDisplay: string
  remainingSeconds: number
}

export interface ApprovalPresenter {
  presentPairing(
    viewModel: PairingApprovalViewModel,
    context: ApprovalPresentationContext,
  ): Promise<ApprovalDecision>

  presentOpen(viewModel: OpenApprovalViewModel, context: ApprovalPresentationContext): Promise<ApprovalDecision>
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
