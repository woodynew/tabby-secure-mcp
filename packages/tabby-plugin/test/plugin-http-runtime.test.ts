import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Subject } from 'rxjs'
vi.mock('@tabby-secure-mcp/companion', () => ({ APPROVAL_WINDOW_MS: 60_000, CredentialStore: class {}, EmbeddedMcpServer: class {} }))
import { PluginHttpRuntime } from '../src/runtime/plugin-http-runtime'
import { stableProfileDigest } from '../src/approval/profile-security-snapshot'

function fixture(main = true, enabled = false) {
  const options: any[] = []
  const credentials = { load: vi.fn(async () => {}), list: () => [], onChange: () => () => {}, hasUnpersistedRevocations: false, isCurrent: () => true, connectionRevision: () => 0 }
  const config = { store: { secureMcp: { http: { enabled, port: 50333 } } }, save: vi.fn(async () => {}) }
  const changes: (() => void)[] = []
  ;(config as any).changed$ = { subscribe(listener: () => void) { changes.push(listener); return { unsubscribe() {} } } }
  const lease = { grant: vi.fn(), clear: vi.fn(), getLeaseEpoch: () => 1 }
  const server = { start: vi.fn(async () => {}), close: vi.fn(async () => {}), sessionViews: () => [] }
  const audit = { append: vi.fn(async () => {}), safeAppend: vi.fn(async () => {}) }
  const gate = { requestOpen: vi.fn(async () => ({ ok: true, status: 'opened' })), runAuthorizedSshCommand: vi.fn(), describeOperationAuthorization: vi.fn(), approvalBusy: false }
  const authorized = { listAuthorizedProfiles: vi.fn(async () => [{ profile_ref: 'ref', display_name: 'QA' }]), clearRefCache: vi.fn() }
  const presenter = { presentClient: vi.fn(async () => 'session' as string | null) }
  const runtime = new PluginHttpRuntime(config as never, () => ({ isMainWindow: main, windowId: '1' }), lease as never, gate as never, authorized as never, audit as never, presenter as never, {
    credentials: credentials as never, createServer: (value: any) => { options.push(value); return server },
  })
  return { runtime, config, lease, server, audit, gate, options, presenter, credentials, authorized, emitChange: () => changes.forEach(listener => listener()) }
}

function fileFixture(enabled = true) {
  const f = fixture(true, true)
  const profile = { id: 'p', name: 'Fixture', type: 'ssh', options: { host: 'test.invalid' } }
  const target = { profileId: profile.id, profileDigest: stableProfileDigest(profile) }
  const changes = new Set<() => void>()
  let version = 0, reads = 0
  const remote = { read: vi.fn(async () => reads++ === 0 ? Buffer.from('abc') : new Uint8Array()), write: vi.fn(async () => {}), close: vi.fn(async () => {}) }
  const sftp = { stat: vi.fn(async () => ({ size: 3, isDirectory: false, mode: 0o100600 })), open: vi.fn(async () => remote), unlink: vi.fn(async () => {}) }
  const tab = { destroy: vi.fn(), input$: new Subject<void>(), session: { open: true },
    frontendReady$: new Subject<void>(), output$: new Subject<string>(), sendInput: vi.fn(), sshSession: { openSFTP: vi.fn(async () => sftp) } }
  Object.assign(f.authorized, { resolveAuthorizedProfile: async () => profile, resolveAuthorizedProfileNow: () => profile })
  Object.assign(f.credentials, {
    onChange: (listener: () => void) => { changes.add(listener); return () => changes.delete(listener) },
    fileTransferRevision: () => version,
    hasFileTransferPermission: (client: any, id: string, digest: string) => enabled && client.id === 'owner' && client.generation === 1 && id === target.profileId && digest === target.profileDigest,
    hasConnectionPermission: () => true,
  })
  f.gate.requestOpen.mockImplementation(async (request: any) => { request.onRetainedTab(tab, { ...target, session: tab.session, wasOpen: true, reusable: true, reused: false }); return { ok: true, status: 'opened' } })
  return { ...f, profile, tab, sftp, remote, setEnabled: (value: boolean) => { enabled = value; version++; for (const listener of changes) listener() } }
}

