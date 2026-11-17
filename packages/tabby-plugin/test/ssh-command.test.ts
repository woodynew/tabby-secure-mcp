import { describe, expect, it } from 'vitest'
import { authorizeSingleSshCommand, parseSingleSshCommand, quoteShellArgument } from '../src/authorization/ssh-command'

describe('single SSH command mode authorization', () => {
  it('delegates shared analysis and preserves legacy commandClass names', () => {
    expect(parseSingleSshCommand('docker ps')).toMatchObject({ program: 'docker', risk: 'low', commandClass: 'read_only' })
    expect(parseSingleSshCommand('mkdir "a b"')).toMatchObject({ risk: 'low', commandClass: 'read_write' })
    expect(parseSingleSshCommand('cp -R a b')).toMatchObject({ risk: 'high', commandClass: 'read_write' })
    expect(parseSingleSshCommand('/bin/ls')).toMatchObject({ risk: 'unknown', commandClass: 'full_control' })
    expect(quoteShellArgument("a'b")).toBe("'a'\\''b'")
  })

  it('never grants ask automatically and only grants validated low risks in auto edit', () => {
    for (const command of ['ls', 'docker ps', 'ip -4 rule show', 'uci get a.b.c', 'nft list table inet fw4', 'mkdir -p demo', 'touch demo/file']) {
      expect(authorizeSingleSshCommand({ command, grantedTier: 'ask', grantFresh: true }), command).toEqual({ ok: false, reason: 'tier_insufficient' })
      expect(authorizeSingleSshCommand({ command, grantedTier: 'auto_edit', grantFresh: true }).ok, command).toBe(true)
    }
    for (const command of ['rm x', 'cp a b', 'mv a b', 'touch /etc/x', 'docker run alpine', 'unknown x', 'env ls', 'ls --unknown']) {
      expect(authorizeSingleSshCommand({ command, grantedTier: 'auto_edit', grantFresh: true }), command).toEqual({ ok: false, reason: 'tier_insufficient' })
      expect(authorizeSingleSshCommand({ command, grantedTier: 'full', grantFresh: true }).ok, command).toBe(true)
    }
  })

  it('preserves grammar, stale and disabled checks even in full mode', () => {
    for (const command of ['ls | head', 'ls && rm x', 'cat $(whoami)', 'echo \u001b', 'ls\nrm', 'x'.repeat(513)]) {
      expect(authorizeSingleSshCommand({ command, grantedTier: 'full', grantFresh: true })).toEqual({ ok: false, reason: 'not_a_single_command' })
    }
    expect(parseSingleSshCommand('ls "a;b"')?.command).toContain("'a;b'")
    expect(authorizeSingleSshCommand({ command: 'ls', grantedTier: 'none', grantFresh: true })).toEqual({ ok: false, reason: 'not_granted' })
    expect(authorizeSingleSshCommand({ command: 'ls', grantedTier: 'full', grantFresh: false })).toEqual({ ok: false, reason: 'grant_stale' })
  })
})
