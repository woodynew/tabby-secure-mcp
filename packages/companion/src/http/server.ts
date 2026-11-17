import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { WebStandardStreamableHTTPServerTransport, type McpServer } from '@modelcontextprotocol/server'
import type { OperationalRequest } from '@tabby-secure-mcp/ipc-contract'
import { TokenBucket } from '../gateway/token-bucket.js'
import { createMcpServer } from '../mcp/server.js'
import { toMcpToolError } from '../mcp/safe-errors.js'
import { HttpInputError, jsonResponse, readJson, writeResponse } from './adapter.js'
import type { ApprovalDuration, ClientIdentity, ClientPermission, EmbeddedMcpOptions, HttpCallResult, HttpSessionView } from './contracts.js'
import { APPROVAL_WINDOW_MS } from './contracts.js'

interface Session {
  id: string
  client: ClientIdentity
  state: 'initializing' | 'pending' | 'approved' | 'closed'
  abort: AbortController
  mcp: McpServer
  transport: WebStandardStreamableHTTPServerTransport
  requests: number
  calls: number
  requestIds: Set<string | number>
  duration?: ApprovalDuration
  expiresAt?: number
  expiresMonotonic?: number
  timer?: ReturnType<typeof setTimeout>
}

function abortRace<T>(promise: Promise<T>, signal: AbortSignal, fallback: T): Promise<T> {
  return new Promise(resolve => {
    const abort = () => { signal.removeEventListener('abort', abort); resolve(fallback) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, () => { signal.removeEventListener('abort', abort); resolve(fallback) })
  })
}

export class EmbeddedMcpServer {
  private readonly sockets = new Set<Socket>()
  private readonly headerTimers = new Map<Socket, ReturnType<typeof setTimeout>>()
  private readonly sessions = new Map<string, Session>()
  private readonly requestContext = new AsyncLocalStorage<{ signal: AbortSignal; id: unknown }>()
  private readonly finiteDeadlines = new Map<string, { generation: number; approvedAt: number; expiresAt: number; deadline: number }>()
  private readonly lifetime = new AbortController()
  private readonly initializeBucket = new TokenBucket({ capacity: 5, perMinute: 10, now: () => performance.now() })
  private readonly callBucket = new TokenBucket({ capacity: 5, perMinute: 20, now: () => performance.now() })
  private pending?: Session
  private calls = 0
  private active = false
  private started = false
  private port = 0
  private unsubscribe?: () => void
  private closePromise?: Promise<void>
  private readonly httpServer = createServer({ maxHeaderSize: 16_384, headersTimeout: 5_000, requestTimeout: 0, connectionsCheckingInterval: 250 }, (req, res) => {
    clearTimeout(this.headerTimers.get(req.socket))
    this.headerTimers.delete(req.socket)
    void this.handle(req, res).catch(() => jsonResponse(res, 500, 'Request failed'))
  })

  constructor(private readonly options: EmbeddedMcpOptions) {
    this.httpServer.on('connection', socket => {
      if (this.sockets.size >= 32 || this.lifetime.signal.aborted) { socket.destroy(); return }
      this.sockets.add(socket)
      // Enforce the first header deadline even when no request bytes arrive.
      const headerTimer = setTimeout(() => socket.destroy(), 5_000)
      headerTimer.unref?.()
      this.headerTimers.set(socket, headerTimer)
      socket.once('close', () => { clearTimeout(this.headerTimers.get(socket)); this.headerTimers.delete(socket); this.sockets.delete(socket) })
    })
  }

  async start(): Promise<void> {
    if (this.started || this.lifetime.signal.aborted) throw new Error('MCP service cannot be started')
    this.started = true
    try {
      await this.options.credentials.load()
      if (this.lifetime.signal.aborted) throw new Error('MCP service closed')
      await new Promise<void>((resolve, reject) => {
        const fail = () => { this.httpServer.off('listening', ready); reject(new Error('MCP listener unavailable')) }
        const ready = () => { this.httpServer.off('error', fail); resolve() }
        this.httpServer.once('error', fail); this.httpServer.once('listening', ready)
        this.httpServer.listen(this.options.port, '127.0.0.1')
      })
      this.port = (this.httpServer.address() as { port: number }).port
      await this.options.audit('runtime_start', 'ok')
      if (this.lifetime.signal.aborted) throw new Error('MCP service closed')
      this.unsubscribe = this.options.credentials.onInvalidated(id => {
        this.finiteDeadlines.delete(id)
        for (const session of this.sessions.values()) if (session.client.id === id) this.retire(session)
      })
      this.active = true
    } catch (error) { await this.close(); throw error }
  }