describe('plugin-owned HTTP runtime', () => {
  const context = (id = 'owner') => ({ requestId: 'f'.repeat(32), client: { id, name: 'Same name', generation: 1 }, signal: new AbortController().signal, deadlineMonotonicMs: performance.now() + 30000 })

  it('keeps file transfer off until explicitly granted to this client and profile', async () => {
    const f = fileFixture(false)
    await f.runtime.start()
    const request = { method: 'download_ssh_file', params: { profile_ref: 'ref', local_path: '/unused', remote_path: '/remote' } }
    expect(await f.options[0].dispatch(request, context())).toEqual({ ok: false, code: 'file_transfer_disabled' })
    f.setEnabled(true)
    expect(await f.options[0].dispatch(request, context('other'))).toEqual({ ok: false, code: 'file_transfer_disabled' })
    expect(f.gate.requestOpen).not.toHaveBeenCalled()
    expect(f.tab.sshSession.openSFTP).not.toHaveBeenCalled()
    f.runtime.destroy()
  })

  it('downloads through the authorized native SFTP channel and returns a cleanup reference', async () => {
    const f = fileFixture()
    const dir = await mkdtemp(path.join(tmpdir(), 'mcp-download-runtime-'))
    try {
      await f.runtime.start()
      const result = await f.options[0].dispatch({ method: 'download_ssh_file', params: { profile_ref: 'ref', local_path: path.join(dir, 'download'), remote_path: '/remote' } }, context())
      expect(result).toMatchObject({ ok: true, result: { status: 'downloaded', bytes_transferred: 3, tab_ref: expect.any(String) } })
      expect(await readFile(path.join(dir, 'download'), 'utf8')).toBe('abc')
      expect(f.tab.sendInput).not.toHaveBeenCalled()
      expect(f.remote.close).toHaveBeenCalledOnce()
      expect(f.tab.destroy).not.toHaveBeenCalled()
      expect((await f.options[0].dispatch({ method: 'close_mcp_ssh_tab', params: { tab_ref: result.result.tab_ref } }, context())).ok).toBe(true)
      expect(f.tab.destroy).toHaveBeenCalledOnce()
    } finally { f.runtime.destroy(); await rm(dir, { recursive: true, force: true }) }
  })

  it('revokes active downloads before their next write and preserves existing local files', async () => {
    const f = fileFixture()
    const dir = await mkdtemp(path.join(tmpdir(), 'mcp-download-revoke-'))
    const localPath = path.join(dir, 'download')
    try {
      await f.runtime.start()
      const request = { method: 'download_ssh_file', params: { profile_ref: 'ref', local_path: localPath, remote_path: '/remote' } }
      await writeFile(localPath, 'keep')
      expect(await f.options[0].dispatch(request, context())).toEqual({ ok: false, code: 'file_exists' })
      expect(await readFile(localPath, 'utf8')).toBe('keep')
      await rm(localPath)
      f.remote.read.mockImplementationOnce(async () => { f.setEnabled(false); return Buffer.from('abc') })
      const revoked = await f.options[0].dispatch(request, context())
      expect(revoked.ok).toBe(false)
      await expect(access(localPath)).rejects.toThrow()
      expect(f.remote.read).toHaveBeenCalledOnce()
    } finally { f.runtime.destroy(); await rm(dir, { recursive: true, force: true }) }
  })

  async function trackedOpen(f: ReturnType<typeof fixture>, tab: { destroy(): void | Promise<void> }, owner = context()) {
    f.gate.requestOpen.mockImplementationOnce(async (request: any) => { request.onRetainedTab?.(tab); return { ok: true, status: 'opened' } })
    const opened = await f.options[0].dispatch({ method: 'open_authorized_ssh_profile', params: { profile_ref: 'ref' } }, owner)
    expect(opened).toMatchObject({ ok: true, result: { status: 'opened', tab_ref: expect.any(String) } })
    return opened.result.tab_ref as string
  }

  it('returns a close handle and refuses manual, foreign-client and old-generation targets', async () => {
    const f = fixture(true, true)
    await f.runtime.start()
    const tab = { destroy: vi.fn() }
    const ref = await trackedOpen(f, tab)
    const close = { method: 'close_mcp_ssh_tab', params: { tab_ref: ref } }
    for (const wrong of [context('other'), { ...context(), client: { ...context().client, generation: 2 } }]) {
      expect(await f.options[0].dispatch(close, wrong)).toEqual({ ok: false, code: 'target_unavailable' })
    }
    expect(await f.options[0].dispatch({ method: 'close_mcp_ssh_tab', params: { tab_ref: 'native-tab-id' } }, context())).toEqual({ ok: false, code: 'target_unavailable' })
    expect(tab.destroy).not.toHaveBeenCalled()
    expect(await f.options[0].dispatch(close, context())).toEqual({ ok: true, result: { status: 'closed' } })
    expect(tab.destroy).toHaveBeenCalledOnce()
    expect(await f.options[0].dispatch(close, context())).toEqual({ ok: false, code: 'target_unavailable' })
    f.runtime.destroy()
  })

  it('refuses closing before durable audit or after cancellation during audit', async () => {
    const f = fixture(true, true)
    await f.runtime.start()
    const tab = { destroy: vi.fn() }
    const ref = await trackedOpen(f, tab)
    const close = { method: 'close_mcp_ssh_tab', params: { tab_ref: ref } }
    f.audit.append.mockRejectedValueOnce(new Error('disk full'))
    expect(await f.options[0].dispatch(close, context())).toEqual({ ok: false, code: 'audit_unavailable' })
    expect(tab.destroy).not.toHaveBeenCalled()
    const abort = new AbortController()
    f.audit.append.mockImplementationOnce(async () => { abort.abort() })
    expect(await f.options[0].dispatch(close, { ...context(), signal: abort.signal })).toEqual({ ok: false, code: 'cancelled' })
    expect(tab.destroy).not.toHaveBeenCalled()
    f.runtime.destroy()
  })

  it('reports outcome_unknown if close result audit fails after destroying the tab', async () => {
    const f = fixture(true, true)
    await f.runtime.start()
    const tab = { destroy: vi.fn() }
    const ref = await trackedOpen(f, tab)
    f.audit.append.mockImplementation(async (event: any) => { if (event.event === 'tab_close_result') throw new Error('disk full') })
    expect(await f.options[0].dispatch({ method: 'close_mcp_ssh_tab', params: { tab_ref: ref } }, context())).toEqual({ ok: false, code: 'outcome_unknown' })
    expect(tab.destroy).toHaveBeenCalledOnce()
    f.runtime.destroy()
  })

  it('does not close a tab after the request deadline has expired', async () => {
    const f = fixture(true, true)
    await f.runtime.start()
    const tab = { destroy: vi.fn() }
    const ref = await trackedOpen(f, tab)
    expect(await f.options[0].dispatch({ method: 'close_mcp_ssh_tab', params: { tab_ref: ref } }, { ...context(), deadlineMonotonicMs: performance.now() - 1 })).toEqual({ ok: false, code: 'expired' })
    expect(tab.destroy).not.toHaveBeenCalled()
    f.runtime.destroy()
  })

  it('invalidates close handles on service restart without closing retained tabs', async () => {
    const f = fixture(true, true)
    await f.runtime.start()
    const tab = { destroy: vi.fn() }
    const ref = await trackedOpen(f, tab)
    await f.runtime.setServerConfig(true, 50334)
    const current = f.options[f.options.length - 1]
    expect(await current.dispatch({ method: 'close_mcp_ssh_tab', params: { tab_ref: ref } }, context())).toEqual({ ok: false, code: 'target_unavailable' })
    expect(tab.destroy).not.toHaveBeenCalled()
    f.runtime.destroy()
  })

  it('returns a close handle only when a command leaves a retained tab', async () => {
    const f = fixture(true, true)
    await f.runtime.start()
    const tab = { destroy: vi.fn() }
    const request = { method: 'run_authorized_ssh_command', params: { profile_ref: 'ref', command: 'id' } }
    f.gate.runAuthorizedSshCommand.mockImplementationOnce(async (input: any) => { input.onRetainedTab?.(tab); return { ok: true, commandRisk: 'low', output: 'ok', truncated: false } })
    const retained = await f.options[0].dispatch(request, context())
    expect(retained).toMatchObject({ ok: true, result: { tab_ref: expect.any(String) } })
    expect(await f.options[0].dispatch({ method: 'close_mcp_ssh_tab', params: { tab_ref: retained.result.tab_ref } }, context())).toEqual({ ok: true, result: { status: 'closed' } })
    f.gate.runAuthorizedSshCommand.mockResolvedValueOnce({ ok: true, commandRisk: 'low', output: 'ok', truncated: false })
    expect((await f.options[0].dispatch(request, context())).result).not.toHaveProperty('tab_ref')
    f.runtime.destroy()
  })

  it('gives the client approval presenter a full minute', async () => {
    const f = fixture(true, true)
    await f.runtime.start()
    const before = performance.now()
    await f.options[0].approveClient({ id: 'id', name: 'Agent', generation: 1 }, new AbortController().signal, 'declared')
    const [view, context] = f.presenter.presentClient.mock.calls[0] as unknown as [any, any]
    expect(view.remainingSeconds).toBe(60)
    expect(context.deadlineMonotonicMs - before).toBeGreaterThanOrEqual(60_000)
    expect(context.remainingSeconds()).toBe(60)
    f.runtime.destroy()
  })
  it('preserves a known pre-dispatch audit failure when result audit is also unavailable', async () => {
    const f = fixture(true, true)
    await f.runtime.start()
    f.gate.runAuthorizedSshCommand.mockResolvedValueOnce({ ok: false, code: 'audit_unavailable' })
    f.audit.append.mockRejectedValueOnce(new Error('read-only audit'))
    const result = await f.options[0].dispatch({ method: 'run_authorized_ssh_command', params: { profile_ref: 'ref', command: 'id' } }, { requestId: 'e'.repeat(32), client: { id: 'id', name: 'QA', generation: 1 }, signal: new AbortController().signal, deadlineMonotonicMs: performance.now() + 45000 })
    expect(result).toEqual({ ok: false, code: 'audit_unavailable' })
  })
  it('does not let a disposed UI observer interrupt service shutdown', async () => {
    const f = fixture(true, true)
    await f.runtime.start()
    f.runtime.onChange(() => { throw new Error('view disposed') })
    expect(() => f.runtime.destroy()).not.toThrow()
    expect(f.server.close).toHaveBeenCalledOnce()
  })
  it('records an uncertain command outcome after dispatched cancellation', async () => {
    const f = fixture(true, true)
    await f.runtime.start()
    f.gate.runAuthorizedSshCommand.mockResolvedValueOnce({ ok: false, code: 'outcome_unknown' })
    const requestId = 'c'.repeat(32)
    const result = await f.options[0].dispatch({ method: 'run_authorized_ssh_command', params: { profile_ref: 'ref', command: 'id' } }, { requestId, client: { id: 'id', name: 'QA', generation: 1 }, signal: new AbortController().signal, deadlineMonotonicMs: performance.now() + 45000 })
    expect(result).toEqual({ ok: false, code: 'outcome_unknown' })
    expect(f.audit.append).toHaveBeenCalledWith({ event: 'command_result', result: 'error', requestId, errorCode: 'outcome_unknown' })
  })
  it('rechecks client approval busy after durable open intent', async () => {
    const f = fixture(true, true)
    await f.runtime.start()
    let releaseAudit!: () => void
    let releaseClient!: (value: null) => void
    f.audit.append.mockImplementation(async (event: any) => { if (event.event === 'open_requested') await new Promise<void>(resolve => { releaseAudit = resolve }) })
    f.presenter.presentClient.mockImplementation(() => new Promise(resolve => { releaseClient = resolve }))
    const context = { requestId: 'd'.repeat(32), client: { id: 'id', name: 'QA', generation: 1 }, signal: new AbortController().signal, deadlineMonotonicMs: performance.now() + 30000 }
    const opening = f.options[0].dispatch({ method: 'open_authorized_ssh_profile', params: { profile_ref: 'ref' } }, context)
    await vi.waitFor(() => expect(releaseAudit).toBeTypeOf('function'))
    const approving = f.options[0].approveClient(context.client, context.signal, 'declared')
    releaseAudit()
    expect(await opening).toEqual({ ok: false, code: 'busy' })
    expect(f.gate.requestOpen).not.toHaveBeenCalled()
    releaseClient(null)
    await approving
  })
  it('updates getter-only structural ConfigProxy fields and rolls back failed saves', async () => {
    const f = fixture()
    const section = { enabled: false, port: 50333 }
    Object.defineProperty(f.config.store.secureMcp, 'http', { get: () => section })
    await f.runtime.start()
    f.config.save.mockRejectedValueOnce(new Error('disk full'))
    await expect(f.runtime.setServerConfig(true, 50334)).rejects.toThrow('not saved')
    expect(section).toEqual({ enabled: false, port: 50333 })
    f.emitChange()
    await f.runtime.setServerConfig(true, 50334)
    expect(section).toEqual({ enabled: true, port: 50334 })
    expect(f.server.start).toHaveBeenCalledOnce()
  })
  it('closes the authorization barrier synchronously on external service disable', async () => {
    const f = fixture(true, true)
    await f.runtime.start()
    f.lease.clear.mockClear()
    f.config.store.secureMcp.http.enabled = false
    f.emitChange()
    expect(f.lease.clear).toHaveBeenCalledOnce()
    expect(f.server.close).toHaveBeenCalledOnce()
  })
  it('keeps invalid port configuration repairable without listening', async () => {
    const f = fixture(true, true)
    f.config.store.secureMcp.http.port = 0
    await f.runtime.start()
    expect(f.runtime.status).toBe('error')
    expect(f.runtime.serverConfig()).toEqual({ enabled: false, port: 50333 })
    expect(f.server.start).not.toHaveBeenCalled()
  })
  it('stays disabled by default and never starts in a secondary window', async () => {
    const disabled = fixture()
    await disabled.runtime.start()
    expect(disabled.server.start).not.toHaveBeenCalled()
    const secondary = fixture(false, true)
    await secondary.runtime.start()
    expect(secondary.server.start).not.toHaveBeenCalled()
    await expect(secondary.runtime.setServerConfig(true, 50333)).rejects.toThrow()
  })
  it('activates only after configuration has persisted', async () => {
    const f = fixture()
    await f.runtime.start()
    f.config.save.mockRejectedValueOnce(new Error('disk full'))
    await expect(f.runtime.setServerConfig(true, 50333)).rejects.toThrow()
    expect(f.server.start).not.toHaveBeenCalled()
    await f.runtime.setServerConfig(true, 50333)
    expect(f.server.start).toHaveBeenCalledOnce()
  })
  it('invalidates the lease synchronously on destruction and refuses stale dispatch', async () => {
    const f = fixture(true, true)
    await f.runtime.start()
    f.runtime.destroy()
    expect(f.lease.clear).toHaveBeenCalled()
    const result = await f.options[0].dispatch({ method: 'open_authorized_ssh_profile', params: { profile_ref: 'ref' } }, { requestId: 'a'.repeat(32), client: { id: 'id', name: 'My agent', generation: 1 }, signal: new AbortController().signal, deadlineMonotonicMs: performance.now() + 30000 })
    expect(result).toEqual({ ok: false, code: 'plugin_unavailable' })
    expect(f.gate.requestOpen).not.toHaveBeenCalled()
  })
  it('returns outcome_unknown when result audit fails after an open', async () => {
    const f = fixture(true, true)
    await f.runtime.start()
    f.audit.append.mockImplementation(async (event: any) => { if (event.event === 'open_result') throw new Error('disk full') })
    const result = await f.options[0].dispatch({ method: 'open_authorized_ssh_profile', params: { profile_ref: 'ref' } }, { requestId: 'b'.repeat(32), client: { id: 'id', name: 'My agent', generation: 1 }, signal: new AbortController().signal, deadlineMonotonicMs: performance.now() + 30000 })
    expect(f.gate.requestOpen).toHaveBeenCalledOnce()
    expect(result).toEqual({ ok: false, code: 'outcome_unknown' })
  })
})
