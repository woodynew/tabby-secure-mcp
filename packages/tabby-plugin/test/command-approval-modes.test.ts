import { describe, expect, it, vi } from 'vitest'
import { ApprovalGatekeeper } from '../src/approval/approval-gatekeeper'
import { AuthorizedProfilesService } from '../src/services/authorized-profiles.service'
import { stableProfileDigest } from '../src/approval/profile-security-snapshot'
import { FakeApprovalScheduler } from '../src/approval/approval-scheduler'
import { readPermanentAuthorizations } from '../src/config/secure-mcp-config'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CredentialStore } from '../../companion/src/http/credentials'
import { McpOwnedTabs, type TabAcquisition, type TabTarget } from '../src/runtime/mcp-owned-tabs'
import { commandRuleFromText } from '@tabby-secure-mcp/ipc-contract/command-policy'
import { Subject } from 'rxjs'
import type { RetainedTabMetadata, TabLease } from '../src/runtime/mcp-owned-tabs'

async function fixture(mode = 'ask', connectionAllowed = true, external?: { permissions: CredentialStore; client: any }, closePolicy: 'keep' | 'after-completion' = 'keep') {
  const profile = { id: 'p', name: 'Fixture SSH', type: 'ssh', options: { host: 'fixture.invalid', user: 'test' } }
  const config = { store: { profiles: [profile], secureMcp: { authorizedSshProfileIds: ['p'] } }, save: async () => {} }
  let modeRevision = 0, commandRevision = 0, connectionRevision = 0
  let local: any[] = [], defaults: any[] = []
  const sent: string[] = []
  const listeners = new Set<(chunk: string) => void>()
  const tab = {
    input$: new Subject<void>(),
    session: { open: true }, frontendReady$: { subscribe: () => ({ unsubscribe() {} }) },
    output$: { subscribe: (observer: any) => { listeners.add(observer.next); return { unsubscribe: () => listeners.delete(observer.next) } } },
    sendInput: (data: string) => {
      sent.push(data)
      const marker = data.match(/'([0-9a-f]+)' '([0-9a-f]+)'\r$/)
      if (marker) for (const next of listeners) {
        next('\u001e' + marker[1] + marker[2] + ':start\u001f')
        next('ok\n')
        next('\u001e' + marker[1] + marker[2] + ':end\u001f')
      }
    },
    destroy: vi.fn(),
  }
  const profiles = {
    getProfiles: async () => [profile], getConfigProxyForProfile: (p: any) => p,
    openNewTabForProfile: vi.fn(async () => tab),
  }
  const authorized = new AuthorizedProfilesService(profiles as never, config as never)
  const presenter = {
    presentPairing: vi.fn(async () => 'deny'), presentOpen: vi.fn(async () => 'deny'),
    presentCommand: vi.fn(async () => 'deny'),
  }
  const permissions = external?.permissions ?? {
    connectionGrants: () => [], connectionRevision: () => connectionRevision,
    hasConnectionPermission: () => connectionAllowed,
    setConnectionPermission: vi.fn(async (_client?: unknown, _id?: string, digest?: string | null) => { connectionAllowed = digest !== null; connectionRevision++ }),
    commandRevision: () => commandRevision,
    commandSet: () => ({ profileId: 'p', profileDigest: stableProfileDigest(profile), rules: local, defaultRules: defaults, inheritDefaults: true, revision: commandRevision, stale: false }),
    defaultCommandSet: () => ({ rules: defaults, revision: commandRevision }),
    setCommandSet: vi.fn(async (_client: unknown, _id: string, _digest: string, update: any, expected: number, current?: () => boolean, beforeCommit?: () => Promise<void>) => {
      if (expected !== commandRevision || current && !current()) throw new Error('stale')
      commandRevision++
      await Promise.resolve() // The real store invokes its operation inside the queued, guarded transaction.
      await beforeCommit?.()
      local = update.rules
    }),
  }
  let now = 0
  const clock = { now: () => now }
  const scheduler = new FakeApprovalScheduler(clock.now)
  const memory = {
    effectiveGrant: () => ({ openSession: false, operationTier: mode }),
    rememberOpen: async () => {}, revision: () => modeRevision,
  }
  const gatekeeper = new ApprovalGatekeeper(authorized, profiles as never, presenter as never, clock, () => 1, scheduler, memory as never, {
    audit: { append: async () => {} }, closeTab: async () => { tab.destroy() },
  }, () => closePolicy)
  const [entry] = await authorized.listAuthorizedProfiles()
  let sequence = 0
  const run = (command: string, signal?: AbortSignal, onRetainedTab?: (tab: unknown) => void, acquireTab?: (target: TabTarget) => TabAcquisition, onCreatedTab?: (tab: unknown, metadata: RetainedTabMetadata) => TabLease | undefined) => gatekeeper.runAuthorizedSshCommand({
    requestId: (++sequence).toString(16).padStart(32, '0'), leaseEpoch: 1,
    profileRef: entry.profile_ref, command, deadlineMonotonicMs: now + 60_000, signal, onRetainedTab, acquireTab, onCreatedTab,
    connection: { client: external?.client ?? { id: 'c', generation: 1, name: 'Fixture client' }, permissions,
      revision: external ? permissions.connectionRevision(external.client) : connectionRevision, isCurrent: () => !external || external.permissions.isCurrent(external.client) },
  })
  return { run, sent, presenter, permissions, profiles, tab, target: { profileId: profile.id, profileDigest: stableProfileDigest(profile) },
    emit: (chunk: string) => { for (const next of listeners) next(chunk) },
    defaults: (rules: any[]) => { defaults = rules; commandRevision++ },
    changeCommands: () => { commandRevision++ },
    changeMode: (value: string) => { mode = value; modeRevision++ },
    advance: (ms: number) => { now += ms; scheduler.flush() },
  }
}

