import { describe, expect, it } from 'vitest'
import type { PartialProfile, Profile } from 'tabby-core'

import {
  buildProfileSecuritySnapshot,
  profileSecuritySnapshotsEqual,
} from '../src/approval/profile-security-snapshot'

const SECRET = {
  host: 'secret-host.example',
  user: 'secret-user',
  password: 'hunter2',
  privateKey: '-----BEGIN PRIVATE KEY-----\nMIIE',
}

function sshProfile(overrides: Partial<PartialProfile<Profile>> = {}): PartialProfile<Profile> {
  return {
    id: 'ssh-1',
    type: 'ssh',
    name: 'Primary SSH',
    options: { ...SECRET },
    isBuiltin: false,
    isTemplate: false,
    ...overrides,
  }
}

describe('profile security snapshot', () => {
  const runKey = new Uint8Array(32).fill(7)

  it('is deterministic for the same profile and run key', () => {
    const profile = sshProfile()
    const first = buildProfileSecuritySnapshot(profile, runKey)
    const second = buildProfileSecuritySnapshot(profile, runKey)

    expect(first).toEqual(second)
    expect(first).toEqual({ version: 1, digest: expect.stringMatching(/^[0-9a-f]{64}$/) })
  })

  it('changes digest when run key changes but projection is unchanged', () => {
    const profile = sshProfile()
    const a = buildProfileSecuritySnapshot(profile, new Uint8Array(32).fill(1))
    const b = buildProfileSecuritySnapshot(profile, new Uint8Array(32).fill(2))
    expect(a.digest).not.toBe(b.digest)
  })

  it('never exposes plaintext host, username, options, or credentials', () => {
    const snapshot = buildProfileSecuritySnapshot(sshProfile(), runKey)
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toMatch(/secret-host|secret-user|hunter2|BEGIN PRIVATE KEY/i)
    expect(serialized).not.toMatch(/"host"|"user"|"password"|"options"/)
    expect(Object.keys(snapshot).sort()).toEqual(['digest', 'version'])
  })

  const sensitiveFields: Array<{ label: string; overrides: Partial<PartialProfile<Profile>> }> = [
    { label: 'id', overrides: { id: 'ssh-2' } },
    { label: 'type', overrides: { type: 'local' } },
    { label: 'name', overrides: { name: 'Renamed' } },
    { label: 'host', overrides: { options: { ...SECRET, host: 'other.example' } } },
    { label: 'port', overrides: { options: { ...SECRET, port: 2222 } } },
    { label: 'user', overrides: { options: { ...SECRET, user: 'other-user' } } },
    { label: 'jump', overrides: { options: { ...SECRET, jumpHost: 'jump.example' } } },
    { label: 'proxy', overrides: { options: { ...SECRET, proxyHost: 'proxy.example' } } },
    { label: 'auth', overrides: { options: { ...SECRET, auth: 'password' } } },
    { label: 'credential', overrides: { options: { ...SECRET, privateKey: 'other-key-material' } } },
    { label: 'host-key', overrides: { options: { ...SECRET, hostKeyPolicy: 'accept-new' } } },
    { label: 'options', overrides: { options: { ...SECRET, keepaliveInterval: 30 } } },
  ]

  it.each(sensitiveFields)('detects $label changes', ({ overrides }) => {
    const baseline = buildProfileSecuritySnapshot(sshProfile(), runKey)
    const mutated = buildProfileSecuritySnapshot(sshProfile(overrides), runKey)
    expect(profileSecuritySnapshotsEqual(baseline, mutated)).toBe(false)
  })
})
