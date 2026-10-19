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

import { SSH_COMMAND_AUTHORIZATION_SUBJECT } from '../authorization/operation-tier-policy'
import { AuditService } from '../audit/audit-service'
import {
  ApprovalGatekeeper,
  APPROVAL_WINDOW_MS,
  type ApprovalErrorCode,
} from '../approval/approval-gatekeeper'
import { SystemMonotonicClock } from '../approval/monotonic-clock'
import { AuthorizedProfilesService } from '../services/authorized-profiles.service'
import type { WindowBootstrapSource } from './bootstrap-data'
import {
  COMPANION_PAIRING_LABEL,
  formatCompanionClientIdentity,
} from './companion-identity'
import { readRuntimeDescriptor } from './descriptor-reader'
import type { RuntimeDescriptor } from './descriptor'
import { createPairingResponse } from './pairing'
import { defaultProcessLivenessProbe, type ProcessLivenessProbe } from './process-liveness'
import type {
  PluginRuntimeDependencies,
  PluginSocket,
  RandomBytesProvider,
  RuntimeTimerScheduler,
  SocketConnector,
} from './plugin-runtime-deps'
import type { RuntimeDiagnosticCode } from './runtime-diagnostics'
import { resolvePluginDescriptorPaths } from './runtime-paths'
import { RuntimeLeaseState } from './runtime-lease-state'

const DESCRIPTOR_POLL_MS = 1_000

