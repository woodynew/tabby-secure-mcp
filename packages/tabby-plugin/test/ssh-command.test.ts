import { describe, expect, it } from 'vitest'

import { authorizeSingleSshCommand, parseSingleSshCommand } from '../src/authorization/ssh-command'

describe('single SSH command authorization', () => {
  it('classifies one read-only, read-write, or full-control command', () => {
    expect(parseSingleSshCommand('ls -la')?.commandClass).toBe('read_only')
    expect(parseSingleSshCommand('mkdir "a b"')?.commandClass).toBe('read_write')
    expect(parseSingleSshCommand('rm -rf /tmp/demo')?.commandClass).toBe('full_control')
    expect(parseSingleSshCommand('/bin/ls')?.commandClass).toBe('full_control')
  })

  it('rejects shell composition so the input stays one command', () => {
    for (const command of ['ls | head', 'ls && rm x', 'cat $(whoami)', 'echo `id`', 'ls\nrm', 'ls # rm']) {
      expect(parseSingleSshCommand(command), command).toBeNull()
    }
    expect(parseSingleSshCommand('ls "a;b"')?.command).toContain("'a;b'")
  })

  it('does not classify launchers or state-changing flags as read-only', () => {
    for (const command of ["env sh -c 'printf bypass'", 'date -s 2000-01-01', 'hostname changed', 'ls --invalid', 'uname --help', 'cp -a a b']) {
      expect(authorizeSingleSshCommand({ command, grantedTier: 'readonly', grantFresh: true }).ok, command).toBe(false)
    }
    expect(parseSingleSshCommand('mkdir -p "a b"')?.commandClass).toBe('read_write')
    expect(parseSingleSshCommand('cp -R a b')?.commandClass).toBe('read_write')
    expect(parseSingleSshCommand('cat "a b"')?.command).toContain("'a b'")
  })

  it('rejects terminal controls before processing any quoting or escaping', () => {
    for (const control of ['\u0000', '\u0003', '\u0015', '\u001b', '\u007f', '\u0085', '\r', '\n', '\t']) {
      for (const command of [`echo ${control}printf bypass`, `echo 'a${control}b'`, `echo \\${control}b`]) {
        expect(parseSingleSshCommand(command), JSON.stringify(command)).toBeNull()
      }
    }
  })

  it('lets a tier run its SSH command class and every lower class', () => {
    expect(
      authorizeSingleSshCommand({ command: 'ls', grantedTier: 'readonly', grantFresh: true }),
    ).toEqual({ ok: true, command: "command -p 'ls' '--'", commandClass: 'read_only' })
    expect(
      authorizeSingleSshCommand({ command: 'mkdir demo', grantedTier: 'readonly', grantFresh: true }),
    ).toEqual({ ok: false, reason: 'tier_insufficient' })
    expect(
      authorizeSingleSshCommand({ command: 'mkdir demo', grantedTier: 'readwrite', grantFresh: true }).ok,
    ).toBe(true)
    expect(
      authorizeSingleSshCommand({ command: 'rm demo', grantedTier: 'readwrite', grantFresh: true }),
    ).toEqual({ ok: false, reason: 'tier_insufficient' })
    expect(
      authorizeSingleSshCommand({ command: 'rm demo', grantedTier: 'full', grantFresh: true }),
    ).toMatchObject({ ok: true, commandClass: 'full_control' })
    expect(
      authorizeSingleSshCommand({ command: 'ls', grantedTier: 'full', grantFresh: false }),
    ).toEqual({ ok: false, reason: 'grant_stale' })
    expect(
      authorizeSingleSshCommand({ command: 'ls', grantedTier: 'none', grantFresh: true }),
    ).toEqual({ ok: false, reason: 'not_granted' })
  })
})
