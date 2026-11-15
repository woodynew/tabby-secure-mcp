import { Buffer } from 'node:buffer'

import {
  evaluateStructuredOperation,
  type GrantedOperationTier,
  type SshCommandClass,
} from './operation-tier-policy'

export const MAX_SSH_COMMAND_BYTES = 512

const NO_ARGUMENT_READS = new Set(['pwd', 'whoami', 'id', 'uptime'])

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
  if (!parsed) {
    return { ok: false, reason: 'not_a_single_command' }
  }
  const decision = evaluateStructuredOperation({
    grantedTier: input.grantedTier,
    operationClass: parsed.commandClass,
    grantFresh: input.grantFresh,
  })
  if (!decision.allowed) {
    return { ok: false, reason: decision.reason }
  }
  return { ok: true, command: parsed.command, commandClass: parsed.commandClass }
}

export function parseSingleSshCommand(
  raw: string,
): { command: string; program: string; commandClass: SshCommandClass } | null {
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(raw)) {
    return null
  }
  const command = raw.trim()
  if (!command || Buffer.byteLength(command, 'utf8') > MAX_SSH_COMMAND_BYTES) {
    return null
  }
  const tokens = tokenizeSingleCommand(command)
  const program = tokens?.[0]
  if (!tokens || !program) {
    return null
  }
  const classified = classifyProgram(program, tokens.slice(1))
  const encoded = classified.args.map(quoteShellArgument).join(' ')
  return {
    command: `${classified.commandClass === 'full_control' ? '' : 'command -p '}${quoteShellArgument(program)}${encoded ? ` ${encoded}` : ''}`,
    program,
    commandClass: classified.commandClass,
  }
}

export function quoteShellArgument(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function classifyProgram(program: string, args: string[]): { commandClass: SshCommandClass; args: string[] } {
  const full = { commandClass: 'full_control' as const, args }
  if (NO_ARGUMENT_READS.has(program) && args.length === 0) {
    return { commandClass: 'read_only', args }
  }
  if (program === 'uname' && args.every(arg => /^-[asnrvm]+$/.test(arg))) {
    return { commandClass: 'read_only', args }
  }
  const policies: Record<string, { flags: string; minimum: number; commandClass: SshCommandClass }> = {
    ls: { flags: 'aAlhdFnrtR', minimum: 0, commandClass: 'read_only' },
    cat: { flags: '', minimum: 1, commandClass: 'read_only' },
    wc: { flags: 'clmw', minimum: 0, commandClass: 'read_only' },
    mkdir: { flags: 'p', minimum: 1, commandClass: 'read_write' },
    touch: { flags: '', minimum: 1, commandClass: 'read_write' },
    cp: { flags: 'R', minimum: 2, commandClass: 'read_write' },
    mv: { flags: '', minimum: 2, commandClass: 'read_write' },
  }
  const policy = Object.prototype.hasOwnProperty.call(policies, program) ? policies[program] : undefined
  if (!policy) return full
  const flags: string[] = []
  const paths: string[] = []
  let operands = false
  for (const arg of args) {
    if (!operands && arg === '--') {
      operands = true
    } else if (!operands && arg.startsWith('-')) {
      if (!policy.flags || !new RegExp(`^-[${policy.flags}]+$`).test(arg)) return full
      flags.push(arg)
    } else {
      operands = true
      if (arg.startsWith('-') && !args.includes('--')) return full
      paths.push(arg)
    }
  }
  if (paths.length < policy.minimum) return full
  return { commandClass: policy.commandClass, args: [...flags, '--', ...paths] }
}

function tokenizeSingleCommand(command: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quoting: '"' | "'" | null = null
  let started = false

  const push = (): void => {
    tokens.push(current)
    current = ''
    started = false
  }

  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index] ?? ''
    if (quoting === "'") {
      if (ch === "'") {
        quoting = null
      } else {
        current += ch
      }
      started = true
      continue
    }
    if (quoting === '"') {
      if (ch === '"') {
        quoting = null
        started = true
        continue
      }
      if (ch === '\\') {
        const next = command[index + 1]
        if (next === undefined || next === '\n' || next === '\r' || next === '$' || next === '`') {
          return null
        }
        current += next
        index += 1
        started = true
        continue
      }
      if (ch === '$' || ch === '`' || ch === '\n' || ch === '\r') {
        return null
      }
      current += ch
      started = true
      continue
    }
    if (ch === '\\') {
      const next = command[index + 1]
      if (next === undefined || next === '\n' || next === '\r') {
        return null
      }
      current += next
      index += 1
      started = true
      continue
    }
    if (ch === "'" || ch === '"') {
      quoting = ch
      started = true
      continue
    }
    if ('$`;|&<>()\n\r#!'.includes(ch)) {
      return null
    }
    if (ch === ' ' || ch === '\t') {
      if (started) {
        push()
      }
      continue
    }
    current += ch
    started = true
  }

  if (quoting) {
    return null
  }
  if (started) {
    push()
  }
  return tokens.length > 0 ? tokens : null
}
