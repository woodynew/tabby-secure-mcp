import { Injectable } from '@angular/core'
import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { createConnection } from 'node:net'
import { lstat, readFile } from 'node:fs/promises'

import {
  encodeFrame,
  IpcFrameDecoder,
  type ErrorCode,
  type IpcMessage,
} from './ipc-contract-api'

import { AuditService } from '../audit/audit-service'
import {
  ApprovalGatekeeper,
  APPROVAL_WINDOW_MS,
  type ApprovalErrorCode,
} from '../approval/approval-gatekeeper'
import { SystemMonotonicClock } from '../approval/monotonic-clock'
import { AuthorizedProfilesService } from '../services/authorized-profiles.service'
import type { BootstrapDataSource } from './bootstrap-data'
import { readRuntimeDescriptor } from './descriptor-reader'
import type { RuntimeDescriptor } from './descriptor'
import { createPairingResponse } from './pairing'
import type {
  PluginRuntimeDependencies,
  PluginSocket,
  RandomBytesProvider,
  RuntimeTimerScheduler,
  SocketConnector,
} from './plugin-runtime-deps'
import { resolvePluginDescriptorPaths } from './runtime-paths'
import { RuntimeLeaseState } from './runtime-lease-state'

const COMPANION_CLIENT_IDENTITY = 'tabby-secure-mcp-companion'
const COMPANION_LABEL = 'Tabby Secure MCP companion'
const DESCRIPTOR_POLL_MS = 1_000

class NodeDescriptorFileSystem {
  async readFile(path: string): Promise<string> {
    return readFile(path, 'utf8')
  }

  async stat(path: string) {
    const stat = await lstat(path)
    return { isSymbolicLink: () => stat.isSymbolicLink(), size: stat.size }
  }
}

class NodeSocketConnector implements SocketConnector {
  connect(endpoint: string, onConnect?: () => void): PluginSocket {
    return createConnection(endpoint, onConnect) as PluginSocket
  }
}

class NodeRuntimeTimers implements RuntimeTimerScheduler {
  schedule(delayMs: number, callback: () => void) {
    const handle = setTimeout(callback, delayMs)
    return {
      cancel: () => clearTimeout(handle),
    }
  }
}

class NodeRandomBytes implements RandomBytesProvider {
  randomBytes(size: number): Uint8Array {
    return nodeRandomBytes(size)
  }

  randomId(): string {
    return nodeRandomBytes(16).toString('hex')
  }
}

interface PendingRpc {
  leaseEpoch: number
  controller: AbortController
  cancelled: boolean
  cancelSent: boolean
}

@Injectable()
export class PluginRuntimeService {
  private readonly platform: NodeJS.Platform
  private readonly descriptorPath: string
  private readonly fs: NodeDescriptorFileSystem
  private readonly connector: SocketConnector
  private readonly timers: RuntimeTimerScheduler
  private readonly random: RandomBytesProvider
  private readonly reconnectDelayMs: number
  private readonly onDiagnostic: (message: string) => void
  private readonly clock = new SystemMonotonicClock()

  private readonly windowInstanceId: string
  private socket?: PluginSocket
  private decoder = new IpcFrameDecoder()
  private outboundSeq = 0
  private destroyed = false
  private started = false
  private isLeaseHolder = false
  private activeDescriptor?: RuntimeDescriptor
  private pluginChallenge?: string
  private companionChallenge?: string
  private pairingAbort?: AbortController
  private reconnectTimer?: { cancel(): void }
  private readonly pendingRpc = new Map<string, PendingRpc>()

  constructor(
    private readonly bootstrap: BootstrapDataSource,
    private readonly leaseState: RuntimeLeaseState,
    private readonly gatekeeper: ApprovalGatekeeper,
    private readonly authorizedProfiles: AuthorizedProfilesService,
    private readonly audit: AuditService,
    dependencies: PluginRuntimeDependencies = {},
  ) {
    this.platform = dependencies.platform ?? process.platform
    const paths =
      dependencies.descriptorPaths ??
      resolvePluginDescriptorPaths({ platform: this.platform })
    this.descriptorPath = paths.descriptorPath
    this.fs = (dependencies.fs as NodeDescriptorFileSystem) ?? new NodeDescriptorFileSystem()
    this.connector = dependencies.connector ?? new NodeSocketConnector()
    this.timers = dependencies.timers ?? new NodeRuntimeTimers()
    this.random = dependencies.random ?? new NodeRandomBytes()
    this.reconnectDelayMs = dependencies.reconnectDelayMs ?? DESCRIPTOR_POLL_MS
    this.onDiagnostic = dependencies.onDiagnostic ?? (() => undefined)
    this.windowInstanceId = this.random.randomId()
  }

