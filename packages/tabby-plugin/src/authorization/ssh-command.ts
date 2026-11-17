import { analyzeSshCommand, type AnalyzedSshCommand } from '@tabby-secure-mcp/ipc-contract/command-policy'
import { evaluateStructuredOperation, type GrantedOperationTier, type SshCommandClass } from './operation-tier-policy'

export { MAX_SSH_COMMAND_BYTES, quoteShellArgument } from '@tabby-secure-mcp/ipc-contract/command-policy'
export type SingleSshCommandFailure = 'not_a_single_command' | 'not_granted' | 'tier_insufficient' | 'grant_stale'
export type AuthorizedSshCommand =
  | { ok: true; command: string; commandClass: SshCommandClass }
  | { ok: false; reason: SingleSshCommandFailure }

export function authorizeSingleSshCommand(input: {
  command: string
  grantedTier: GrantedOperationTier
  grantFresh: boolean
}): AuthorizedSshCommand {
  const parsed = parseSingleSshCommand(input.command)
  if (!parsed) return { ok: false, reason: 'not_a_single_command' }
  const decision = evaluateStructuredOperation({
    grantedTier: input.grantedTier,
    operationClass: parsed.commandClass,
    risk: parsed.risk,
    grantFresh: input.grantFresh,
  })
  if (!decision.allowed) return { ok: false, reason: decision.reason }
  return { ok: true, command: parsed.command, commandClass: parsed.commandClass }
}

export function parseSingleSshCommand(raw: string): AnalyzedSshCommand | null {
  return analyzeSshCommand(raw)
}
