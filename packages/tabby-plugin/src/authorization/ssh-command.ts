import { Buffer } from 'node:buffer'

import {
  evaluateStructuredOperation,
  type GrantedOperationTier,
  type SshCommandClass,
} from './operation-tier-policy'

export const MAX_SSH_COMMAND_BYTES = 512

const READ_ONLY_PROGRAMS = new Set([
  'cat',
  'ls',
  'pwd',
  'whoami',
  'id',
  'uname',
  'date',
  'df',
  'du',
  'ps',
  'uptime',
  'hostname',
  'printenv',
  'env',
  'stat',
  'file',
  'head',
  'tail',
  'wc',
  'grep',
  'egrep',
  'fgrep',
  'which',
  'dirname',
  'basename',
  'readlink',
  'realpath',
  'free',
  'lsblk',
  'lscpu',
  'echo',
  'printf',
  'true',
  'false',
  'groups',
  'w',
  'ss',
  'netstat',
  'test',
  '[',
])

const READ_WRITE_PROGRAMS = new Set([
  'mkdir',
  'rmdir',
  'touch',
  'cp',
  'mv',
  'ln',
  'tee',
  'truncate',
  'install',
])

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
  const command = raw.trim()
  if (!command || Buffer.byteLength(command, 'utf8') > MAX_SSH_COMMAND_BYTES) {
    return null
  }
  const tokens = tokenizeSingleCommand(command)
  const program = tokens?.[0]
  if (!tokens || !program) {
    return null
  }
  return { command, program, commandClass: classifyProgram(program) }
}

function classifyProgram(program: string): SshCommandClass {
  if (program.includes('/') || program === '.' || program === '..') {
    return 'full_control'
  }
  if (READ_ONLY_PROGRAMS.has(program)) {
    return 'read_only'
  }
  if (READ_WRITE_PROGRAMS.has(program)) {
    return 'read_write'
  }
  return 'full_control'
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
