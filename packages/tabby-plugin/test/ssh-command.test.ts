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
    expect(parseSingleSshCommand('ls "a;b"')?.command).toBe('ls "a;b"')
  })

  it('lets a tier run its SSH command class and every lower class', () => {
    expect(
      authorizeSingleSshCommand({ command: 'ls', grantedTier: 'readonly', grantFresh: true }),
    ).toEqual({ ok: true, command: 'ls', commandClass: 'read_only' })
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