  close(): Promise<void> {
    if (this.lifetime.signal.aborted) return this.closePromise ?? Promise.resolve()
    this.active = false
    this.lifetime.abort()
    this.unsubscribe?.()
    for (const session of this.sessions.values()) this.retire(session)
    this.finiteDeadlines.clear()
    for (const socket of this.sockets) socket.destroy()
    this.closePromise = (async () => {
      await new Promise<void>(resolve => this.httpServer.close(() => resolve()))
      await this.options.audit('runtime_stop', 'ok')
    })()
    return this.closePromise
  }

  sessionViews(): HttpSessionView[] {
    const names = new Map(this.options.credentials.list().map(client => [client.id, client.name]))
    return [...this.sessions.values()].filter(s => s.state === 'pending' || s.state === 'approved').map(s => ({
      clientId: s.client.id, clientName: names.get(s.client.id) ?? s.client.name, state: s.state as 'pending' | 'approved',
      ...(s.duration ? { duration: s.duration } : {}), ...(s.expiresAt !== undefined ? { expiresAt: s.expiresAt } : {}),
    }))
  }

  private changed(): void {
    // A disposed settings view must never interrupt revocation or shutdown.
    try { this.options.onChange?.() } catch {}
  }

  private current(session: Session): boolean {
    return this.active && !session.abort.signal.aborted && this.options.credentials.isCurrent(session.client)
  }

  private retire(session: Session, closeTransport = true): void {
    if (session.state === 'closed') return
    session.state = 'closed'
    this.sessions.delete(session.id)
    if (this.pending === session) this.pending = undefined
    clearTimeout(session.timer)
    session.abort.abort()
    if (closeTransport) void session.mcp.close().catch(() => {})
    this.changed()
  }