  start(): void {
    if (this.started || this.destroyed) {
      return
    }
    this.started = true
    void this.audit.append({ event: 'runtime_start', result: 'ok' })
    this.scheduleReconnect(0)
  }

  destroy(): void {
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    this.cancelReconnectTimer()
    this.teardownConnection('runtime_stop')
    void this.audit.append({ event: 'runtime_stop', result: 'ok' })
  }

  getWindowInstanceId(): string {
    return this.windowInstanceId
  }

  isHolder(): boolean {
    return this.isLeaseHolder
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.destroyed) {
      return
    }
    this.cancelReconnectTimer()
    this.reconnectTimer = this.timers.schedule(delayMs, () => {
      void this.attemptConnect()
    })
  }

  private cancelReconnectTimer(): void {
    this.reconnectTimer?.cancel()
    this.reconnectTimer = undefined
  }

  private async attemptConnect(): Promise<void> {
    if (this.destroyed) {
      return
    }
    this.teardownConnection('reconnect')

    const read = await readRuntimeDescriptor(this.descriptorPath, this.fs, {
      platform: this.platform,
    })
    if (!read.ok) {
      this.onDiagnostic(`descriptor unavailable: ${read.code}`)
      this.scheduleReconnect(this.reconnectDelayMs)
      return
    }

    const descriptor = read.descriptor
    this.activeDescriptor = descriptor
    const socket = this.connector.connect(descriptor.endpoint, () => {
      void this.onSocketConnected(descriptor)
    })
    this.socket = socket
    socket.on('data', (chunk) => {
      try {
        const messages = this.decoder.push(chunk)
        for (const message of messages) {
          void this.handleMessage(message, descriptor)
        }
      } catch (error) {
        this.onDiagnostic(`frame error: ${(error as Error).message}`)
        this.teardownConnection('frame_error')
        if (!this.destroyed) {
          this.scheduleReconnect(this.reconnectDelayMs)
        }
      }
    })
    socket.on('close', () => {
      this.teardownConnection('disconnect')
      if (!this.destroyed) {
        this.scheduleReconnect(this.reconnectDelayMs)
      }
    })
    socket.on('error', (error) => {
      this.onDiagnostic(`socket error: ${error.message}`)
      this.teardownConnection('socket_error')
      if (!this.destroyed) {
        this.scheduleReconnect(this.reconnectDelayMs)
      }
    })
  }

  private async onSocketConnected(descriptor: RuntimeDescriptor): Promise<void> {
    if (this.destroyed) {
      return
    }
    try {
      this.pluginChallenge = Buffer.from(this.random.randomBytes(16)).toString('base64url')
      const bootstrap = this.bootstrap()
      await this.send({
        v: 1,
        seq: 0,
        type: 'plugin_hello',
        window_instance_id: this.windowInstanceId,
        is_main_window: bootstrap.isMainWindow,
        plugin_challenge: this.pluginChallenge,
      })
      void this.audit.append({ event: 'runtime_connect', result: 'ok' })
    } catch (error) {
      this.onDiagnostic(`handshake send failed: ${(error as Error).message}`)
      this.teardownConnection('handshake_failed')
    }
  }

  private async handleMessage(message: IpcMessage, descriptor: RuntimeDescriptor): Promise<void> {
    if (message.type === 'companion_challenge') {
      await this.handleCompanionChallenge(message, descriptor)
      return
    }
    if (message.type === 'lease_granted') {
      this.isLeaseHolder = true
      this.leaseState.grant(message.lease_epoch)
      void this.audit.append({ event: 'lease_granted', result: 'ok' })
      return
    }
    if (message.type === 'lease_revoked') {
      this.handleLeaseLoss()
      void this.audit.append({
        event: 'lease_lost',
        result: 'error',
        errorCode: message.reason,
      })
      return
    }
    if (message.type === 'rpc_request') {
      await this.handleRpcRequest(message)
      return
    }
    if (message.type === 'cancel_request') {
      this.handleCancelRequest(message)
    }
  }

  private async handleCompanionChallenge(
    message: Extract<IpcMessage, { type: 'companion_challenge' }>,
    descriptor: RuntimeDescriptor,
  ): Promise<void> {
    this.companionChallenge = message.companion_challenge
    this.pairingAbort?.abort()
    this.pairingAbort = new AbortController()
    const pairing = await this.gatekeeper.requestPairingApproval({
      clientIdentity: COMPANION_CLIENT_IDENTITY,
      companionLabel: COMPANION_LABEL,
      signal: this.pairingAbort.signal,
    })

    const approved = pairing.ok && pairing.approved
    void this.audit.append({
      event: 'pairing_decision',
      result: approved ? 'ok' : 'error',
      errorCode: approved ? undefined : 'not_approved',
    })

    if (!this.pluginChallenge || !this.companionChallenge) {
      return
    }

    const response = approved
      ? createPairingResponse(descriptor.pairing_nonce, {
          endpoint: descriptor.endpoint,
          pid: descriptor.pid,
          protocolVersion: descriptor.protocol_version,
          companionChallenge: this.companionChallenge,
          pluginChallenge: this.pluginChallenge,
          windowInstanceId: this.windowInstanceId,
        })
      : '0000000000000000000000000000000000000000000000000000000000000000'

    await this.send({
      v: 1,
      seq: 0,
      type: 'pairing_decision',
      window_instance_id: this.windowInstanceId,
      approved,
      response,
    })
  }

  private handleLeaseLoss(): void {
    this.isLeaseHolder = false
    this.leaseState.clear()
    this.abortAllPendingRpc('cancelled')
    this.clearProfileRefs()
  }

  private async handleRpcRequest(
    message: Extract<IpcMessage, { type: 'rpc_request' }>,
  ): Promise<void> {
    const activeEpoch = this.leaseState.getLeaseEpoch()
    if (!this.isLeaseHolder || activeEpoch === null || message.lease_epoch !== activeEpoch) {
      return
    }

    if (message.request.method === 'list_authorized_ssh_profiles') {
      await this.handleListRpc(message)
      return
    }
    if (message.request.method === 'open_authorized_ssh_profile') {
      await this.handleOpenRpc(message)
    }
  }

  private async handleListRpc(
    message: Extract<IpcMessage, { type: 'rpc_request' }>,
  ): Promise<void> {
    try {
      const profiles = await this.authorizedProfiles.listAuthorizedProfiles()
      const dto = profiles.map((entry) => ({
        profile_ref: entry.profile_ref,
        display_name: entry.display_name,
      }))
      void this.audit.append({
        event: 'list_result',
        result: 'ok',
        authorizedCount: dto.length,
      })
      await this.sendRpcResult(message.request_id, message.lease_epoch, {
        ok: true,
        result: { profiles: dto },
      })
    } catch {
      void this.audit.append({ event: 'list_result', result: 'error', errorCode: 'internal' })
      await this.sendRpcResult(message.request_id, message.lease_epoch, {
        ok: false,
        code: 'internal',
      })
    }
  }

  private async handleOpenRpc(
    message: Extract<IpcMessage, { type: 'rpc_request' }>,
  ): Promise<void> {
    const requestId = message.request_id
    const leaseEpoch = message.lease_epoch
    const profileRef = message.request.params.profile_ref

    const controller = new AbortController()
    this.pendingRpc.set(requestId, {
      leaseEpoch,
      controller,
      cancelled: false,
      cancelSent: false,
    })

    void this.audit.append({
      event: 'open_requested',
      result: 'ok',
      requestId,
    })

    const deadlineMonotonicMs = this.clock.now() + APPROVAL_WINDOW_MS
    const result = await this.gatekeeper.requestOpen({
      requestId,
      leaseEpoch,
      profileRef,
      clientIdentity: COMPANION_CLIENT_IDENTITY,
      toolName: 'open_authorized_ssh_profile',
      operation: {
        method: 'open_authorized_ssh_profile',
        params: { profile_ref: profileRef },
      },
      deadlineMonotonicMs,
      signal: controller.signal,
    })

    const pending = this.pendingRpc.get(requestId)
    if (!pending || pending.cancelled) {
      return
    }
    this.pendingRpc.delete(requestId)

    if (result.ok) {
      void this.audit.append({ event: 'open_result', result: 'ok', requestId })
      await this.sendRpcResult(requestId, leaseEpoch, {
        ok: true,
        result: { status: 'opened' },
      })
      return
    }

    void this.audit.append({
      event: 'open_result',
      result: 'error',
      requestId,
      errorCode: result.code,
    })
    await this.sendRpcResult(requestId, leaseEpoch, {
      ok: false,
      code: mapApprovalError(result.code),
    })
  }

  private handleCancelRequest(message: Extract<IpcMessage, { type: 'cancel_request' }>): void {
    const pending = this.pendingRpc.get(message.request_id)
    if (!pending || pending.leaseEpoch !== message.lease_epoch) {
      return
    }
    if (pending.cancelSent) {
      return
    }
    pending.cancelled = true
    pending.cancelSent = true
    pending.controller.abort()
    this.pendingRpc.delete(message.request_id)
    void this.audit.append({
      event: 'cancel',
      result: 'ok',
      requestId: message.request_id,
    })
    void this.sendRpcCancelled(message.request_id, message.lease_epoch, 'cancelled')
  }

  private async sendRpcResult(
    requestId: string,
    leaseEpoch: number,
    outcome:
      | { ok: true; result: Record<string, unknown> }
      | { ok: false; code: ErrorCode },
  ): Promise<void> {
    if (outcome.ok) {
      await this.send({
        v: 1,
        seq: 0,
        type: 'rpc_result',
        request_id: requestId,
        lease_epoch: leaseEpoch,
        ok: true,
        result: outcome.result as never,
      })
      return
    }
    await this.send({
      v: 1,
      seq: 0,
      type: 'rpc_result',
      request_id: requestId,
      lease_epoch: leaseEpoch,
      ok: false,
      error: { code: outcome.code },
    })
  }

  private async sendRpcCancelled(
    requestId: string,
    leaseEpoch: number,
    reason: ErrorCode,
  ): Promise<void> {
    await this.send({
      v: 1,
      seq: 0,
      type: 'rpc_cancelled',
      request_id: requestId,
      lease_epoch: leaseEpoch,
      reason,
    })
  }

  private async send(message: IpcMessage): Promise<void> {
    const socket = this.socket
    if (!socket || socket.destroyed) {
      return
    }
    this.outboundSeq += 1
    const frame = encodeFrame({ ...message, v: 1, seq: this.outboundSeq })
    await new Promise<void>((resolve, reject) => {
      socket.write(frame, (error) => (error ? reject(error) : resolve()))
    })
  }

  private teardownConnection(_reason: string): void {
    this.pairingAbort?.abort()
    this.pairingAbort = undefined
    this.isLeaseHolder = false
    this.leaseState.clear()
    this.abortAllPendingRpc('cancelled')
    this.clearProfileRefs()
    this.decoder.close()
    this.decoder = new IpcFrameDecoder()
    this.outboundSeq = 0
    this.pluginChallenge = undefined
    this.companionChallenge = undefined
    if (this.socket) {
      this.socket.removeAllListeners()
      this.socket.destroy()
      this.socket = undefined
    }
  }

  private abortAllPendingRpc(_reason: ApprovalErrorCode): void {
    for (const [requestId, pending] of this.pendingRpc.entries()) {
      pending.cancelled = true
      pending.controller.abort()
      this.pendingRpc.delete(requestId)
    }
  }

  private clearProfileRefs(): void {
    this.authorizedProfiles.clearRefCache()
  }
}

function mapApprovalError(code: ApprovalErrorCode): ErrorCode {
  switch (code) {
    case 'busy':
      return 'busy'
    case 'cancelled':
      return 'cancelled'
    case 'not_approved':
      return 'not_approved'
    case 'target_unavailable':
      return 'target_unavailable'
    default:
      return 'internal'
  }
}
