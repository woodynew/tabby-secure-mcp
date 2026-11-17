import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

export type ApprovalMode = 'ask' | 'auto_edit' | 'full'
export type CommandRisk = 'low' | 'high' | 'unknown'
export type CommandRiskReasonCode = 'query' | 'relative_write' | 'write_path' | 'overwrite' | 'state_change' | 'unknown'
export type ApprovedCommandRule =
  | { kind: 'family'; version: 1; argv: string[] }
  | { kind: 'exact'; version: 1; program: string; hash: string }
export interface AnalyzedSshCommand {
  command: string
  program: string
  argv: string[]
  risk: CommandRisk
  reason: string
  reasonCode: CommandRiskReasonCode
  rule: ApprovedCommandRule
  commandClass: 'read_only' | 'read_write' | 'full_control'
}

export const MAX_SSH_COMMAND_BYTES = 512
export const MAX_APPROVED_COMMAND_RULES = 128
const MAX_COMMAND_SET_BYTES = 64 * 1024
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
const NO_ARGUMENT_READS = new Set(['pwd', 'whoami', 'id', 'uptime'])
const LOW_RISK_READ_ONLY_FAMILIES: readonly (readonly string[])[] = Object.freeze([
  ...[...NO_ARGUMENT_READS, 'uname', 'ls', 'cat', 'wc'].map(program => [program]),
  ['docker', 'ps'], ['ip', 'rule', 'show'], ['ip', '-4', 'rule', 'show'], ['ip', '-6', 'rule', 'show'],
  ['uci', 'get'], ['uci', '-q', 'get'], ['nft', 'list', 'table'],
].map(argv => Object.freeze(argv)))
const COMMAND_FAMILIES: readonly (readonly string[])[] = [...LOW_RISK_READ_ONLY_FAMILIES, ['mkdir'], ['touch']]
const FILE_POLICIES: Record<string, { flags: string; minimum: number }> = {
  ls: { flags: 'aAlhdFnrtR', minimum: 0 },
  cat: { flags: '', minimum: 1 },
  wc: { flags: 'clmw', minimum: 0 },
  mkdir: { flags: 'p', minimum: 1 },
  touch: { flags: '', minimum: 1 },
  cp: { flags: 'R', minimum: 2 },
  mv: { flags: '', minimum: 2 },
}

interface Classification {
  risk: CommandRisk
  reason: string
  reasonCode: CommandRiskReasonCode
  commandClass: AnalyzedSshCommand['commandClass']
  args: string[]
  family?: string[]
  standardPath?: boolean
}