export class SendUnavailableError extends Error {
  constructor() {
    super('send_unavailable')
    this.name = 'SendUnavailableError'
  }
}

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
  generation: number
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
  private readonly isProcessAlive: ProcessLivenessProbe
  private readonly onDiagnostic: (code: RuntimeDiagnosticCode) => void
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
  private pairingGeneration = 0
  private reconnectTimer?: { cancel(): void }
  private readonly pendingRpc = new Map<string, PendingRpc>()
  private connectionEpoch = 0
  private connectChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly bootstrap: WindowBootstrapSource,
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
    this.isProcessAlive = dependencies.isProcessAlive ?? defaultProcessLivenessProbe
    this.onDiagnostic = dependencies.onDiagnostic ?? (() => undefined)
    this.windowInstanceId = this.random.randomId()
  }

  start(): void {
    if (this.started || this.destroyed) {
      return
    }
    this.started = true
    void this.audit.safeAppend({ event: 'runtime_start', result: 'ok' })
    this.scheduleReconnect(0)
  }

  destroy(): void {
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    this.cancelReconnectTimer()
    this.teardownConnection('runtime_stop')
    void this.audit.safeAppend({ event: 'runtime_stop', result: 'ok' })
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
      void this.enqueueAttemptConnect()
    })
  }

  private cancelReconnectTimer(): void {
    this.reconnectTimer?.cancel()
    this.reconnectTimer = undefined
  }

  private enqueueAttemptConnect(): void {
    this.connectChain = this.connectChain
      .then(() => this.attemptConnect())
      .catch(() => undefined)
  }

  private async attemptConnect(): Promise<void> {
    if (this.destroyed) {
      return
    }
    this.teardownConnection('reconnect')

    const read = await readRuntimeDescriptor(this.descriptorPath, this.fs, {
      platform: this.platform,
      isProcessAlive: this.isProcessAlive,
    })
    if (!this.isEpochCurrent(this.connectionEpoch)) {
      return
    }
    if (!read.ok) {
      this.onDiagnostic('descriptor_unavailable')
      this.scheduleReconnect(this.reconnectDelayMs)
      return
    }

    const descriptor = read.descriptor
    const generation = this.connectionEpoch
    this.activeDescriptor = descriptor

    const socket = this.connector.connect(descriptor.endpoint, () => {
      void this.onSocketConnected(descriptor, generation)
    })
    this.socket = socket

    socket.on('data', (chunk) => {
      if (!this.isEpochCurrent(generation) || this.socket !== socket) {
        return
      }
      try {
        const messages = this.decoder.push(chunk)
        for (const message of messages) {
          void this.handleMessage(message, descriptor, generation).catch(() => {
            this.onDiagnostic('handler_error')
          })
        }
      } catch {
        this.onDiagnostic('frame_error')
        this.teardownConnection('frame_error')
        if (!this.destroyed) {
          this.scheduleReconnect(this.reconnectDelayMs)
        }
      }
    })
    socket.on('close', () => {
      if (!this.isEpochCurrent(generation) || this.socket !== socket) {
        return
      }
      this.teardownConnection('disconnect')
      if (!this.destroyed) {
        this.scheduleReconnect(this.reconnectDelayMs)
      }
    })
    socket.on('error', () => {
      if (!this.isEpochCurrent(generation) || this.socket !== socket) {
        return
      }
      this.onDiagnostic('socket_error')
      this.teardownConnection('socket_error')
      if (!this.destroyed) {
        this.scheduleReconnect(this.reconnectDelayMs)
      }
    })
  }

  private async onSocketConnected(
    descriptor: RuntimeDescriptor,
    generation: number,
  ): Promise<void> {
    if (!this.isEpochCurrent(generation) || this.destroyed) {
      return
    }
    try {
      this.pluginChallenge = Buffer.from(this.random.randomBytes(16)).toString('base64url')
      const windowBootstrap = this.bootstrap()
      await this.send(
        {
          v: 1,
          seq: 0,
          type: 'plugin_hello',
          window_instance_id: this.windowInstanceId,
          is_main_window: windowBootstrap.isMainWindow,
          plugin_challenge: this.pluginChallenge,
        },
        generation,
      )
      void this.audit.safeAppend({ event: 'runtime_connect', result: 'ok' })
    } catch {
      this.onDiagnostic('handshake_failed')
      this.teardownConnection('handshake_failed')
    }
  }

  private async handleMessage(
    message: IpcMessage,
    descriptor: RuntimeDescriptor,
    generation: number,
  ): Promise<void> {
    if (!this.isEpochCurrent(generation)) {
      return
    }
    if (message.type === 'companion_challenge') {
      await this.handleCompanionChallenge(message, descriptor, generation)
      return
    }
    if (message.type === 'lease_granted') {
      if (!this.isEpochCurrent(generation)) {
        return
      }
      this.isLeaseHolder = true
      this.leaseState.grant(message.lease_epoch)
      void this.audit.safeAppend({ event: 'lease_granted', result: 'ok' })
      return
    }
    if (message.type === 'lease_revoked') {
      this.handleLeaseLoss()
      void this.audit.safeAppend({
        event: 'lease_lost',
        result: 'error',
        errorCode: message.reason,
      })
      return
    }
    if (message.type === 'rpc_request') {
      await this.handleRpcRequest(message, generation)
      return
    }
    if (message.type === 'cancel_request') {
      this.handleCancelRequest(message, generation)
    }
  }

  private async handleCompanionChallenge(
    message: Extract<IpcMessage, { type: 'companion_challenge' }>,
    descriptor: RuntimeDescriptor,
    generation: number,
  ): Promise<void> {
    if (!this.isEpochCurrent(generation)) {
      return
    }
    this.companionChallenge = message.companion_challenge
    this.pairingAbort?.abort()
    this.pairingAbort = new AbortController()
    const pairingGeneration = generation
    this.pairingGeneration = pairingGeneration

    const clientIdentity = formatCompanionClientIdentity(descriptor)
    const pairing = await this.gatekeeper.requestPairingApproval({
      clientIdentity,
      companionLabel: COMPANION_PAIRING_LABEL,
      signal: this.pairingAbort.signal,
    })

    if (!this.isEpochCurrent(pairingGeneration) || this.pairingGeneration !== pairingGeneration) {
      return
    }

    const approved = pairing.ok && pairing.approved
    void this.audit.safeAppend({
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

    try {
      await this.send(
        {
          v: 1,
          seq: 0,
          type: 'pairing_decision',
          window_instance_id: this.windowInstanceId,
          approved,
          response,
        },
        pairingGeneration,
      )
    } catch {
      return
    }
  }

  private handleLeaseLoss(): void {
    this.isLeaseHolder = false
    this.leaseState.clear()
    this.abortAllPendingRpc()
    this.clearProfileRefs()
  }

  private async handleRpcRequest(
    message: Extract<IpcMessage, { type: 'rpc_request' }>,
    generation: number,
  ): Promise<void> {
    if (!this.canServeRpc(message.lease_epoch, generation)) {
      return
    }

    if (message.request.method === 'list_authorized_ssh_profiles') {
      await this.handleListRpc(message, generation)
      return
    }
    if (message.request.method === 'open_authorized_ssh_profile') {
      await this.handleOpenRpc(message, generation)
      return
    }
    if (message.request.method === 'get_ssh_operation_authorization') {
      await this.handleAuthorizationRpc(message, generation)
      return
    }
    if (message.request.method === 'run_authorized_ssh_command') {
      await this.handleCommandRpc(message, generation)
    }
  }

  private async handleListRpc(
    message: Extract<IpcMessage, { type: 'rpc_request' }>,
    generation: number,
  ): Promise<void> {
    try {
      const profiles = await this.authorizedProfiles.listAuthorizedProfiles()
      if (!this.isEpochCurrent(generation)) {
        this.clearProfileRefs()
        return
      }
      if (!this.canServeRpc(message.lease_epoch, generation)) {
        return
      }
      const dto = profiles.map((entry) => ({
        profile_ref: entry.profile_ref,
        display_name: entry.display_name,
      }))
      void this.audit.safeAppend({
        event: 'list_result',
        result: 'ok',
        authorizedCount: dto.length,
      })
      await this.sendRpcResult(message.request_id, message.lease_epoch, generation, {
        ok: true,
        result: { profiles: dto },
      })
    } catch {
      if (!this.canServeRpc(message.lease_epoch, generation)) {
        return
      }
      void this.audit.safeAppend({ event: 'list_result', result: 'error', errorCode: 'internal' })
      await this.sendRpcResult(message.request_id, message.lease_epoch, generation, {
        ok: false,
        code: 'internal',
      })
    }
  }

  private async handleAuthorizationRpc(
    message: Extract<IpcMessage, { type: 'rpc_request' }>,
    generation: number,
  ): Promise<void> {
    if (message.request.method !== 'get_ssh_operation_authorization') {
      return
    }
    const requestId = message.request_id
    const leaseEpoch = message.lease_epoch
    try {
      const described = await this.gatekeeper.describeOperationAuthorization(
        message.request.params.profile_ref,
      )
      if (!this.canServeRpc(leaseEpoch, generation)) {
        return
      }
      if (!described.ok) {
        await this.sendRpcResult(requestId, leaseEpoch, generation, {
          ok: false,
          code: 'target_unavailable',
        })
        return
      }
      await this.sendRpcResult(requestId, leaseEpoch, generation, {
        ok: true,
        result: {
          profile_ref: described.profileRef,
          open_session: described.openSession,
          operation_tier: described.operationTier,
          authorizes: SSH_COMMAND_AUTHORIZATION_SUBJECT,
          policy: described.policy.map(entry => ({
            tier: entry.tier,
            rank: entry.rank,
            label: entry.label,
            subject: entry.subject,
            effect: entry.effect,
          })),
        },
      })
    } catch {
      if (!this.canServeRpc(leaseEpoch, generation)) {
        return
      }
      await this.sendRpcResult(requestId, leaseEpoch, generation, {
        ok: false,
        code: 'internal',
      })
    }
  }

  private async handleCommandRpc(
    message: Extract<IpcMessage, { type: 'rpc_request' }>,
    generation: number,
  ): Promise<void> {
    if (message.request.method !== 'run_authorized_ssh_command') {
      return
    }
    const requestId = message.request_id
    const leaseEpoch = message.lease_epoch
    const existing = this.pendingRpc.get(requestId)
    if (existing) {
      existing.controller.abort()
      this.pendingRpc.delete(requestId)
      this.onDiagnostic('protocol_violation')
      this.teardownConnection('protocol_violation')
      if (!this.destroyed) {
        this.scheduleReconnect(0)
      }
      return
    }

    const controller = new AbortController()
    this.pendingRpc.set(requestId, {
      leaseEpoch,
      generation,
      controller,
      cancelled: false,
      cancelSent: false,
    })

    try {
      const result = await this.gatekeeper.runAuthorizedSshCommand({
        requestId,
        leaseEpoch,
        profileRef: message.request.params.profile_ref,
        command: message.request.params.command,
        deadlineMonotonicMs: this.clock.now() + 45_000,
        signal: controller.signal,
      })
      const pending = this.pendingRpc.get(requestId)
      if (!pending || pending.cancelled || pending.generation !== generation) {
        return
      }
      this.pendingRpc.delete(requestId)
      if (!this.canServeRpc(leaseEpoch, generation)) {
        return
      }
      if (result.ok) {
        void this.audit.safeAppend({ event: 'command_result', result: 'ok', requestId })
        await this.sendRpcResult(requestId, leaseEpoch, generation, {
          ok: true,
          result: {
            status: result.truncated ? 'truncated' : 'completed',
            command_class: result.commandClass,
            output: result.output,
            truncated: result.truncated,
          },
        })
        return
      }
      const code = result.code === 'expired' ? 'expired' : mapApprovalError(result.code)
      void this.audit.safeAppend({
        event: 'command_result',
        result: 'error',
        requestId,
        errorCode: code,
      })
      await this.sendRpcResult(requestId, leaseEpoch, generation, { ok: false, code })
    } catch {
      this.pendingRpc.delete(requestId)
      if (!this.canServeRpc(leaseEpoch, generation)) {
        return
      }
      void this.audit.safeAppend({
        event: 'command_result',
        result: 'error',
        requestId,
        errorCode: 'internal',
      })
      await this.sendRpcResult(requestId, leaseEpoch, generation, { ok: false, code: 'internal' })
    }
  }

  private async handleOpenRpc(
    message: Extract<IpcMessage, { type: 'rpc_request' }>,
    generation: number,
  ): Promise<void> {
    const requestId = message.request_id
    const leaseEpoch = message.lease_epoch
    const profileRef = message.request.params.profile_ref

    const existing = this.pendingRpc.get(requestId)
    if (existing) {
      existing.controller.abort()
      this.pendingRpc.delete(requestId)
      this.onDiagnostic('protocol_violation')
      this.teardownConnection('protocol_violation')
      if (!this.destroyed) {
        this.scheduleReconnect(0)
      }
      return
    }

    const controller = new AbortController()
    this.pendingRpc.set(requestId, {
      leaseEpoch,
      generation,
      controller,
      cancelled: false,
      cancelSent: false,
    })

    void this.audit.safeAppend({
      event: 'open_requested',
      result: 'ok',
      requestId,
    })

    const descriptor = this.activeDescriptor
    const clientIdentity = descriptor
      ? formatCompanionClientIdentity(descriptor)
      : 'tabby-secure-mcp-companion'

    try {
      const deadlineMonotonicMs = this.clock.now() + APPROVAL_WINDOW_MS
      const result = await this.gatekeeper.requestOpen({
        requestId,
        leaseEpoch,
        profileRef,
        clientIdentity,
        toolName: 'open_authorized_ssh_profile',
        operation: {
          method: 'open_authorized_ssh_profile',
          params: { profile_ref: profileRef },
        },
        deadlineMonotonicMs,
        signal: controller.signal,
      })

      const pending = this.pendingRpc.get(requestId)
      if (!pending || pending.cancelled || pending.generation !== generation) {
        return
      }
      this.pendingRpc.delete(requestId)

      if (!this.canServeRpc(leaseEpoch, generation)) {
        return
      }

      if (result.ok) {
        void this.audit.safeAppend({ event: 'open_result', result: 'ok', requestId })
        await this.sendRpcResult(requestId, leaseEpoch, generation, {
          ok: true,
          result: { status: 'opened' },
        })
        return
      }

      void this.audit.safeAppend({
        event: 'open_result',
        result: 'error',
        requestId,
        errorCode: result.code,
      })
      await this.sendRpcResult(requestId, leaseEpoch, generation, {
        ok: false,
        code: mapApprovalError(result.code),
      })
    } catch {
      this.pendingRpc.delete(requestId)
      if (!this.canServeRpc(leaseEpoch, generation)) {
        return
      }
      void this.audit.safeAppend({
        event: 'open_result',
        result: 'error',
        requestId,
        errorCode: 'internal',
      })
      await this.sendRpcResult(requestId, leaseEpoch, generation, {
        ok: false,
        code: 'internal',
      })
    }
  }

  private handleCancelRequest(
    message: Extract<IpcMessage, { type: 'cancel_request' }>,
    generation: number,
  ): void {
    if (!this.canServeRpc(message.lease_epoch, generation)) {
      return
    }
    const pending = this.pendingRpc.get(message.request_id)
    if (!pending || pending.leaseEpoch !== message.lease_epoch || pending.generation !== generation) {
      return
    }
    if (pending.cancelSent) {
      return
    }
    pending.cancelled = true
    pending.cancelSent = true
    pending.controller.abort()
    this.pendingRpc.delete(message.request_id)
    void this.audit.safeAppend({
      event: 'cancel',
      result: 'ok',
      requestId: message.request_id,
    })
    void this.sendRpcCancelled(message.request_id, message.lease_epoch, generation, 'cancelled')
  }

  private async sendRpcResult(
    requestId: string,
    leaseEpoch: number,
    generation: number,
    outcome:
      | { ok: true; result: Record<string, unknown> }
      | { ok: false; code: ErrorCode },
  ): Promise<void> {
    if (!this.canServeRpc(leaseEpoch, generation)) {
      return
    }
    if (outcome.ok) {
      await this.send(
        {
          v: 1,
          seq: 0,
          type: 'rpc_result',
          request_id: requestId,
          lease_epoch: leaseEpoch,
          ok: true,
          result: outcome.result as never,
        },
        generation,
      )
      return
    }
    await this.send(
      {
        v: 1,
        seq: 0,
        type: 'rpc_result',
        request_id: requestId,
        lease_epoch: leaseEpoch,
        ok: false,
        error: { code: outcome.code },
      },
      generation,
    )
  }

  private async sendRpcCancelled(
    requestId: string,
    leaseEpoch: number,
    generation: number,
    reason: ErrorCode,
  ): Promise<void> {
    if (!this.canServeRpc(leaseEpoch, generation)) {
      return
    }
    try {
      await this.send(
        {
          v: 1,
          seq: 0,
          type: 'rpc_cancelled',
          request_id: requestId,
          lease_epoch: leaseEpoch,
          reason,
        },
        generation,
      )
    } catch {
      return
    }
  }

  private async send(message: IpcMessage, generation: number): Promise<void> {
    if (!this.canSend(generation)) {
      throw new SendUnavailableError()
    }
    const socket = this.socket!
    this.outboundSeq += 1
    const frame = encodeFrame({ ...message, v: 1, seq: this.outboundSeq })
    await new Promise<void>((resolve, reject) => {
      socket.write(frame, (error) => (error ? reject(error) : resolve()))
    })
  }

  private teardownConnection(_reason: string): void {
    const wasHolder = this.isLeaseHolder
    this.connectionEpoch += 1
    this.pairingGeneration += 1
    this.pairingAbort?.abort()
    this.pairingAbort = undefined
    this.isLeaseHolder = false
    this.leaseState.clear()
    this.abortAllPendingRpc()
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
    if (wasHolder) {
      void this.audit.safeAppend({
        event: 'lease_lost',
        result: 'error',
        errorCode: 'plugin_unavailable',
      })
    }
  }

  private abortAllPendingRpc(): void {
    for (const [requestId, pending] of this.pendingRpc.entries()) {
      pending.cancelled = true
      pending.controller.abort()
      this.pendingRpc.delete(requestId)
    }
  }

  private clearProfileRefs(): void {
    this.authorizedProfiles.clearRefCache()
  }

  private isEpochCurrent(generation: number): boolean {
    return !this.destroyed && this.connectionEpoch === generation
  }

  private canSend(generation: number): boolean {
    return (
      !this.destroyed &&
      this.connectionEpoch === generation &&
      this.socket !== undefined &&
      !this.socket.destroyed
    )
  }

  private canServeRpc(leaseEpoch: number, generation: number): boolean {
    return (
      this.canSend(generation) &&
      this.isLeaseHolder &&
      this.leaseState.getLeaseEpoch() === leaseEpoch
    )
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
