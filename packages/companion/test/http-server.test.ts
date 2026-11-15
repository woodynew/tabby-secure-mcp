import { request, type Server } from 'node:http'
import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { EmbeddedMcpServer } from '../src/http/server.js'
import type { ApprovalDuration, ClientCredentialView, ClientIdentity, ClientPermission, CredentialStorePort, EmbeddedMcpOptions, HttpCallContext } from '../src/http/contracts.js'

class Credentials implements CredentialStorePort {
  records: ClientCredentialView[] = ['A', 'B'].map(id => ({ id, name: 'same name', generation: 1, permission: { kind: 'none' } }))
  listeners = new Set<(id: string) => void>()
  hasUnpersistedRevocations = false
  async load() {}
  list() { return this.records }
  async create(): Promise<ClientCredentialView> { throw new Error('unused') }
  async rename(id: string, name: string) { this.records.find(c => c.id === id)!.name = name }
  async reset(id: string) { await this.revoke(id) }
  async revoke(id: string) { this.records.find(c => c.id === id)!.generation++; this.listeners.forEach(fn => fn(id)) }
  async setPermission(): Promise<void> { throw new Error('Use the real credential-store integration for permission changes') }
  consumeSessionPermission(): boolean { return false }
  tokenFor(id: string) { return `token-${id}` }
  authenticate(token: string) { return this.records.find(c => token === this.tokenFor(c.id) && c.generation === 1) }
  isCurrent(client: ClientIdentity) { return this.records.some(c => c.id === client.id && c.generation === client.generation && c.generation === 1) }
  permission(id: string): ClientPermission { return this.records.find(c => c.id === id)!.permission }
  async grant(id: string, generation: number, duration: '24h' | 'permanent') {
    const c = this.records.find(c => c.id === id)!
    if (c.generation !== generation) throw new Error('stale')
    c.permission = duration === 'permanent' ? { kind: 'permanent', approvedAt: Date.now() } : { kind: 'until', approvedAt: Date.now(), expiresAt: Date.now() + 86_400_000 }
  }
  onInvalidated(fn: (id: string) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  onChange() { return () => {} }
}

const servers: EmbeddedMcpServer[] = []
const clients: Client[] = []
const sockets: Socket[] = []
afterEach(async () => {
  vi.useRealTimers()
  sockets.splice(0).forEach(s => s.destroy())
  await Promise.all(clients.splice(0).map(c => c.close()))
  await Promise.all(servers.splice(0).map(s => s.close()))
})

async function setup(overrides: Partial<EmbeddedMcpOptions> = {}, credentials = new Credentials()) {
  const calls: HttpCallContext[] = []
  const options: EmbeddedMcpOptions = {
    port: 0, credentials,
    approveClient: async () => 'session', audit: async () => {},
    dispatch: async (_r, ctx) => { calls.push(ctx); return { ok: true, result: { profiles: [] } } },
    ...overrides,
  }
  const server = new EmbeddedMcpServer(options)
  servers.push(server)
  await server.start()
  const address = (server as unknown as { httpServer: Server }).httpServer.address() as { port: number; address: string }
  expect(address.address).toBe('127.0.0.1')
  const url = `http://127.0.0.1:${address.port}/mcp`
  return { server, url, options, calls, credentials, port: address.port }
}

async function sdk(url: string, id = 'A') {
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer token-${id}` } } })
  const client = new Client({ name: 'test\u001bclient', version: '1' }, { capabilities: {}, supportedProtocolVersions: ['2025-11-25'] })
  clients.push(client)
  await client.connect(transport)
  return { client, transport }
}
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }
function raw(url: string, body: unknown = init, headers: Record<string, string> = {}, method = 'POST') {
  if (headers.Host) return new Promise<Response>((resolve, reject) => {
    const req = request(url, { method, headers: { Authorization: 'Bearer token-A', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...headers } }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode! })))
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
  return fetch(url, { method, headers: { Authorization: 'Bearer token-A', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...headers }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) })
}
async function approved(server: EmbeddedMcpServer, count = 1) { await vi.waitFor(() => expect(server.sessionViews().filter(s => s.state === 'approved')).toHaveLength(count)) }
const listCall = { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'list_authorized_ssh_profiles', arguments: {} } }

describe('embedded HTTP trust and session boundaries', () => {
  it('shows the edited credential name for an existing connection without changing its permission', async () => {
    const h = await setup()
    const { client } = await sdk(h.url)
    await approved(h.server)
    await h.credentials.rename('A', 'Office AI client')
    expect(h.server.sessionViews()[0]?.clientName).toBe('Office AI client')
    await client.callTool({ name: 'list_authorized_ssh_profiles', arguments: {} })
    expect(h.calls[0]?.client.name).toBe('Office AI client')
    expect(h.credentials.permission('A')).toEqual({ kind: 'none' })
  })
  it('authenticates before reading JSON or allocating approval and rejects browser/proxy hosts', async () => {
    const approve = vi.fn(async () => 'session' as const)
    const h = await setup({ approveClient: approve })
    for (const [headers, status] of [
      [{ Authorization: 'Bearer bad-secret' }, 401],
      [{ Origin: 'null' }, 403],
      [{ Host: `localhost:${h.port}` }, 403],
      [{ Host: 'evil.test', 'X-Forwarded-Host': `127.0.0.1:${h.port}` }, 403],
    ] as const) {
      const res = await raw(h.url, ['invalid'], headers)
      expect(res.status, JSON.stringify(headers)).toBe(status)
      expect(await res.text()).not.toContain('bad-secret')
    }
    expect(approve).not.toHaveBeenCalled()
    expect(h.server.sessionViews()).toEqual([])
  })

  it('rejects batch, oversized strings, deep JSON, and bodies above 64 KiB', async () => {
    const h = await setup()
    let nested: unknown = 'leaf'
    for (let i = 0; i < 17; i++) nested = { a: nested }
    for (const body of [[init], { ...init, extra: 'x'.repeat(8193) }, nested, { a: 'x'.repeat(65536) }]) {
      expect([400, 413]).toContain((await raw(h.url, body)).status)
    }
    expect(h.server.sessionViews()).toEqual([])
  })

  it('returns 405 for GET/OPTIONS and never advertises SSE or CORS', async () => {
    const h = await setup()
    for (const method of ['GET', 'OPTIONS']) {
      const res = await raw(h.url, undefined, {}, method)
      expect(res.status).toBe(405)
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    }
  })

  it('does not approve an initialize rejected by the SDK parameter validation', async () => {
    const approve = vi.fn(async () => 'permanent' as const)
    const h = await setup({ approveClient: approve })
    const response = await raw(h.url, { ...init, params: { protocolVersion: '2025-11-25' } })
    expect((await response.json()).error).toBeDefined()
    expect(h.server.sessionViews()).toEqual([])
    expect(approve).not.toHaveBeenCalled()
  })

  it('does not treat a completed response followed by TCP close as session cancellation', async () => {
    const h = await setup()
    const { client, transport } = await sdk(h.url)
    await approved(h.server)
    const res = await raw(h.url, listCall, { 'Mcp-Session-Id': transport.sessionId!, Connection: 'close' })
    expect((await res.json()).result.structuredContent).toEqual({ profiles: [] })
    expect(h.calls[0].signal.aborted).toBe(false)
    expect(h.server.sessionViews()[0].state).toBe('approved')
    expect((await client.callTool({ name: 'list_authorized_ssh_profiles', arguments: {} })).isError).toBeFalsy()
  })

  it('cancels through the SDK client AbortSignal as well as legacy notifications', async () => {
    let ctx!: HttpCallContext
    let release!: () => void
    const h = await setup({ dispatch: async (_r, context) => { ctx = context; await new Promise<void>(r => { release = r }); return { ok: true, result: { profiles: [] } } } })
    const { client } = await sdk(h.url)
    await approved(h.server)
    const controller = new AbortController()
    const result = client.callTool({ name: 'list_authorized_ssh_profiles', arguments: {} }, { signal: controller.signal }).catch(error => error)
    await vi.waitFor(() => expect(ctx).toBeDefined())
    controller.abort()
    await vi.waitFor(() => expect(ctx.signal.aborted).toBe(true))
    release()
    await result
    expect(h.server.sessionViews()[0].state).toBe('approved')
  })

  it('lists static tools but refuses calls while approval is pending; does not replay', async () => {
    let approve!: (v: ApprovalDuration) => void
    const h = await setup({ approveClient: async () => new Promise(r => { approve = r }) })
    const { client } = await sdk(h.url)
    expect((await client.listTools()).tools).toHaveLength(4)
    expect((await client.callTool({ name: 'list_authorized_ssh_profiles', arguments: {} })).isError).toBe(true)
    expect(h.calls).toEqual([])
    approve('session')
    await approved(h.server)
    expect(h.calls).toEqual([])
    expect((await client.callTool({ name: 'list_authorized_ssh_profiles', arguments: {} })).structuredContent).toEqual({ profiles: [] })
    expect(h.calls[0].requestId).toMatch(/^[a-f0-9]{32}$/)
    expect(h.calls[0].signal.aborted).toBe(false)
  })

  it('bounds pending approval to one and destroys denied sessions', async () => {
    let deny!: (v: null) => void
    const h = await setup({ approveClient: async () => new Promise(r => { deny = r }) })
    await sdk(h.url)
    expect((await raw(h.url, init, { Authorization: 'Bearer token-B' })).status).toBe(503)
    deny(null)
    await vi.waitFor(() => expect(h.server.sessionViews()).toEqual([]))
  })

  it('binds session IDs and permanent restoration to credential and generation', async () => {
    const approve = vi.fn(async () => 'permanent' as const)
    const h = await setup({ approveClient: approve })
    const { transport } = await sdk(h.url)
    await approved(h.server)
    expect(h.credentials.permission('A').kind).toBe('permanent')
    const sid = transport.sessionId!
    expect((await raw(h.url, listCall, { 'Mcp-Session-Id': sid, Authorization: 'Bearer token-B' })).status).toBe(404)
    expect((await raw(h.url, undefined, { 'Mcp-Session-Id': sid }, 'DELETE')).status).toBe(200)
    expect(h.server.sessionViews()).toEqual([])
    await sdk(h.url)
    await approved(h.server)
    expect(approve).toHaveBeenCalledTimes(1)
    await h.credentials.revoke('A')
    expect(h.server.sessionViews()).toEqual([])
    expect((await raw(h.url, init)).status).toBe(401)
    await sdk(h.url, 'B')
    await approved(h.server)
    expect(approve).toHaveBeenCalledTimes(2)
  })

  it('does not let a rejected foreign credential corrupt reconnect admission', async () => {
    const h = await setup({ approveClient: async () => 'permanent' })
    const { transport } = await sdk(h.url)
    await approved(h.server)
    expect((await raw(h.url, listCall, { 'Mcp-Session-Id': transport.sessionId!, Authorization: 'Bearer token-B' })).status).toBe(404)
    expect((await raw(h.url)).status).toBe(200)
    await approved(h.server)
  })

  it('preserves permanent sessions beyond 24 hours', async () => {
    const permanent = await setup({ approveClient: async () => 'permanent' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    await (await raw(permanent.url)).text()
    expect(permanent.server.sessionViews()[0].duration).toBe('permanent')
    await vi.advanceTimersByTimeAsync(86_400_001)
    expect(permanent.server.sessionViews()[0].duration).toBe('permanent')
  })

  it('expires session-only approval at 24 hours without persisting a permission', async () => {
    const h = await setup()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    await (await raw(h.url)).text()
    expect(h.server.sessionViews()[0].duration).toBe('session')
    expect(h.credentials.permission('A')).toEqual({ kind: 'none' })
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(h.server.sessionViews()).toEqual([])
  })

  it('restores permanent permission after service restart only after reliable audit', async () => {
    const credentials = new Credentials()
    const approve = vi.fn(async () => 'permanent' as const)
    const first = await setup({ approveClient: approve }, credentials)
    const { transport } = await sdk(first.url)
    await approved(first.server)
    const oldId = transport.sessionId!
    await first.server.close()
    const audit = vi.fn(async () => {})
    const second = await setup({ approveClient: approve, audit }, credentials)
    expect((await raw(second.url, listCall, { 'Mcp-Session-Id': oldId })).status).toBe(404)
    await sdk(second.url)
    await approved(second.server)
    expect(approve).toHaveBeenCalledTimes(1)
    expect(audit).toHaveBeenCalledWith('pairing_decision', 'ok')
  })

  it('isolates synchronous revocation to that credential and aborts its dispatch', async () => {
    const contexts: HttpCallContext[] = []
    const releases: (() => void)[] = []
    const h = await setup({ dispatch: async (_r, context) => { contexts.push(context); await new Promise<void>(r => releases.push(r)); return { ok: true, result: { profiles: [] } } } })
    const a = await sdk(h.url)
    await approved(h.server)
    const b = await sdk(h.url, 'B')
    await approved(h.server, 2)
    const callA = a.client.callTool({ name: 'list_authorized_ssh_profiles', arguments: {} }).catch(() => undefined)
    const callB = b.client.callTool({ name: 'list_authorized_ssh_profiles', arguments: {} })
    await vi.waitFor(() => expect(contexts).toHaveLength(2))
    const revoked = h.credentials.revoke('A')
    expect(contexts.find(c => c.client.id === 'A')!.signal.aborted).toBe(true)
    expect(contexts.find(c => c.client.id === 'B')!.signal.aborted).toBe(false)
    expect(h.server.sessionViews().map(s => s.clientId)).toEqual(['B'])
    releases.forEach(r => r())
    await revoked
    await callA
    expect((await callB).isError).toBeFalsy()
  })

  it('keeps approval fenced when the UI callback throws during close', async () => {
    let fail = false
    const h = await setup({ onChange: () => { if (fail) throw new Error('UI disposed') } })
    await sdk(h.url)
    await approved(h.server)
    fail = true
    const closing = h.server.close()
    expect(h.server.sessionViews()).toEqual([])
    await expect(closing).resolves.toBeUndefined()
  })

  it('enforces 5-second header and 10-second body deadlines without a total tool timeout', async () => {
    const h = await setup()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const accepted = new Promise<void>(resolve => (h.server as unknown as { httpServer: Server }).httpServer.once('connection', () => resolve()))
    const socket = connect(h.port, '127.0.0.1'); sockets.push(socket)
    socket.on('error', () => {})
    await new Promise<void>(r => socket.once('connect', r))
    await accepted
    let closed = false
    socket.once('close', () => { closed = true })
    await vi.advanceTimersByTimeAsync(5_000)
    await new Promise<void>(r => { if (closed) r(); else socket.once('close', r) })
    const slow = connect(h.port, '127.0.0.1'); sockets.push(slow)
    slow.on('error', () => {})
    await new Promise<void>(r => slow.once('connect', r))
    let response = ''
    slow.on('data', data => { response += data.toString() })
    const slowClosed = new Promise<void>(resolve => slow.once('close', () => resolve()))
    const received = new Promise<void>(resolve => (h.server as unknown as { httpServer: Server }).httpServer.once('request', () => resolve()))
    slow.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nAuthorization: Bearer token-A\r\nContent-Type: application/json\r\nContent-Length: 50\r\n\r\n{`)
    // Wait for request headers to arrive before starting the separate body clock.
    await received
    await vi.advanceTimersByTimeAsync(10_000)
    await slowClosed
    expect(response).toContain('408')
    expect(h.server.sessionViews()).toEqual([])
  })

  it('applies a 30-second dispatch deadline and hides thrown details as outcome unknown', async () => {
    let context!: HttpCallContext
    let release!: () => void
    const h = await setup({ dispatch: async (_r, ctx) => { context = ctx; await new Promise<void>(r => { release = r }); throw new Error('secret stack token') } })
    const { transport } = await sdk(h.url)
    await approved(h.server)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const running = raw(h.url, listCall, { 'Mcp-Session-Id': transport.sessionId! })
    while (!context) await new Promise<void>(r => setImmediate(r))
    await vi.advanceTimersByTimeAsync(10_001)
    expect(context.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(context.signal.aborted).toBe(true)
    const text = await (await running).text()
    expect(text).toContain('do not retry automatically')
    expect(text).not.toContain('secret stack token')
    release()
  })

  it('keeps an SSH open request alive for a full minute while preserving the command deadline', async () => {
    let context!: HttpCallContext
    const h = await setup({ dispatch: async (_r, ctx) => {
      context = ctx
      return await new Promise(resolve => ctx.signal.addEventListener('abort', () => resolve({ ok: false, code: 'not_approved' }), { once: true }))
    } })
    const { transport } = await sdk(h.url)
    await approved(h.server)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const opening = raw(h.url, { ...listCall, params: { name: 'open_authorized_ssh_profile', arguments: { profile_ref: 'ref' } } }, { 'Mcp-Session-Id': transport.sessionId! })
    while (!context) await new Promise<void>(resolve => setImmediate(resolve))
    const start = performance.now()
    expect(context.deadlineMonotonicMs - start).toBe(60_000)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(context.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(context.signal.aborted).toBe(true)
    await (await opening).text()
  })

  it('enforces approval timeout, finite expiry, and no finite extension on backward clock/reconnect', async () => {
    const h = await setup({ approveClient: async () => new Promise(() => {}) })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const response = await raw(h.url)
    expect(response.status).toBe(200)
    expect(h.server.sessionViews()[0].state).toBe('pending')
    await vi.advanceTimersByTimeAsync(59_999)
    expect(h.server.sessionViews()[0]?.state).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(h.server.sessionViews()).toEqual([])
    vi.useRealTimers()
    await h.server.close()
    const credentials = new Credentials()
    const approvedAt = Date.now() - 86_390_000
    credentials.records[0].permission = { kind: 'until', approvedAt, expiresAt: approvedAt + 86_400_000 }
    const finite = await setup({}, credentials)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const first = await raw(finite.url)
    const sid = first.headers.get('mcp-session-id')!
    await first.text()
    expect(finite.server.sessionViews()[0].duration).toBe('24h')
    await vi.advanceTimersByTimeAsync(4_000)
    expect((await raw(finite.url, undefined, { 'Mcp-Session-Id': sid }, 'DELETE')).status).toBe(200)
    vi.setSystemTime(Date.now() - 3_600_000)
    await raw(finite.url)
    expect(finite.server.sessionViews()[0].state).toBe('approved')
    await vi.advanceTimersByTimeAsync(6_001)
    expect(finite.server.sessionViews()).toEqual([])
  })

  it('aborts on SDK cancellation and returns outcome unknown if dispatch ignored it', async () => {
    let ctx!: HttpCallContext
    let release!: () => void
    const h = await setup({ dispatch: async (_r, context) => { ctx = context; await new Promise<void>(r => { release = r }); return { ok: true, result: { profiles: [] } } } })
    const { transport } = await sdk(h.url)
    await approved(h.server)
    const running = raw(h.url, listCall, { 'Mcp-Session-Id': transport.sessionId! })
    await vi.waitFor(() => expect(ctx).toBeDefined())
    const cancel = await raw(h.url, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 10, reason: 'test' } }, { 'Mcp-Session-Id': transport.sessionId! })
    expect(cancel.status).toBe(202)
    await vi.waitFor(() => expect(ctx.signal.aborted).toBe(true))
    release()
    const text = await (await running).text()
    expect(text).not.toContain('profiles')
    expect(h.server.sessionViews()[0].state).toBe('approved')
  })

  it('keeps 4-call admission occupied until an abort-ignoring dispatcher settles', async () => {
    const contexts: HttpCallContext[] = []
    const releases: (() => void)[] = []
    const h = await setup({ dispatch: async (_r, ctx) => { contexts.push(ctx); await new Promise<void>(r => releases.push(r)); return { ok: true, result: { profiles: [] } } } })
    const { client } = await sdk(h.url)
    await approved(h.server)
    const running = Array.from({ length: 4 }, () => client.callTool({ name: 'list_authorized_ssh_profiles', arguments: {} }))
    await vi.waitFor(() => expect(contexts).toHaveLength(4))
    const denied = await client.callTool({ name: 'list_authorized_ssh_profiles', arguments: {} })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied)).toContain('in progress')
    releases.forEach(r => r())
    await Promise.all(running)
  })

  it('bounds active sessions at eight even when initializer tokens refill', async () => {
    const credentials = new Credentials()
    credentials.records = Array.from({ length: 9 }, (_, i) => ({ id: String(i), generation: 1, name: 'client', permission: { kind: 'permanent', approvedAt: Date.now() } }))
    const h = await setup({}, credentials)
    const now = vi.spyOn(performance, 'now')
    try {
      for (let i = 0; i < 8; i++) {
        now.mockReturnValue(i * 6_000 + 10_000)
        const res = await raw(h.url, init, { Authorization: `Bearer token-${i}` })
        expect(res.status).toBe(200)
        await res.text()
        await approved(h.server, i + 1)
      }
      expect((await raw(h.url, init, { Authorization: 'Bearer token-8' })).status).toBe(503)
      expect(h.server.sessionViews()).toHaveLength(8)
    } finally { now.mockRestore() }
  })

  it('rejects UTF-8 commands above 512 bytes without dispatching', async () => {
    const h = await setup()
    const { client } = await sdk(h.url)
    await approved(h.server)
    const result = await client.callTool({ name: 'run_authorized_ssh_command', arguments: { profile_ref: 'ref', command: '中'.repeat(171) } })
    expect(result.isError).toBe(true)
    expect(h.calls).toEqual([])
  })

  it('refuses restoration or activation when reliable audit or grant persistence fails', async () => {
    const credentials = new Credentials()
    await credentials.grant('A', 1, 'permanent')
    const h = await setup({ audit: async event => { if (event === 'pairing_decision') throw new Error('secret stack') } }, credentials)
    const res = await raw(h.url)
    expect(await res.text()).not.toContain('secret stack')
    await vi.waitFor(() => expect(h.server.sessionViews()).toEqual([]))
    expect(h.calls).toEqual([])
    const other = await setup({ approveClient: async () => 'permanent' })
    other.credentials.grant = async () => { throw new Error('disk secret') }
    await raw(other.url)
    await vi.waitFor(() => expect(other.server.sessionViews()).toEqual([]))
  })

  it('rechecks invalidation after approval audit and after persistence', async () => {
    const credentials = new Credentials()
    const h = await setup({ audit: async event => { if (event === 'pairing_decision') await credentials.revoke('A') } }, credentials)
    await raw(h.url)
    await vi.waitFor(() => expect(h.server.sessionViews()).toEqual([]))
    expect(credentials.permission('A')).toEqual({ kind: 'none' })
    const c2 = new Credentials()
    c2.grant = async () => { await c2.revoke('A') }
    const h2 = await setup({ approveClient: async () => '24h' }, c2)
    await raw(h2.url)
    await vi.waitFor(() => expect(h2.server.sessionViews()).toEqual([]))
  })

  it('keeps normal HTTP body/keepalive close alive, but aborts an unfinished response', async () => {
    let context!: HttpCallContext
    let release!: () => void
    const h = await setup({ dispatch: async (_r, ctx) => { context = ctx; await new Promise<void>(r => { release = r }); return { ok: true, result: { profiles: [] } } } })
    const { transport } = await sdk(h.url)
    await approved(h.server)
    const req = request(h.url, { method: 'POST', headers: { Authorization: 'Bearer token-A', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'Mcp-Session-Id': transport.sessionId! } })
    req.on('error', () => {})
    req.end(JSON.stringify(listCall))
    await vi.waitFor(() => expect(context).toBeDefined())
    expect(context.signal.aborted).toBe(false)
    req.destroy()
    await vi.waitFor(() => expect(context.signal.aborted).toBe(true))
    release()
  })

  it('does not interrupt an in-flight call on reconnect and aborts synchronously on close', async () => {
    let ctx!: HttpCallContext
    let release!: () => void
    const h = await setup({ dispatch: async (_r, c) => { ctx = c; await new Promise<void>(r => { release = r }); return { ok: true, result: { profiles: [] } } } })
    const { client } = await sdk(h.url)
    await approved(h.server)
    const call = client.callTool({ name: 'list_authorized_ssh_profiles', arguments: {} }).catch(() => undefined)
    await vi.waitFor(() => expect(ctx).toBeDefined())
    expect((await raw(h.url)).status).toBe(503)
    expect(ctx.signal.aborted).toBe(false)
    const closing = h.server.close()
    expect(ctx.signal.aborted).toBe(true)
    expect(h.server.sessionViews()).toEqual([])
    release()
    await closing
    await call
  })

  it('limits initializer burst and tool burst independently', async () => {
    const h = await setup()
    const { client } = await sdk(h.url)
    await approved(h.server)
    for (let i = 0; i < 5; i++) expect((await client.callTool({ name: 'list_authorized_ssh_profiles', arguments: {} })).isError).toBeFalsy()
    expect((await client.callTool({ name: 'list_authorized_ssh_profiles', arguments: {} })).isError).toBe(true)
    expect(h.calls).toHaveLength(5)
    for (let i = 0; i < 4; i++) expect((await raw(h.url)).status).toBe(200)
    expect((await raw(h.url)).status).toBe(429)
  })

  it('rejects a 33rd socket and bounds incoming HTTP headers', async () => {
    const h = await setup()
    for (let i = 0; i < 32; i++) {
      const s = connect(h.port, '127.0.0.1'); sockets.push(s)
      await new Promise<void>(r => s.once('connect', r))
    }
    const extra = connect(h.port, '127.0.0.1'); sockets.push(extra)
    await new Promise<void>(r => { extra.once('close', r); extra.on('error', () => {}) })
    sockets.splice(0).forEach(s => s.destroy())
    await vi.waitFor(() => expect((h.server as unknown as { sockets: Set<Socket> }).sockets.size).toBe(0))
    const response = await new Promise<number>(resolve => {
      const req = request(h.url, { headers: { 'X-Oversized': 'x'.repeat(17 * 1024) } }, res => { res.resume(); resolve(res.statusCode!) })
      req.end()
    })
    expect(response).toBe(431)
  })
})