export function quoteShellArgument(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

function hashArgv(argv: string[]): string {
  return createHash('sha256').update(JSON.stringify(argv)).digest('hex')
}

function exactRule(argv: string[]): ApprovedCommandRule {
  return { kind: 'exact', version: 1, program: argv[0]!, hash: hashArgv(argv) }
}

function safeWritePath(path: string): boolean {
  // Static argv screening cannot resolve remote symlinks or the working directory.
  const relative = path.startsWith('./') ? path.slice(2) : path
  const parts = relative.split('/')
  if (/^(etc|proc|sys|dev|boot|root|usr|bin|sbin|run|var)(\/|$)/.test(relative)) return false
  return parts.every(part => part !== '' && part !== '-' && !part.startsWith('.') && /^[\p{L}\p{N} _.,+@=-]+$/u.test(part))
}

function fileArguments(args: string[], flags: string, minimum: number): { args: string[]; paths: string[] } | null {
  const options: string[] = []
  const paths: string[] = []
  let operands = false
  let explicitEnd = false
  for (const arg of args) {
    if (!operands && arg === '--') {
      operands = true
      explicitEnd = true
    } else if (!operands && arg.startsWith('-')) {
      if (!flags || !new RegExp('^-[' + flags + ']+$').test(arg)) return null
      options.push(arg)
    } else {
      operands = true
      if (arg.startsWith('-') && !explicitEnd) return null
      paths.push(arg)
    }
  }
  return paths.length < minimum ? null : { args: [...options, '--', ...paths], paths }
}

function queryFamily(program: string, args: string[]): string[] | null {
  if (program === 'docker' && args[0] === 'ps' && args.slice(1).every(arg => /^-[aqsl]+$/.test(arg) || ['--all', '--quiet', '--size', '--latest', '--no-trunc'].includes(arg))) return ['docker', 'ps']
  if (program === 'ip') {
    const family = args[0] === '-4' || args[0] === '-6' ? [args[0]] : []
    const rest = args.slice(family.length)
    if (rest.length === 2 && rest[0] === 'rule' && rest[1] === 'show') return ['ip', ...family, 'rule', 'show']
  }
  if (program === 'uci') {
    const options = args[0] === '-q' ? ['-q'] : []
    const rest = args.slice(options.length)
    if (rest.length === 2 && rest[0] === 'get' && /^[A-Za-z0-9_-]+\.(?:[A-Za-z0-9_-]+|@[A-Za-z0-9_-]+\[-?\d+\])(?:\.[A-Za-z0-9_-]+)?$/.test(rest[1]!)) return ['uci', ...options, 'get']
  }
  if (program === 'nft' && args.length === 4 && args[0] === 'list' && args[1] === 'table' && ['inet', 'ip', 'ip6', 'arp', 'bridge', 'netdev'].includes(args[2]!) && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(args[3]!)) return ['nft', 'list', 'table']
  return null
}

function classify(program: string, args: string[]): Classification {
  const unknown: Classification = { risk: 'unknown', reason: 'Unrecognized program or arguments; approval required.', reasonCode: 'unknown', commandClass: 'full_control', args }
  const read = (family: string[], encodedArgs = args, standardPath = false): Classification => ({ risk: 'low', reason: 'Recognized query with validated arguments.', reasonCode: 'query', commandClass: 'read_only', args: encodedArgs, family, standardPath })
  if (NO_ARGUMENT_READS.has(program) && args.length === 0) return read([program], args, true)
  if (program === 'uname' && args.every(arg => /^-[asnrvm]+$/.test(arg))) return read([program], args, true)
  const query = queryFamily(program, args)
  if (query) return read(query)
  const policy = Object.prototype.hasOwnProperty.call(FILE_POLICIES, program) ? FILE_POLICIES[program] : undefined
  if (policy) {
    const parsed = fileArguments(args, policy.flags, policy.minimum)
    if (!parsed) return program === 'cp' || program === 'mv' ? { ...unknown, risk: 'high', reason: 'May overwrite files or remove source paths.', reasonCode: 'overwrite' } : unknown
    if (program === 'cp' || program === 'mv') return { risk: 'high', reason: 'May overwrite files or remove source paths.', reasonCode: 'overwrite', commandClass: 'read_write', args: parsed.args, standardPath: true }
    if (program === 'mkdir' || program === 'touch') {
      if (!parsed.paths.every(safeWritePath)) return { ...unknown, risk: 'high', reason: 'Write path is sensitive or cannot be screened lexically.', reasonCode: 'write_path' }
      return { risk: 'low', reason: 'Constrained relative write paths; remote symlinks are not resolved.', reasonCode: 'relative_write', commandClass: 'read_write', args: parsed.args, family: [program], standardPath: true }
    }
    return read([program], parsed.args, true)
  }
  const mutations: Record<string, string[]> = {
    docker: ['run', 'exec', 'rm', 'rmi', 'prune', 'kill', 'stop', 'start', 'restart', 'build', 'pull', 'push', 'create', 'update'],
    uci: ['set', 'add', 'delete', 'commit', 'import', 'revert', 'rename', 'reorder'],
    ip: ['add', 'del', 'delete', 'flush', 'replace', 'set', 'change', 'append'],
    nft: ['add', 'delete', 'flush', 'replace', 'insert', 'reset', 'destroy'],
  }
  if (['rm', 'rmdir', 'chmod', 'chown', 'chgrp', 'dd', 'mkfs', 'mount', 'umount', 'reboot', 'shutdown'].includes(program) || (Object.prototype.hasOwnProperty.call(mutations, program) && args.some(arg => mutations[program]!.includes(arg)))) return { ...unknown, risk: 'high', reason: 'Recognized state-changing operation.', reasonCode: 'state_change' }
  return unknown
}

export function analyzeSshCommand(raw: string): AnalyzedSshCommand | null {
  if (typeof raw !== 'string' || CONTROLS.test(raw)) return null
  const text = raw.trim()
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_SSH_COMMAND_BYTES) return null
  const argv = tokenizeSingleCommand(text)
  const program = argv?.[0]
  if (!argv || !program) return null
  return analyzeArgv(argv)
}

function analyzeArgv(argv: string[]): AnalyzedSshCommand {
  const program = argv[0]!
  const classified = classify(program, argv.slice(1))
  return {
    command: (classified.standardPath ? 'command -p ' : classified.family ? 'command ' : '') + [program, ...classified.args].map(quoteShellArgument).join(' '),
    program, argv, risk: classified.risk, reason: classified.reason, reasonCode: classified.reasonCode,
    commandClass: classified.commandClass,
    rule: classified.family ? { kind: 'family', version: 1, argv: classified.family } : exactRule(argv),
  }
}

function isFamily(argv: string[]): boolean {
  const key = JSON.stringify(argv)
  return COMMAND_FAMILIES.some(family => JSON.stringify(family) === key)
}