  private newSession(client: ClientIdentity): Session {
    const id = randomBytes(24).toString('hex')
    const session = { id, client: { id: client.id, name: client.name, generation: client.generation }, state: 'initializing', abort: new AbortController(), requests: 0, calls: 0, requestIds: new Set() } as Session
    session.transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => id, enableJsonResponse: true })
    session.mcp = createMcpServer({ call: (request, options) => this.call(session, request, options?.signal) })
    session.mcp.server.onclose = () => this.retire(session, false)
    this.sessions.set(id, session)
    this.pending = session
    return session
  }

  private finiteDeadline(client: ClientIdentity, permission: Extract<ClientPermission, { kind: 'until' }>): number {
    const previous = this.finiteDeadlines.get(client.id)
    if (previous?.generation === client.generation && previous.approvedAt === permission.approvedAt && previous.expiresAt === permission.expiresAt) return previous.deadline
    const deadline = performance.now() + Math.min(86_400_000, permission.expiresAt - Date.now())
    this.finiteDeadlines.set(client.id, { generation: client.generation, approvedAt: permission.approvedAt, expiresAt: permission.expiresAt, deadline })
    return deadline
  }

  private async approve(session: Session, declaredName: unknown): Promise<void> {
    session.state = 'pending'
    session.timer = setTimeout(() => this.retire(session), APPROVAL_WINDOW_MS)
    session.timer.unref?.()
    this.changed()
    try {
      const permission = this.options.credentials.permission(session.client.id)
      const now = Date.now()
      const sessionOnly = permission.kind === 'session' && this.options.credentials.consumeSessionPermission(session.client.id, session.client.generation)
      const remembered = sessionOnly || permission.kind === 'permanent' || (permission.kind === 'until' && permission.approvedAt <= now && now < permission.expiresAt && performance.now() < this.finiteDeadline(session.client, permission))
      const name = typeof declaredName === 'string' ? [...declaredName.replace(/[\p{Cc}\p{Cf}]/gu, '')].slice(0, 80).join('') : ''
      const duration = remembered ? (sessionOnly ? 'session' : permission.kind === 'permanent' ? 'permanent' : '24h') : await abortRace(this.options.approveClient(session.client, session.abort.signal, name), session.abort.signal, null)
      const approvalMonotonic = performance.now()
      const approvalWall = Date.now()
      if (!this.current(session)) return
      await this.options.audit('pairing_decision', duration ? 'ok' : 'error')
      if (!this.current(session)) return
      if (!duration || !['session', '24h', 'permanent'].includes(duration)) { this.retire(session); return }
      if (!remembered && duration !== 'session') {
        await this.options.credentials.grant(session.client.id, session.client.generation, duration)
        if (!this.current(session)) return
      }
      clearTimeout(session.timer)
      session.timer = undefined
      session.duration = duration
      if (duration !== 'permanent') {
        const saved = this.options.credentials.permission(session.client.id)
        const expiresAt = duration === 'session' ? approvalWall + 86_400_000 : saved.kind === 'until' ? saved.expiresAt : 0
        const deadline = duration === 'session' ? approvalMonotonic + 86_400_000 : saved.kind === 'until' ? this.finiteDeadline(session.client, saved) : 0
        const remaining = deadline - performance.now()
        if (remaining <= 0) { this.retire(session); return }
        session.expiresAt = expiresAt
        session.expiresMonotonic = deadline
        session.timer = setTimeout(() => this.retire(session), remaining)
        session.timer.unref?.()
      }
      session.state = 'approved'
      if (this.pending === session) this.pending = undefined
      this.changed()
    } catch { this.retire(session) }
  }

  private async call(session: Session, request: OperationalRequest, mcpSignal?: AbortSignal): Promise<HttpCallResult> {
    if (!this.current(session) || session.state !== 'approved') return { ok: false, code: 'not_approved' }
    if (session.expiresMonotonic !== undefined && performance.now() >= session.expiresMonotonic) { this.retire(session); return { ok: false, code: 'expired' } }
    const httpContext = this.requestContext.getStore()
    const signals = [session.abort.signal, this.lifetime.signal, httpContext?.signal, mcpSignal].filter((s): s is AbortSignal => !!s)
    const deadline = new AbortController()
    const signal = AbortSignal.any([...signals, deadline.signal])
    if (signal.aborted) return { ok: false, code: 'cancelled' }
    if (this.calls >= 4) return { ok: false, code: 'busy' }
    if (!this.callBucket.tryTake()) return { ok: false, code: 'rate_limited' }
    const deadlineMs = request.method === 'upload_ssh_file' || request.method === 'download_ssh_file' ? 180_000
      : request.method === 'run_authorized_ssh_command' ? APPROVAL_WINDOW_MS + 45_000
      : request.method === 'open_authorized_ssh_profile' ? APPROVAL_WINDOW_MS : 30_000
    const deadlineMonotonicMs = performance.now() + deadlineMs
    const timer = setTimeout(() => deadline.abort(), deadlineMs)
    timer.unref?.()
    this.calls++; session.calls++
    // SDK drops replies to cancelled handlers; explicitly finish its JSON stream and maps.
    const onMcpCancel = () => {
      if (typeof httpContext?.id === 'string' || typeof httpContext?.id === 'number') {
        void session.transport.send({ jsonrpc: '2.0', id: httpContext.id, result: toMcpToolError('outcome_unknown') }).catch(() => {})
      }
    }
    mcpSignal?.addEventListener('abort', onMcpCancel, { once: true })
    let dispatched: Promise<HttpCallResult>
    try {
      const name = this.options.credentials.list().find(client => client.id === session.client.id)?.name ?? session.client.name
      dispatched = Promise.resolve(this.options.dispatch(request, { requestId: randomBytes(16).toString('hex'), signal, client: { ...session.client, name }, deadlineMonotonicMs }))
    } catch { dispatched = Promise.resolve({ ok: false, code: 'outcome_unknown' }) }
    const settled = dispatched.catch((): HttpCallResult => ({ ok: false, code: 'outcome_unknown' })).then(result => {
      this.calls--; session.calls--
      return result
    })
    try {
      const result = await abortRace<HttpCallResult>(settled, signal, { ok: false, code: 'outcome_unknown' })
      return signal.aborted || !this.current(session) ? { ok: false, code: 'outcome_unknown' } : result
    } finally { clearTimeout(timer); mcpSignal?.removeEventListener('abort', onMcpCancel) }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const deny = (status: number, message: string) => jsonResponse(res, status, message)
    if (!this.active) { deny(503, 'Service unavailable'); return }
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== `127.0.0.1:${this.port}` || req.headers.origin !== undefined) { deny(403, 'Forbidden'); return }
    for (const name of ['host', 'authorization', 'mcp-session-id']) {
      if (req.rawHeaders.filter((h, i) => i % 2 === 0 && h.toLowerCase() === name).length > 1) { deny(400, 'Invalid headers'); return }
    }
    const auth = req.headers.authorization
    const client = typeof auth === 'string' && /^Bearer [A-Za-z0-9_-]+$/.test(auth) ? this.options.credentials.authenticate(auth.slice(7)) : undefined
    if (!client || !this.options.credentials.isCurrent(client)) { deny(401, 'Unauthorized'); return }
    if (req.url !== '/mcp') { deny(404, 'Not found'); return }
    if (req.method !== 'POST' && req.method !== 'DELETE') { res.setHeader('Allow', 'POST, DELETE'); deny(405, 'Method not allowed'); return }
    const disconnected = new AbortController()
    const signal = AbortSignal.any([disconnected.signal, this.lifetime.signal])
    const onClose = () => { if (!res.writableFinished) disconnected.abort() }
    res.once('close', onClose)
    req.once('aborted', () => disconnected.abort())
    let session: Session | undefined
    let fresh = false
    let counted = false
    let rpcId: string | number | undefined
    try {
      const sessionId = req.headers['mcp-session-id']
      if (sessionId !== undefined) {
        session = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined
        if (!session || session.client.id !== client.id || session.client.generation !== client.generation || !this.current(session)) { deny(404, 'Session not found'); return }
        session.requests++
        counted = true
      }
      let body: Record<string, unknown> | undefined
      if (req.method === 'POST') {
        if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') { deny(415, 'JSON required'); return }
        body = await readJson(req, signal)
      }
      if (!this.active || signal.aborted || !this.options.credentials.isCurrent(client)) { deny(403, 'Forbidden'); return }
      if (!session) {
        if (req.method !== 'POST' || body?.method !== 'initialize') { deny(400, 'Initialization required'); return }
        if (this.pending) { deny(503, 'Approval busy'); return }
        const old = [...this.sessions.values()].find(s => s.client.id === client.id)
        if (old && (old.requests || old.calls)) { deny(503, 'Client busy'); return }
        if (this.sessions.size >= 8 && !old) { deny(503, 'Session limit reached'); return }
        if (!this.initializeBucket.tryTake()) { deny(429, 'Rate limited'); return }
        if (old) this.retire(old)
        session = this.newSession(client)
        session.requests++
        counted = true
        fresh = true
        await session.mcp.connect(session.transport)
      }
      if (typeof body?.id === 'string' || typeof body?.id === 'number') {
        if (session.requestIds.has(body.id)) { deny(409, 'Request already in progress'); return }
        rpcId = body.id
        session.requestIds.add(rpcId)
      }
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value)
      const webRequest = new Request(`http://127.0.0.1:${this.port}/mcp`, { method: req.method, headers, signal })
      const activeSession = session
      const response = await this.requestContext.run({ signal: disconnected.signal, id: body?.id }, () => abortRace(
        activeSession.transport.handleRequest(webRequest, { parsedBody: body }),
        AbortSignal.any([signal, activeSession.abort.signal]),
        new Response(JSON.stringify({ jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32603, message: body?.method === 'tools/call' ? 'The operation may have executed; do not retry automatically.' : 'Session closed' } }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      ))
      if (fresh) {
        if (response.status !== 200 || signal.aborted || !this.current(session)) this.retire(session)
        else void this.approve(session, (body?.params as { clientInfo?: { name?: unknown } } | undefined)?.clientInfo?.name)
      }
      await writeResponse(res, response)
    } catch (error) {
      if (fresh && session) this.retire(session)
      deny(error instanceof HttpInputError ? error.status : 500, 'Invalid request')
    } finally {
      if (session && counted) session.requests--
      if (session && rpcId !== undefined) session.requestIds.delete(rpcId)
      if (res.writableFinished || res.destroyed) res.off('close', onClose)
      else res.once('finish', () => res.off('close', onClose))
    }
  }
}
