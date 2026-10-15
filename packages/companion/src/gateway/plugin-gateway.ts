import { randomBytes } from 'node:crypto'
import { chmod, unlink } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'

import {
  encodeFrame,
  IpcFrameDecoder,
  listProfilesRpcResultSchema,
  openProfileRpcResultSchema,
  type ErrorCode,
  type IpcMessage,
  type OperationalRequest,
} from '@tabby-secure-mcp/ipc-contract'

import { LeaseManager } from '../runtime/lease.js'
import { verifyPairingResponse, type PairingTranscript } from '../runtime/pairing.js'
import { ConcurrencyLimiter } from './concurrency.js'
import { TokenBucket } from './token-bucket.js'

const HANDSHAKE_TIMEOUT_MS = 5_000
export const DEFAULT_RPC_DEADLINE_MS = 30_000

export type GatewayCallResult =
  | {
      ok: true
      method: OperationalRequest['method']
      result: Record<string, unknown>
    }
  | { ok: false; code: ErrorCode }

export interface PluginGatewayOptions {
  endpoint: string
  platform?: NodeJS.Platform
  pid: number
  pairingNonce: string
  protocolVersion?: number
  onDiagnostic?: (message: string) => void
}

interface PeerState {
  socket: Socket
  decoder: IpcFrameDecoder
  outboundSeq: number
  windowInstanceId?: string
  isMainWindow: boolean
  pluginChallenge?: string
  companionChallenge?: string
  handshakeTimer?: NodeJS.Timeout
  handshaken: boolean
}

interface PendingCall {
  requestId: string
  method: OperationalRequest['method']
  leaseEpoch: number
  cancelled: boolean
  deadlineTimer: NodeJS.Timeout
  releaseConcurrency: () => void
  resolve: (result: GatewayCallResult) => void
  onAbort?: () => void
}

export class PluginGateway {
  readonly #server: Server
  readonly #peers = new Map<Socket, PeerState>()
  readonly #windowToSocket = new Map<string, Socket>()
  readonly #leases = new LeaseManager()
  readonly #pending = new Map<string, PendingCall>()
  readonly #limiter = new ConcurrencyLimiter(4)
  readonly #bucket = new TokenBucket({ capacity: 5, perMinute: 20 })
  #closed = false