export function lowRiskReadOnlyCommandRules(): ApprovedCommandRule[] {
  return LOW_RISK_READ_ONLY_FAMILIES.map(argv => ({ kind: 'family', version: 1, argv: [...argv] }))
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateCommandRules(value: unknown, limit: number): ApprovedCommandRule[] {
  if (!Array.isArray(value)) throw new Error('Command rules must be an array.')
  const result: ApprovedCommandRule[] = []
  const seen = new Set<string>()
  const exactPrograms = new Map<string, string>()
  for (let index = 0; index < value.length; index += 1) {
    const rule: unknown = value[index]
    const fail: () => never = () => { throw new Error('Invalid command rule at index ' + index + '.') }
    if (!record(rule) || rule.version !== 1) fail()
    let validated: ApprovedCommandRule
    if (rule.kind === 'family') {
      if (Object.keys(rule).sort().join(',') !== 'argv,kind,version' || !Array.isArray(rule.argv) || !rule.argv.every((arg: unknown) => typeof arg === 'string') || !isFamily(rule.argv)) fail()
      validated = { kind: 'family', version: 1, argv: [...rule.argv] }
    } else if (rule.kind === 'exact') {
      if (Object.keys(rule).sort().join(',') !== 'hash,kind,program,version' || typeof rule.program !== 'string' || !rule.program || CONTROLS.test(rule.program) || Buffer.byteLength(rule.program, 'utf8') > MAX_SSH_COMMAND_BYTES || typeof rule.hash !== 'string' || !/^[a-f0-9]{64}$/.test(rule.hash)) fail()
      validated = { kind: 'exact', version: 1, program: rule.program, hash: rule.hash }
      const previous = exactPrograms.get(validated.hash)
      if (previous !== undefined && previous !== validated.program) fail()
      exactPrograms.set(validated.hash, validated.program)
    } else {
      fail()
    }
    const key = JSON.stringify(validated)
    if (!seen.has(key)) {
      seen.add(key)
      result.push(validated)
      if (result.length > limit) throw new Error('At most ' + limit + ' command rules are allowed.')
    }
  }
  return result
}

export function validateApprovedCommandRules(value: unknown): ApprovedCommandRule[] {
  return validateCommandRules(value, MAX_APPROVED_COMMAND_RULES)
}

export function commandRuleFromText(text: string, kind: 'family' | 'exact'): ApprovedCommandRule {
  const analysis = analyzeSshCommand(text)
  if (!analysis) throw new Error('Unsupported single command syntax.')
  if (kind === 'exact') return exactRule(analysis.argv)
  if (kind !== 'family') throw new Error('Unsupported command rule kind.')
  if (isFamily(analysis.argv)) return { kind: 'family', version: 1, argv: [...analysis.argv] }
  if (analysis.rule.kind !== 'family') throw new Error('Arguments cannot be safely represented by a command family; use exact matching.')
  return analysis.rule
}

export function commandRuleMatches(rule: ApprovedCommandRule, analysis: AnalyzedSshCommand): boolean {
  try {
    const valid = validateApprovedCommandRules([rule])[0]!
    // Reclassify argv without counting dispatch quoting against the original input bound.
    if (!Array.isArray(analysis.argv) || !analysis.argv[0] || !analysis.argv.every(arg => typeof arg === 'string' && !CONTROLS.test(arg)) || Buffer.byteLength(analysis.argv.join(' '), 'utf8') > MAX_SSH_COMMAND_BYTES) return false
    const current = analyzeArgv(analysis.argv)
    if (valid.kind === 'exact') return valid.program === current.program && valid.hash === hashArgv(current.argv)
    return current.risk === 'low' && current.rule.kind === 'family' && JSON.stringify(valid.argv) === JSON.stringify(current.rule.argv)
  } catch {
    return false
  }
}

export function commandRuleLabel(rule: ApprovedCommandRule): string {
  const valid = validateApprovedCommandRules([rule])[0]!
  return valid.kind === 'family' ? valid.argv.join(' ') + ' · 参数须通过风险校验' : valid.program + ' · 精确命令 · ' + valid.hash.slice(0, 12)
}

export function exportCommandSet(rules: ApprovedCommandRule[]): string {
  const text = JSON.stringify({ format: 'tabby-secure-mcp-command-set', version: 1, rules: validateCommandRules(rules, 2 * MAX_APPROVED_COMMAND_RULES) }, null, 2)
  if (Buffer.byteLength(text, 'utf8') > MAX_COMMAND_SET_BYTES) throw new Error('Command set exceeds 64 KiB.')
  return text
}

export function importCommandSet(text: string): ApprovedCommandRule[] {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_COMMAND_SET_BYTES) throw new Error('Command set exceeds 64 KiB.')
  const payload: unknown = JSON.parse(text)
  if (!record(payload) || Object.keys(payload).sort().join(',') !== 'format,rules,version' || payload.format !== 'tabby-secure-mcp-command-set' || payload.version !== 1) throw new Error('Unsupported command set format or version.')
  return validateCommandRules(payload.rules, 2 * MAX_APPROVED_COMMAND_RULES)
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
