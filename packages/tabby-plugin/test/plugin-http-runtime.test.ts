import { describe, expect, it, vi } from 'vitest'
vi.mock('@tabby-secure-mcp/companion', () => ({ APPROVAL_WINDOW_MS: 60_000, CredentialStore: class {}, EmbeddedMcpServer: class {} }))
import { PluginHttpRuntime } from '../src/runtime/plugin-http-runtime'

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
  return { runtime, config, lease, server, audit, gate, options, presenter, emitChange: () => changes.forEach(listener => listener()) }
}

describe('plugin-owned HTTP runtime', () => {
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
