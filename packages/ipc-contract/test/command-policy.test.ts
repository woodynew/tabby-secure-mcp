import { describe, expect, it } from 'vitest'
import { analyzeSshCommand, commandRuleFromText, commandRuleLabel, commandRuleMatches, exportCommandSet, importCommandSet, lowRiskReadOnlyCommandRules, validateApprovedCommandRules } from '../src/command-policy.js'

const analyze = (text: string) => {
  const result = analyzeSshCommand(text)
  expect(result, text).not.toBeNull()
  return result!
}

describe('SSH command risk and rules', () => {
  it.each([
    ['docker ps', 'query', 'Recognized query with validated arguments.'],
    ['touch project/file', 'relative_write', 'Constrained relative write paths; remote symlinks are not resolved.'],
    ['touch /etc/file', 'write_path', 'Write path is sensitive or cannot be screened lexically.'],
    ['cp a b', 'overwrite', 'May overwrite files or remove source paths.'],
    ['cp --unknown a b', 'overwrite', 'May overwrite files or remove source paths.'],
    ['rm file', 'state_change', 'Recognized state-changing operation.'],
    ['custom argument', 'unknown', 'Unrecognized program or arguments; approval required.'],
  ])('provides stable localization metadata for %s while retaining the API reason', (text, reasonCode, reason) => {
    expect(analyze(text)).toMatchObject({ reasonCode, reason })
  })

  it.each(['docker ps', 'ip -4 rule show', 'uci get openclash.config.en_mode', 'nft list table inet fw4'])('recognizes query %s', text => {
    expect(analyze(text)).toMatchObject({ risk: 'low', commandClass: 'read_only', rule: { kind: 'family' } })
  })

  it.each(['docker run alpine', 'docker exec x id', 'docker rm x', 'ip -4 rule add table 2', 'uci set a.b.c=x', 'uci commit', 'nft flush ruleset', 'cp a b', 'mv a b', 'rm a'])('keeps mutation %s high risk', text => {
    expect(analyze(text).risk).toBe('high')
  })

  it('does not widen families through flags, actions, wrappers, paths or similar names', () => {
    for (const [query, variants] of [
      ['docker ps', ['docker exec x id', 'docker --host tcp://remote ps', 'docker ps --unknown', 'dockerx ps', '/usr/bin/docker ps', 'sudo docker ps', 'env docker ps']],
      ['ip -4 rule show', ['ip -4 rule add table 2', 'ip -4 -batch file rule show', 'ip -4 rule show --unknown']],
      ['uci get a.b.c', ['uci set a.b.c=x', 'uci -c /etc get a.b.c', 'uci get --unknown']],
      ['nft list table inet fw4', ['nft delete table inet fw4', 'nft -f payload list table inet fw4', 'nft list table inet fw4 --unknown']],
    ] as const) {
      const rule = analyze(query).rule
      for (const text of variants) {
        const candidate = analyze(text)
        expect(commandRuleMatches(rule, candidate), text).toBe(false)
        expect(candidate.rule.kind, text).toBe('exact')
        expect(candidate.risk, text).not.toBe('low')
      }
    }
    expect(commandRuleMatches(analyze('uci get a.b.c').rule, analyze('uci get x.y.z'))).toBe(true)
    expect(commandRuleMatches(analyze('nft list table inet fw4').rule, analyze('nft list table ip example'))).toBe(true)
    expect(commandRuleMatches(analyze('ip -4 rule show').rule, analyze('ip -6 rule show'))).toBe(false)
  })

  it('allows only lexically ordinary mkdir/touch paths and blocks risk escalation', () => {
    for (const text of ['mkdir -p project/subdir', 'mkdir "a b"', 'touch ./project/file.txt']) {
      expect(analyze(text)).toMatchObject({ risk: 'low', commandClass: 'read_write', rule: { kind: 'family' } })
    }
    for (const text of ['mkdir /etc/new', 'touch /tmp/x', 'touch ../x', 'touch a/../x', 'touch .ssh/key', 'touch project/.git/config', 'touch ~/x', "touch '$HOME/x'", "touch 'a*'", 'touch --reference=x y', 'mkdir -m 777 x', 'touch -']) {
      const candidate = analyze(text)
      expect(candidate.risk, text).not.toBe('low')
      expect(candidate.rule.kind, text).toBe('exact')
      expect(commandRuleMatches(analyze('touch project/file').rule, candidate), text).toBe(false)
    }
  })

  it('preserves safe legacy reads and conservative unknown classification', () => {
    for (const text of ['pwd', 'whoami', 'id', 'uptime', 'uname -a', 'ls -la', 'cat "a b"', 'wc -l file']) expect(analyze(text).risk, text).toBe('low')
    for (const text of ['uname --unknown', 'cat --help', 'ls file -R', 'sh -c id', 'unknown argument', '/bin/ls']) {
      expect(analyze(text).risk, text).not.toBe('low')
      expect(analyze(text).rule.kind, text).toBe('exact')
    }
    expect(analyze('cp -R a b')).toMatchObject({ commandClass: 'read_write', risk: 'high' })
  })

  it('quotes dispatch arguments without evaluating literal shell characters', () => {
    expect(analyze('ls "a;b"').command).toBe("command -p 'ls' '--' 'a;b'")
    expect(analyze('docker ps').command).toBe("command 'docker' 'ps'")
    expect(analyze("unknown 'a$b' 'a|b' \"a'b\"").command).toBe("'unknown' 'a$b' 'a|b' 'a'\\''b'")
    for (const text of ['ls | head', 'ls && id', 'ls; id', 'cat $(id)', 'echo `id`', 'ls #comment', 'ls >file', 'echo "${PATH}"', "echo 'unterminated"]) expect(analyzeSshCommand(text), text).toBeNull()
  })

  it('preserves the byte limit and rejects controls before quoting or trimming', () => {
    expect(analyzeSshCommand('x'.repeat(512))).not.toBeNull()
    expect(analyzeSshCommand('x'.repeat(513))).toBeNull()
    expect(analyzeSshCommand('字'.repeat(171))).toBeNull()
    const longest = analyze('x'.repeat(512))
    expect(commandRuleMatches(longest.rule, longest)).toBe(true)
    for (const control of ['\0', '\u0003', '\u001b', '\u007f', '\u0085', '\n', '\r', '\t', '\u2028', '\u2029']) {
      for (const text of [`echo ${control}x`, `echo 'a${control}b'`, `echo \\${control}b`]) expect(analyzeSshCommand(text), JSON.stringify(text)).toBeNull()
    }
  })

  it('hashes normalized full argv without persisting original exact arguments', () => {
    const rule = analyze('custom --password "secret value"').rule
    expect(rule).toMatchObject({ kind: 'exact', version: 1, program: 'custom', hash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(commandRuleMatches(rule, analyze(" custom   --password 'secret value' "))).toBe(true)
    expect(commandRuleMatches(rule, analyze('custom --password changed'))).toBe(false)
    expect(commandRuleMatches(rule, analyze('custom2 --password "secret value"'))).toBe(false)
    expect(exportCommandSet([rule])).not.toContain('secret')
    expect(commandRuleLabel(rule)).toContain('custom')
    expect(commandRuleLabel(rule)).toContain('精确命令')
  })

  it('creates narrow family rules from text and rejects broad or unsafe families', () => {
    for (const text of ['docker ps', 'ip -4 rule show', 'uci get', 'nft list table', 'ls', 'mkdir', 'touch']) expect(commandRuleFromText(text, 'family')).toMatchObject({ kind: 'family', version: 1 })
    expect(commandRuleFromText('uci get a.b.c', 'family')).toEqual(analyze('uci get a.b.c').rule)
    for (const text of ['docker', 'ip', 'ip -4', 'uci', 'nft', 'nft list', 'sudo ls', '/bin/ls', 'rm x', 'mkdir /etc/x', 'ls --unknown', 'ls; id']) expect(() => commandRuleFromText(text, 'family'), text).toThrow()
    expect(commandRuleFromText('ls', 'exact').kind).toBe('exact')
  })
})

describe('low-risk read-only presets', () => {
  it('provides exactly the 15 validated read-only families with representative arguments', () => {
    const examples = [
      ['pwd', 'pwd'], ['whoami', 'whoami'], ['id', 'id'], ['uptime', 'uptime'],
      ['uname', 'uname -a'], ['ls', 'ls -la /tmp'], ['cat', 'cat /etc/os-release'], ['wc', 'wc -l file'],
      ['docker ps', 'docker ps --all --no-trunc'], ['ip rule show', 'ip rule show'],
      ['ip -4 rule show', 'ip -4 rule show'], ['ip -6 rule show', 'ip -6 rule show'],
      ['uci get', 'uci get openclash.config.en_mode'], ['uci -q get', 'uci -q get network.lan.ipaddr'],
      ['nft list table', 'nft list table inet fw4'],
    ]
    const rules = lowRiskReadOnlyCommandRules()
    expect(rules).toHaveLength(15)
    expect(rules).toEqual(examples.map(([family]) => ({ kind: 'family', version: 1, argv: family!.split(' ') })))
    expect(validateApprovedCommandRules(rules)).toEqual(rules)
    for (const [index, [, text]] of examples.entries()) {
      const candidate = analyze(text!)
      expect(candidate).toMatchObject({ risk: 'low', commandClass: 'read_only' })
      expect(commandRuleMatches(rules[index]!, candidate), text).toBe(true)
    }
    for (const program of ['mkdir', 'touch']) {
      expect(rules).not.toContainEqual(commandRuleFromText(program, 'family'))
      expect(analyze(program + ' project/file')).toMatchObject({ risk: 'low', commandClass: 'read_write' })
    }
  })

  it('returns detached arrays and rule objects without exposing the family registry', () => {
    const first = lowRiskReadOnlyCommandRules()
    const second = lowRiskReadOnlyCommandRules()
    const expected = validateApprovedCommandRules(second)
    expect(first).not.toBe(second)
    for (const [index, rule] of first.entries()) {
      const other = second[index]!
      expect(rule).not.toBe(other)
      if (rule.kind === 'family' && other.kind === 'family') {
        expect(rule.argv).not.toBe(other.argv)
        rule.argv.push('changed')
        rule.argv = ['docker']
      }
    }
    first.splice(0)
    expect(second).toEqual(expected)
    expect(lowRiskReadOnlyCommandRules()).toEqual(expected)
    expect(validateApprovedCommandRules(expected)).toEqual(expected)
    expect(() => commandRuleFromText('docker', 'family')).toThrow()
  })

  it('never authorizes writes, mutations, broad actions, unsafe flags or wrappers', () => {
    const rules = lowRiskReadOnlyCommandRules()
    for (const text of [
      'mkdir project/subdir', 'touch project/file', 'rm file', 'cp a b',
      'docker', 'docker exec x id', 'docker ps --unknown', 'docker --host tcp://remote ps',
      'ip', 'ip rule add table 2', 'ip -4 rule add table 2', 'ip -6 rule flush',
      'uci', 'uci set a.b.c=x', 'uci -q set a.b.c=x', 'uci commit',
      'nft', 'nft list', 'nft flush ruleset', 'nft list table inet fw4 --unknown',
      'ls --unknown', 'uname --unknown', 'cat --help', 'sudo ls', 'env ls', '/bin/ls',
    ]) {
      const candidate = analyze(text)
      expect(rules.some(rule => commandRuleMatches(rule, candidate)), text).toBe(false)
    }
  })
})

describe('portable command sets', () => {
  it('copies a full inherited union while keeping each stored set limited to 128 rules', () => {
    const globalRules = Array.from({ length: 128 }, (_, i) => commandRuleFromText('globaltool ' + i, 'exact'))
    const localRules = Array.from({ length: 128 }, (_, i) => commandRuleFromText('localtool ' + i, 'exact'))
    const effective = [...globalRules, ...localRules]
    expect(importCommandSet(exportCommandSet(effective))).toEqual(effective)
    expect(() => validateApprovedCommandRules(effective)).toThrow()
    expect(() => exportCommandSet([...effective, commandRuleFromText('one-more', 'exact')])).toThrow()
  })
  it('canonically deduplicates and round trips without identity or exact argv', () => {
    const rules = [commandRuleFromText('docker ps', 'family'), commandRuleFromText('custom secret', 'exact')]
    expect(validateApprovedCommandRules([...rules, rules[0]])).toEqual(rules)
    const portable = exportCommandSet(rules)
    expect(importCommandSet(portable)).toEqual(rules)
    for (const text of ['secret', 'profileId', 'profileDigest', 'generation', 'token', 'credential']) expect(portable).not.toContain(text)
    const validated = validateApprovedCommandRules(rules)
    if (validated[0]?.kind === 'family') validated[0].argv.push('changed')
    expect(rules[0]).toEqual(commandRuleFromText('docker ps', 'family'))
  })

  it('rejects malformed, broad, incompatible or oversized rules atomically', () => {
    const valid = commandRuleFromText('docker ps', 'family')
    for (const bad of [null, {}, { ...valid, version: 2 }, { ...valid, argv: ['docker'] }, { ...valid, argv: ['nft'] }, { ...valid, argv: ['ip', '-4'] }, { ...valid, argv: ['uci'] }, { ...valid, argv: ['ls; id'] }, { ...valid, argv: ['ls', '--unknown'] }, { kind: 'exact', version: 1, program: 'custom', hash: 'invalid' }, { kind: 'exact', version: 1, program: 'a\nb', hash: 'a'.repeat(64) }, { ...valid, token: 'injected' }, { ...valid, kind: 'regex' }]) expect(() => validateApprovedCommandRules([valid, bad]), JSON.stringify(bad)).toThrow()
    expect(() => validateApprovedCommandRules(Array.from({ length: 129 }, (_, i) => commandRuleFromText(`custom ${i}`, 'exact')))).toThrow()
    expect(() => importCommandSet('{bad json')).toThrow()
    const payload = JSON.parse(exportCommandSet([valid]))
    expect(() => importCommandSet(JSON.stringify({ ...payload, version: 999 }))).toThrow()
    expect(() => importCommandSet(JSON.stringify({ ...payload, token: 'secret' }))).toThrow()
    expect(() => importCommandSet(JSON.stringify({ ...payload, rules: [valid, { ...valid, argv: ['docker'] }] }))).toThrow()
    expect(() => importCommandSet(' '.repeat(65537))).toThrow()
    const exact = commandRuleFromText('custom secret', 'exact')
    expect(() => validateApprovedCommandRules([exact, { ...exact, program: 'another' }])).toThrow()
  })
})
