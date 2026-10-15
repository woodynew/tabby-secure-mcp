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

export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000
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
  handshakeTimeoutMs?: number
  onDiagnostic?: (message: string) => void
}

type HandshakePhase = 'awaiting_hello' | 'awaiting_decision' | 'complete'

interface PeerState {
  socket: Socket
  decoder: IpcFrameDecoder
  outboundSeq: number
  phase: HandshakePhase
  windowInstanceId?: string
  isMainWindow: boolean
  pluginChallenge?: string
  companionChallenge?: string
  handshakeTimer?: NodeJS.Timeout
  authenticated: boolean
  isLeaseHolder: boolean
}

interface PendingCall {
  requestId: string
  method: OperationalRequest['method']
  leaseEpoch: number
  cancelled: boolean
  deadlineTimer: NodeJS.Timeout
  releaseConcurrency: () => void
  complete: (result: GatewayCallResult) => void
  onAbort?: () => void
  signal?: AbortSignal
}

export class PluginGateway {
  readonly #server: Server
  readonly #peers = new Map<Socket, PeerState>()
  readonly #windowToSocket = new Map<string, Socket>()
  readonly #leases = new LeaseManager()
  readonly #pending = new Map<string, PendingCall>()
  readonly #limiter = new ConcurrencyLimiter(4)
  readonly #bucket = new TokenBucket({ capacity: 5, perMinute: 20 })
  readonly #handshakeTimeoutMs: number
  #closed = false
  #tearingDown = false

  constructor(private readonly options: PluginGatewayOptions) {
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
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
    this.#dropAllPeers()
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve())
    })
    for (const pending of this.#pending.values()) {
      pending.complete({ ok: false, code: 'cancelled' })
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
    if (!peer?.isLeaseHolder || peer.windowInstanceId !== holder.windowInstanceId) {
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

      const complete = (result: GatewayCallResult) => {
        const pending = this.#pending.get(requestId)
        if (pending) {
          this.#finishPending(pending, result)
        }
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
        complete({ ok: false, code })
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
        complete,
        onAbort,
        signal: callOptions.signal,
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
      phase: 'awaiting_hello',
      isMainWindow: false,
      authenticated: false,
      isLeaseHolder: false,
    }
    this.#peers.set(socket, peer)
    peer.handshakeTimer = setTimeout(() => {
      this.#rejectPeer(socket, 'handshake timeout')
    }, this.#handshakeTimeoutMs)

    socket.on('data', (chunk) => {
      try {
        const messages = peer.decoder.push(chunk)
        for (const message of messages) {
          void this.#handleMessage(peer, message).catch((error) => {
            this.#diagnostic(`peer handler error: ${(error as Error).message}`)
            this.#rejectPeer(socket, 'handler error')
          })
        }
      } catch (error) {
        this.#diagnostic(`peer frame error: ${(error as Error).message}`)
        this.#rejectPeer(socket, 'frame error')
      }
    })
    socket.on('close', () => this.#dropPeer(socket))
    socket.on('error', () => this.#dropPeer(socket))
  }

  async #handleMessage(peer: PeerState, message: IpcMessage): Promise<void> {
    if (message.type === 'plugin_hello') {
      if (peer.phase !== 'awaiting_hello') {
        this.#rejectPeer(peer.socket, 'unexpected plugin_hello')
        return
      }
      if (this.#windowToSocket.has(message.window_instance_id)) {
        this.#rejectPeer(peer.socket, 'duplicate window_instance_id')
        return
      }
      peer.phase = 'awaiting_decision'
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
      if (peer.phase !== 'awaiting_decision') {
        this.#rejectPeer(peer.socket, 'unexpected pairing_decision')
        return
      }
      if (
        !peer.windowInstanceId ||
        !peer.companionChallenge ||
        !peer.pluginChallenge ||
        message.window_instance_id !== peer.windowInstanceId
      ) {
        this.#rejectPeer(peer.socket, 'pairing_decision mismatch')
        return
      }
      peer.phase = 'complete'
      if (peer.handshakeTimer) {
        clearTimeout(peer.handshakeTimer)
        peer.handshakeTimer = undefined
      }

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
      if (!approved) {
        this.#rejectPeer(peer.socket, 'pairing denied or invalid')
        return
      }

      peer.authenticated = true
      const preferred = this.#leases.getPreferredPairingCandidate()
      if (
        preferred?.windowInstanceId === peer.windowInstanceId &&
        !this.#leases.holder
      ) {
        const grant = this.#leases.pairAndGrant(peer.windowInstanceId)
        peer.isLeaseHolder = true
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
        this.#settlePending(message.request_id, { ok: false, code: 'internal' })
        return
      }
      if (!message.ok) {
        this.#settlePending(message.request_id, { ok: false, code: message.error.code })
        return
      }
      this.#settlePending(message.request_id, this.#mapSuccess(pending.method, message.result))
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
      this.#settlePending(message.request_id, { ok: false, code: message.reason })
    }
  }

  #settlePending(requestId: string, result: GatewayCallResult): void {
    const pending = this.#pending.get(requestId)
    if (!pending) {
      return
    }
    pending.complete(result)
  }

  #finishPending(pending: PendingCall, result: GatewayCallResult): void {
    if (!this.#pending.has(pending.requestId)) {
      return
    }
    this.#pending.delete(pending.requestId)
    clearTimeout(pending.deadlineTimer)
    if (pending.onAbort) {
      pending.signal?.removeEventListener('abort', pending.onAbort)
    }
    this.#leases.untrackPending(pending.requestId)
    pending.releaseConcurrency()
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
    if (this.#tearingDown) {
      return
    }
    const peer = this.#peers.get(socket)
    if (!peer) {
      return
    }
    const wasHolder = this.#leases.holder?.windowInstanceId === peer.windowInstanceId
    this.#removePeerRecord(socket, peer)
    if (peer.windowInstanceId) {
      try {
        this.#leases.disconnectWindow(peer.windowInstanceId)
      } catch {
        // Ignore unknown windows.
      }
    }
    socket.destroy()
    if (wasHolder) {
      this.#revokeAllPeersAfterHolderLoss()
    }
  }

  #revokeAllPeersAfterHolderLoss(): void {
    this.#leases.markAllWindowsDisconnected()
    this.#dropAllPeers()
  }

  #dropAllPeers(): void {
    this.#tearingDown = true
    for (const peer of this.#peers.values()) {
      if (peer.handshakeTimer) {
        clearTimeout(peer.handshakeTimer)
      }
      peer.socket.destroy()
    }
    this.#peers.clear()
    this.#windowToSocket.clear()
    this.#tearingDown = false
  }

  #rejectPeer(socket: Socket, reason: string): void {
    const peer = this.#peers.get(socket)
    if (peer) {
      this.#removePeerRecord(socket, peer)
    }
    this.#diagnostic(`rejecting peer: ${reason}`)
    socket.destroy()
  }

  #destroyPeer(socket: Socket, reason: string): void {
    this.#diagnostic(`destroying peer: ${reason}`)
    socket.destroy()
  }

  #removePeerRecord(socket: Socket, peer: PeerState): void {
    if (peer.handshakeTimer) {
      clearTimeout(peer.handshakeTimer)
    }
    this.#peers.delete(socket)
    if (peer.windowInstanceId) {
      const mapped = this.#windowToSocket.get(peer.windowInstanceId)
      if (mapped === socket) {
        this.#windowToSocket.delete(peer.windowInstanceId)
      }
    }
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