describe('SSH command approval modes', () => {
  const owner = { id: 'c', generation: 1, name: 'Fixture client' }

  it('does not inject into or auto-close a new tab taken over before its first command', async () => {
    const f = await fixture('auto_edit', true, undefined, 'after-completion')
    const tabs = new McpOwnedTabs()
    let ref!: string
    const profiles = f.profiles.getProfiles.bind(f.profiles)
    vi.spyOn(f.profiles, 'getProfiles').mockImplementation(async () => {
      const result = await profiles()
      if (f.tab.input$.observed) f.tab.input$.next()
      return result
    })
    const result = await f.run('pwd', undefined, undefined, undefined, (tab, metadata) => {
      ref = tabs.track(owner, tab, metadata)!
      const acquired = tabs.acquire(owner, metadata, ref)
      return acquired.ok ? acquired.lease : undefined
    })
    expect(result.ok).toBe(false)
    expect(f.sent).toEqual([])
    expect(f.tab.destroy).not.toHaveBeenCalled()
    expect(tabs.reusable(ref, owner)).toBe(false)
    expect(await tabs.close(ref, owner, () => true)).toEqual({ ok: true, status: 'closed' })
  })

  it('reuses an owned SSH tab and leaves it open even when new command tabs auto-close', async () => {
    const f = await fixture('auto_edit', true, undefined, 'after-completion')
    const tabs = new McpOwnedTabs()
    const ref = tabs.track(owner, f.tab, f.target)!
    const retained = vi.fn()
    const acquire = (target: TabTarget) => tabs.acquire(owner, target, ref)
    for (const command of ['pwd', 'whoami']) expect((await f.run(command, undefined, retained, acquire)).ok).toBe(true)
    expect(f.sent).toHaveLength(2)
    expect(f.profiles.openNewTabForProfile).not.toHaveBeenCalled()
    expect(f.tab.destroy).not.toHaveBeenCalled()
    expect(retained).toHaveBeenLastCalledWith(f.tab, expect.objectContaining({ ...f.target, reusable: true, reused: true }))
    expect(tabs.reusable(ref, owner)).toBe(true)
  })

  it('persists always-allowed scope for only this client while reusing the same tab', async () => {
    const dir = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'remember-reused-ssh-'))
    try {
      const file = path.join(dir, 'credentials.json')
      const permissions = new CredentialStore(file)
      await permissions.load()
      const client = await permissions.create('Agent'), other = await permissions.create('Agent')
      const f = await fixture('ask', true, { permissions, client })
      const tabs = new McpOwnedTabs()
      const ref = tabs.track(client, f.tab, f.target)!
      const acquire = (target: TabTarget) => tabs.acquire(client, target, ref)
      f.presenter.presentCommand.mockResolvedValueOnce('remember')
      expect((await f.run('uci get openclash.config.en_mode', undefined, undefined, acquire)).ok).toBe(true)
      expect((await f.run('uci get openclash.config.enable', undefined, undefined, acquire)).ok).toBe(true)
      expect(f.presenter.presentCommand).toHaveBeenCalledOnce()
      expect(f.profiles.openNewTabForProfile).not.toHaveBeenCalled()
      const reloaded = new CredentialStore(file)
      await reloaded.load()
      expect(reloaded.commandSet(client, f.target.profileId, f.target.profileDigest).rules).toEqual([commandRuleFromText('uci get openclash.config.en_mode', 'family')])
      expect(reloaded.commandSet(other, f.target.profileId, f.target.profileDigest).rules).toEqual([])
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('checks command approval on each reused execution and releases a denied lease', async () => {
    const f = await fixture('ask')
    const tabs = new McpOwnedTabs()
    const ref = tabs.track(owner, f.tab, f.target)!
    const acquire = (target: TabTarget) => tabs.acquire(owner, target, ref)
    expect(await f.run('pwd', undefined, undefined, acquire)).toMatchObject({ ok: false, code: 'not_approved' })
    expect(tabs.reusable(ref, owner)).toBe(true)
    expect(f.sent).toHaveLength(0)
    f.presenter.presentCommand.mockResolvedValueOnce('allow')
    expect((await f.run('pwd', undefined, undefined, acquire)).ok).toBe(true)
    f.changeMode('none')
    expect(await f.run('pwd', undefined, undefined, acquire)).toMatchObject({ ok: false, code: 'command_disabled' })
    expect(f.sent).toHaveLength(1)
    expect(f.profiles.openNewTabForProfile).not.toHaveBeenCalled()
    expect(f.tab.destroy).not.toHaveBeenCalled()
  })

  it('refuses a reused tab whose transport changes while approval is open', async () => {
    const f = await fixture('ask')
    const tabs = new McpOwnedTabs()
    const ref = tabs.track(owner, f.tab, f.target)!
    let allow!: (value: 'allow') => void
    f.presenter.presentCommand.mockImplementationOnce(() => new Promise(resolve => { allow = resolve }))
    const running = f.run('pwd', undefined, undefined, target => tabs.acquire(owner, target, ref))
    await vi.waitFor(() => expect(allow).toBeTypeOf('function'))
    f.tab.session = { open: true }
    allow('allow')
    expect(await running).toMatchObject({ ok: false, code: 'target_unavailable' })
    expect(f.sent).toEqual([])
    expect(f.tab.destroy).not.toHaveBeenCalled()
    expect(tabs.reusable(ref, owner)).toBe(false)
  })

  it('quarantines output-truncated reused commands until explicit cleanup', async () => {
    const f = await fixture('auto_edit')
    const tabs = new McpOwnedTabs()
    const ref = tabs.track(owner, f.tab, f.target)!
    vi.spyOn(f.tab, 'sendInput').mockImplementation(data => {
      const marker = data.match(/'([0-9a-f]+)' '([0-9a-f]+)'\r$/)!
      f.emit(`\u001e${marker[1]}${marker[2]}:start\u001f` + 'x'.repeat(5000))
    })
    const retained = vi.fn()
    expect(await f.run('pwd', undefined, retained, target => tabs.acquire(owner, target, ref))).toMatchObject({ ok: true, truncated: true })
    expect(retained).toHaveBeenCalledWith(f.tab, expect.objectContaining({ ...f.target, reusable: false, reused: true }))
    expect(tabs.acquire(owner, f.target, ref)).toEqual({ ok: false, code: 'target_unavailable' })
    expect(await tabs.close(ref, owner, () => true)).toEqual({ ok: true, status: 'closed' })
  })

  it('publishes only the new retained command tab for explicit cleanup', async () => {
    const f = await fixture('auto_edit')
    const retained = vi.fn()
    expect((await f.run('pwd', undefined, retained)).ok).toBe(true)
    expect(retained).toHaveBeenCalledWith(f.tab, expect.objectContaining({ ...f.target, reused: false, reusable: true }))
    expect(f.tab.destroy).not.toHaveBeenCalled()
  })

  it('does not publish an already auto-closed tab', async () => {
    const f = await fixture('auto_edit', true, undefined, 'after-completion')
    const retained = vi.fn()
    expect((await f.run('pwd', undefined, retained)).ok).toBe(true)
    expect(f.tab.destroy).toHaveBeenCalledOnce()
    expect(retained).not.toHaveBeenCalled()
  })

  it('keeps explicit cleanup available if automatic close fails', async () => {
    const f = await fixture('auto_edit', true, undefined, 'after-completion')
    const retained = vi.fn()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    f.tab.destroy.mockImplementationOnce(() => { throw new Error('view not ready') })
    try {
      expect((await f.run('pwd', undefined, retained)).ok).toBe(true)
      expect(retained).toHaveBeenCalledWith(f.tab, expect.objectContaining({ ...f.target, reused: false, reusable: true }))
    } finally { warning.mockRestore() }
  })

  it('keeps a durable guard if cancellation during SSH readiness cannot roll back its remembered rule', async () => {
    const dir = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'cancel-remember-disk-full-'))
    const file = path.join(dir, 'private', 'credentials.json')
    let failTemporary = false
    const store = new CredentialStore(file, { fs: { open: async (...args) => {
      if (failTemporary && String(args[0]).includes('.credentials-')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      return fs.open(...args)
    } } })
    await store.load()
    const client = await store.create('Agent')
    const profile = { id: 'p', name: 'Fixture SSH', type: 'ssh', options: { host: 'fixture.invalid', user: 'test' } }
    const digest = stableProfileDigest(profile)
    await store.setConnectionPermission(client, 'p', digest)
    const f = await fixture('ask', true, { permissions: store, client })
    f.presenter.presentCommand.mockResolvedValueOnce('remember')
    f.tab.session.open = false
    const abort = new AbortController()
    const running = f.run('rm /tmp/cancel-target', abort.signal)
    try {
      await vi.waitFor(() => expect(f.profiles.openNewTabForProfile).toHaveBeenCalledOnce())
      expect(store.commandSet(client, 'p', digest).rules).toEqual([])
      expect((await fs.stat(file + '.pending')).size).toBe(0)
      failTemporary = true
      abort.abort()
      expect((await running).ok).toBe(false)
      expect(f.sent).toEqual([])
      expect(store.commandSet(client, 'p', digest).rules).toEqual([])
      await expect(new CredentialStore(file).load()).rejects.toThrow()
      expect((await fs.stat(file + '.pending')).size).toBe(0)
    } finally { abort.abort(); await running; await fs.rm(dir, { recursive: true, force: true }) }
  })
  it('does not overwrite a newer operator edit while compensating cancelled approval', async () => {
    const dir = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'cancel-command-editor-'))
    const file = path.join(dir, 'private', 'credentials.json')
    let onStaged = () => {}
    const store = new CredentialStore(file, { fs: { rename: async (from, to) => { await fs.rename(from, to); onStaged() } } })
    await store.load()
    const client = await store.create('Agent')
    const profile = { id: 'p', name: 'Fixture SSH', type: 'ssh', options: { host: 'fixture.invalid', user: 'test' } }
    const digest = stableProfileDigest(profile)
    const original = { kind: 'family' as const, version: 1 as const, argv: ['docker', 'ps'] }
    const replacement = { kind: 'family' as const, version: 1 as const, argv: ['nft', 'list', 'table'] }
    await store.setConnectionPermission(client, 'p', digest)
    await store.setCommandSet(client, 'p', digest, { inheritDefaults: true, rules: [original] }, store.commandRevision())
    const f = await fixture('ask', true, { permissions: store, client })
    f.presenter.presentCommand.mockResolvedValueOnce('remember')
    const abort = new AbortController()
    let editing: Promise<void> | undefined
    onStaged = () => {
      onStaged = () => {}
      queueMicrotask(() => queueMicrotask(() => {
        abort.abort()
        editing = store.setCommandSet(client, 'p', digest, { inheritDefaults: false, rules: [replacement] }, store.commandRevision())
      }))
    }
    try {
      expect((await f.run('rm /tmp/cancel-target', abort.signal)).ok).toBe(false)
      await editing
      expect(f.sent).toEqual([])
      const restored = new CredentialStore(file)
      await restored.load()
      expect(restored.commandSet(client, 'p', digest)).toMatchObject({ rules: [replacement], inheritDefaults: false })
    } finally { onStaged = () => {}; await fs.rm(dir, { recursive: true, force: true }) }
  })
  it.each([0, 1, 2, 3, 4, 5])('keeps existing approvals after cancellation %s microtasks after staging', async depth => {
    const dir = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'cancel-command-grant-'))
    const file = path.join(dir, 'private', 'credentials.json')
    let onStaged = () => {}
    const store = new CredentialStore(file, { fs: { rename: async (from, to) => { await fs.rename(from, to); onStaged() } } })
    await store.load()
    const client = await store.create('Agent')
    const profile = { id: 'p', name: 'Fixture SSH', type: 'ssh', options: { host: 'fixture.invalid', user: 'test' } }
    const digest = stableProfileDigest(profile)
    const original = { kind: 'family' as const, version: 1 as const, argv: ['docker', 'ps'] }
    await store.setConnectionPermission(client, 'p', digest)
    await store.setCommandSet(client, 'p', digest, { inheritDefaults: true, rules: [original] }, store.commandRevision())
    const f = await fixture('ask', true, { permissions: store, client })
    f.presenter.presentCommand.mockResolvedValueOnce('remember')
    const abort = new AbortController()
    const schedule = (n: number) => { if (n === 0) abort.abort(); else queueMicrotask(() => schedule(n - 1)) }
    onStaged = () => { onStaged = () => {}; schedule(depth) }
    try {
      expect((await f.run('rm /tmp/cancel-target', abort.signal)).ok).toBe(false)
      expect(f.sent).toEqual([])
      const restored = new CredentialStore(file)
      await restored.load()
      expect(restored.commandSet(client, 'p', digest)).toMatchObject({ rules: [original], inheritDefaults: true })
      f.presenter.presentCommand.mockResolvedValue('deny')
      expect((await f.run('rm /tmp/cancel-target')).ok).toBe(false)
      expect(f.sent).toEqual([])
      expect((await f.run('docker ps')).ok).toBe(true)
    } finally { onStaged = () => {}; await fs.rm(dir, { recursive: true, force: true }) }
  })
  it.each([0, 1, 2, 3, 4, 5])('does not absorb a clear %s microtasks after staging', async depth => {
    const dir = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'command-gate-race-'))
    const file = path.join(dir, 'private', 'credentials.json')
    let onStaged = () => {}
    const store = new CredentialStore(file, { fs: { rename: async (from, to) => { await fs.rename(from, to); onStaged() } } })
    await store.load()
    const client = await store.create('Agent')
    const profile = { id: 'p', name: 'Fixture SSH', type: 'ssh', options: { host: 'fixture.invalid', user: 'test' } }
    const digest = stableProfileDigest(profile)
    await store.setConnectionPermission(client, 'p', digest)
    const f = await fixture('ask', true, { permissions: store, client })
    f.presenter.presentCommand.mockResolvedValue('remember')
    let clearing: Promise<void> | undefined
    const schedule = (remaining: number, work: () => void) => {
      if (remaining === 0) work(); else queueMicrotask(() => schedule(remaining - 1, work))
    }
    onStaged = () => {
      onStaged = () => {}
      schedule(depth, () => { clearing = store.setCommandSet(client, 'p', digest, { inheritDefaults: false, rules: [] }, store.commandRevision()).catch(() => {}) })
    }
    try {
      const result = await f.run('rm /tmp/review-target')
      await clearing
      expect(result.ok).toBe(false)
      expect(f.sent).toEqual([])
    } finally { onStaged = () => {}; await fs.rm(dir, { recursive: true, force: true }) }
  })
  it('migrates legacy restricted grants to ask without expanding permission', () => {
    const grants = ['none', 'readonly', 'readwrite', 'full'].map((operationTier, i) => ({
      profileId: String(i), openSession: false, operationTier, profileDigest: 'a'.repeat(64), updatedAt: 'now',
    }))
    expect(readPermanentAuthorizations({ secureMcp: { permanentAuthorizations: grants } }).map(g => g.operationTier))
      .toEqual(['none', 'ask', 'ask', 'full'])
  })

  it('asks for each use after allow-once instead of permanently granting', async () => {
    const f = await fixture()
    f.presenter.presentCommand.mockResolvedValue('allow')
    expect((await f.run('docker ps')).ok).toBe(true)
    expect((await f.run('docker ps')).ok).toBe(true)
    expect(f.presenter.presentCommand).toHaveBeenCalledTimes(2)
    expect(f.permissions.setCommandSet).not.toHaveBeenCalled()
    expect(f.sent).toHaveLength(2)
  })

  it('remembers only the approved family on the current client and SSH', async () => {
    const f = await fixture()
    f.presenter.presentCommand.mockResolvedValueOnce('remember')
    expect((await f.run('uci get openclash.config.en_mode')).ok).toBe(true)
    expect((await f.run('uci get openclash.config.enable')).ok).toBe(true)
    expect(f.presenter.presentCommand).toHaveBeenCalledTimes(1)
    expect(await f.run('uci set openclash.config.enable=0')).toMatchObject({ ok: false })
    expect(f.presenter.presentCommand).toHaveBeenCalledTimes(2)
    expect(f.sent).toHaveLength(2)
  })

  it.each(['docker ps', 'ip -4 rule show', 'uci get openclash.config.en_mode', 'nft list table inet fw4'])(
    'auto-edit executes low-risk query %s without command approval', async command => {
      const f = await fixture('auto_edit')
      expect((await f.run(command)).ok).toBe(true)
      expect(f.presenter.presentCommand).not.toHaveBeenCalled()
    },
  )

  it('uses live global defaults in ask mode', async () => {
    const f = await fixture()
    f.defaults([{ kind: 'family', version: 1, argv: ['docker', 'ps'] }])
    expect((await f.run('docker ps')).ok).toBe(true)
    expect(f.presenter.presentCommand).not.toHaveBeenCalled()
  })

  it('auto-edit asks for dangerous commands on every request, ignoring previous rules', async () => {
    const f = await fixture('auto_edit')
    f.presenter.presentCommand.mockResolvedValue('allow')
    f.defaults([{ kind: 'family', version: 1, argv: ['rm'] }])
    expect((await f.run('rm /tmp/demo')).ok).toBe(true)
    expect((await f.run('rm /tmp/demo')).ok).toBe(true)
    expect(f.presenter.presentCommand).toHaveBeenCalledTimes(2)
    expect(f.presenter.presentCommand.mock.calls[0]?.[0]).toMatchObject({ allowRemember: false })
  })

  it('full access bypasses command approval but keeps syntax checks', async () => {
    const f = await fixture('full')
    expect((await f.run('rm /tmp/demo')).ok).toBe(true)
    expect(await f.run('ls | head')).toEqual({ ok: false, code: 'unsupported_command' })
    expect(f.presenter.presentCommand).not.toHaveBeenCalled()
  })

  it('distinguishes disabled execution from an approval denial', async () => {
    const f = await fixture('none')
    expect(await f.run('docker ps')).toEqual({ ok: false, code: 'command_disabled' })
    expect(f.profiles.openNewTabForProfile).not.toHaveBeenCalled()
  })

  it('combines missing connection authorization with the command prompt', async () => {
    const f = await fixture('ask', false)
    f.presenter.presentCommand.mockResolvedValue('allow')
    expect((await f.run('docker ps')).ok).toBe(true)
    expect(f.presenter.presentCommand.mock.calls[0]?.[0]).toMatchObject({ approveConnection: true })
    expect(f.presenter.presentOpen).not.toHaveBeenCalled()
    expect(f.permissions.setConnectionPermission).toHaveBeenCalledOnce()
  })

  it.each(['commands', 'mode'])('does not send after %s changes while opening SSH', async kind => {
    const f = await fixture('full')
    f.profiles.openNewTabForProfile.mockImplementationOnce(async () => {
      if (kind === 'commands') f.changeCommands(); else f.changeMode('ask')
      return f.tab
    })
    expect((await f.run('docker ps')).ok).toBe(false)
    expect(f.sent).toEqual([])
  })

  it('does not execute when persisting remembered approval fails', async () => {
    const f = await fixture()
    f.presenter.presentCommand.mockResolvedValue('remember')
    f.permissions.setCommandSet.mockRejectedValueOnce(new Error('disk full'))
    expect(await f.run('docker ps')).toEqual({ ok: false, code: 'approval_unavailable' })
    expect(f.sent).toEqual([])
    expect(f.profiles.openNewTabForProfile).not.toHaveBeenCalled()
  })

  it('reports an unknown outcome if dispatch throws during a guarded remembered command', async () => {
    const f = await fixture()
    f.presenter.presentCommand.mockResolvedValueOnce('remember')
    f.tab.sendInput = () => { throw new Error('terminal write failed') }
    expect(await f.run('rm /tmp/cancel-target')).toEqual({ ok: false, code: 'outcome_unknown' })
  })

  it('times out pending command approval without saving or sending', async () => {
    const f = await fixture()
    f.presenter.presentCommand.mockImplementation(() => new Promise(() => {}))
    const result = f.run('docker ps')
    await vi.waitFor(() => expect(f.presenter.presentCommand).toHaveBeenCalledOnce())
    f.advance(60_000)
    expect(await result).toEqual({ ok: false, code: 'expired' })
    expect(f.sent).toEqual([])
    expect(f.permissions.setCommandSet).not.toHaveBeenCalled()
  })

  it('keeps execution collection capped at 45 seconds after approval', async () => {
    const f = await fixture('full')
    f.tab.sendInput = data => { f.sent.push(data) }
    let settled = false
    const running = f.run('docker ps').then(result => { settled = true; return result })
    await vi.waitFor(() => expect(f.sent).toHaveLength(1))
    try {
      f.advance(45_000)
      await vi.waitFor(() => expect(settled).toBe(true))
      expect(await running).toEqual({ ok: false, code: 'outcome_unknown' })
    } finally { f.advance(15_000); await running }
  })

  it('does not keep a merged connection grant when cancelled during its save', async () => {
    const f = await fixture('ask', false)
    const abort = new AbortController()
    const save = f.permissions.setConnectionPermission.getMockImplementation()!
    f.presenter.presentCommand.mockResolvedValue('allow')
    f.permissions.setConnectionPermission.mockImplementation(async (...args) => {
      await save(...args)
      abort.abort()
    })
    expect(await f.run('docker ps', abort.signal)).toEqual({ ok: false, code: 'cancelled' })
    expect(f.permissions.hasConnectionPermission()).toBe(false)
    expect(f.sent).toEqual([])
  })
})