  constructor(private readonly options: PluginGatewayOptions) {
    this.#server = createServer((socket) => {
      this.#accept(socket)
    })
  }

  async listen(): Promise<void> {
    const platform = this.options.platform ?? process.platform
    if (platform !== 'win32') {
      await unlink(this.options.endpoint).catch(() => undefined)
    }
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(this.options.endpoint, () => resolve())
    })
    if (platform !== 'win32') {
      await chmod(this.options.endpoint, 0o600)
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return
    }
    this.#closed = true
    for (const peer of this.#peers.values()) {
      if (peer.handshakeTimer) {
        clearTimeout(peer.handshakeTimer)
      }
      peer.socket.destroy()
    }
    this.#peers.clear()
    this.#windowToSocket.clear()
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve())
    })
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.deadlineTimer)
      pending.releaseConcurrency()
      pending.resolve({ ok: false, code: 'cancelled' })
    }
    this.#pending.clear()
  }

  async call(
    operation: OperationalRequest,
    callOptions: { signal?: AbortSignal; deadlineMs?: number } = {},
  ): Promise<GatewayCallResult> {
    if (this.#closed) {
      return { ok: false, code: 'plugin_unavailable' }
    }
    const holder = this.#leases.holder
    if (!holder) {
      return { ok: false, code: 'plugin_unavailable' }
    }
    const releaseConcurrency = this.#limiter.tryAcquire()
    if (!releaseConcurrency) {
      return { ok: false, code: 'busy' }
    }
    if (!this.#bucket.tryTake()) {
      releaseConcurrency()
      return { ok: false, code: 'rate_limited' }
    }

    const socket = this.#windowToSocket.get(holder.windowInstanceId)
    const peer = socket ? this.#peers.get(socket) : undefined
    if (!peer?.handshaken || peer.windowInstanceId !== holder.windowInstanceId) {
      releaseConcurrency()
      return { ok: false, code: 'plugin_unavailable' }
    }

    if (callOptions.signal?.aborted) {
      releaseConcurrency()
      return { ok: false, code: 'cancelled' }
    }

    const requestId = randomBytes(16).toString('hex')
    const deadlineMs = callOptions.deadlineMs ?? DEFAULT_RPC_DEADLINE_MS

    return await new Promise<GatewayCallResult>((resolve) => {
      let dispatched = false

      const settle = (result: GatewayCallResult) => {
        const pending = this.#pending.get(requestId)
        if (!pending) {
          return
        }
        this.#pending.delete(requestId)
        clearTimeout(pending.deadlineTimer)
        if (pending.onAbort) {
          callOptions.signal?.removeEventListener('abort', pending.onAbort)
        }
        pending.releaseConcurrency()
        resolve(result)
      }

      const sendCancel = () => {
        if (!dispatched) {
          return
        }
        void this.#send(peer, {
          v: 1,
          seq: 0,
          type: 'cancel_request',
          request_id: requestId,
          lease_epoch: holder.leaseEpoch,
        }).catch(() => undefined)
      }

      const cancel = (code: ErrorCode) => {
        const pending = this.#pending.get(requestId)
        if (!pending || pending.cancelled) {
          sendCancel()
          return
        }
        pending.cancelled = true
        sendCancel()
        settle({ ok: false, code })
      }

      const onAbort = () => cancel('cancelled')
      callOptions.signal?.addEventListener('abort', onAbort)

      const deadlineTimer = setTimeout(() => cancel('expired'), deadlineMs)

      const pending: PendingCall = {
        requestId,
        method: operation.method,
        leaseEpoch: holder.leaseEpoch,
        cancelled: false,
        deadlineTimer,
        releaseConcurrency,
        resolve: settle,
        onAbort,
      }
      this.#pending.set(requestId, pending)

      try {
        this.#leases.trackPending({
          requestId,
          windowInstanceId: holder.windowInstanceId,
          leaseEpoch: holder.leaseEpoch,
          onCancel: (reason) => cancel(reason),
        })
      } catch {
        cancel('plugin_unavailable')
        return
      }

      dispatched = true
      void this.#send(peer, {
        v: 1,
        seq: 0,
        type: 'rpc_request',
        request_id: requestId,
        lease_epoch: holder.leaseEpoch,
        request: operation,
      }).catch(() => cancel('plugin_unavailable'))
    })
  }

  #accept(socket: Socket): void {
    const peer: PeerState = {
      socket,
      decoder: new IpcFrameDecoder(),
      outboundSeq: 0,
      isMainWindow: false,
      handshaken: false,
    }
    this.#peers.set(socket, peer)
    peer.handshakeTimer = setTimeout(() => {
      socket.destroy()
    }, HANDSHAKE_TIMEOUT_MS)

    socket.on('data', (chunk) => {
      try {
        const messages = peer.decoder.push(chunk)
        for (const message of messages) {
          void this.#handleMessage(peer, message)
        }
      } catch (error) {
        this.#diagnostic(`peer frame error: ${(error as Error).message}`)
        socket.destroy()
      }
    })
    socket.on('close', () => this.#dropPeer(socket))
    socket.on('error', () => this.#dropPeer(socket))
  }

  async #handleMessage(peer: PeerState, message: IpcMessage): Promise<void> {
    if (message.type === 'plugin_hello') {
      peer.windowInstanceId = message.window_instance_id
      peer.isMainWindow = message.is_main_window
      peer.pluginChallenge = message.plugin_challenge
      this.#leases.registerWindow({
        windowInstanceId: message.window_instance_id,
        isMainWindow: message.is_main_window,
      })
      this.#windowToSocket.set(message.window_instance_id, peer.socket)
      peer.companionChallenge = randomBytes(16).toString('base64url')
      await this.#send(peer, {
        v: 1,
        seq: 0,
        type: 'companion_challenge',
        companion_challenge: peer.companionChallenge,
      })
      return
    }

    if (message.type === 'pairing_decision') {
      if (!peer.windowInstanceId || !peer.companionChallenge || !peer.pluginChallenge) {
        peer.socket.destroy()
        return
      }
      if (peer.handshakeTimer) {
        clearTimeout(peer.handshakeTimer)
        peer.handshakeTimer = undefined
      }
      peer.handshaken = true
      const transcript: PairingTranscript = {
        endpoint: this.options.endpoint,
        pid: this.options.pid,
        protocolVersion: this.options.protocolVersion ?? 1,
        companionChallenge: peer.companionChallenge,
        pluginChallenge: peer.pluginChallenge,
        windowInstanceId: peer.windowInstanceId,
      }
      const approved =
        message.approved &&
        verifyPairingResponse(this.options.pairingNonce, transcript, message.response)
      if (approved && !this.#leases.holder) {
        const grant = this.#leases.pairAndGrant(peer.windowInstanceId)
        await this.#send(peer, {
          v: 1,
          seq: 0,
          type: 'lease_granted',
          lease_epoch: grant.leaseEpoch,
        })
      }
      return
    }

    if (message.type === 'rpc_result') {
      const pending = this.#pending.get(message.request_id)
      if (!pending || pending.cancelled) {
        return
      }
      if (message.lease_epoch !== pending.leaseEpoch) {
        pending.cancelled = true
        pending.resolve({ ok: false, code: 'internal' })
        return
      }
      if (!message.ok) {
        pending.resolve({ ok: false, code: message.error.code })
        return
      }
      pending.resolve(this.#mapSuccess(pending.method, message.result))
      return
    }

    if (message.type === 'rpc_cancelled') {
      const pending = this.#pending.get(message.request_id)
      if (!pending || pending.cancelled) {
        return
      }
      if (message.lease_epoch !== pending.leaseEpoch) {
        return
      }
      pending.resolve({ ok: false, code: message.reason })
    }
  }

  #mapSuccess(method: OperationalRequest['method'], result: unknown): GatewayCallResult {
    if (method === 'list_authorized_ssh_profiles') {
      const parsed = listProfilesRpcResultSchema.safeParse(result)
      if (!parsed.success) {
        return { ok: false, code: 'internal' }
      }
      return { ok: true, method, result: parsed.data }
    }
    const parsed = openProfileRpcResultSchema.safeParse(result)
    if (!parsed.success) {
      return { ok: false, code: 'internal' }
    }
    return { ok: true, method, result: parsed.data }
  }

  #dropPeer(socket: Socket): void {
    const peer = this.#peers.get(socket)
    if (!peer) {
      return
    }
    if (peer.handshakeTimer) {
      clearTimeout(peer.handshakeTimer)
    }
    this.#peers.delete(socket)
    if (peer.windowInstanceId) {
      this.#windowToSocket.delete(peer.windowInstanceId)
      try {
        this.#leases.disconnectWindow(peer.windowInstanceId)
      } catch {
        // Ignore unknown windows.
      }
    }
    socket.destroy()
  }

  async #send(peer: PeerState, message: IpcMessage): Promise<void> {
    peer.outboundSeq += 1
    const frame = encodeFrame({ ...message, v: 1, seq: peer.outboundSeq })
    await new Promise<void>((resolve, reject) => {
      peer.socket.write(frame, (error) => (error ? reject(error) : resolve()))
    })
  }

  #diagnostic(message: string): void {
    this.options.onDiagnostic?.(message)
  }
}

export function createPluginGateway(options: PluginGatewayOptions): PluginGateway {
  return new PluginGateway(options)
}
