import { Injectable } from '@angular/core'
import type { ConfigService } from 'tabby-core'
import { dirname, join } from 'node:path'
import {
  APPROVAL_WINDOW_MS, CredentialStore, EmbeddedMcpServer,
  type CredentialStorePort, type EmbeddedMcpOptions, type HttpCallContext,
  type HttpCallResult, type OperationalRequest,
} from '@tabby-secure-mcp/companion'
import { resolveAuditLogPath } from '../audit/audit-paths'
import type { AuditService } from '../audit/audit-service'
import type { ApprovalGatekeeper } from '../approval/approval-gatekeeper'
import type { NgBootstrapApprovalPresenter } from '../approval/ng-bootstrap-approval-presenter'
import { sanitizeApprovalDisplayText } from '../approval/display-sanitizer'
import type { AuthorizedProfilesService } from '../services/authorized-profiles.service'
import type { RuntimeLeaseState } from './runtime-lease-state'
import type { WindowBootstrapSource } from './bootstrap-data'

interface ServerConfig { enabled: boolean; port: number }
interface HttpRuntimeDependencies {
  credentials?: CredentialStorePort
  createServer?: (options: EmbeddedMcpOptions) => Pick<EmbeddedMcpServer, 'start' | 'close' | 'sessionViews'>
  notify?: (work: () => void) => void
}

function readConfig(config: ConfigService): ServerConfig {
  const value = config.store?.secureMcp?.http
  const port = value?.port ?? 50333
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be an integer from 1024 to 65535.')
  return { enabled: value?.enabled === true, port }
}

@Injectable()
export class PluginHttpRuntime {
  readonly credentials: CredentialStorePort
  readonly isMainWindow: boolean
  status: 'stopped' | 'starting' | 'running' | 'secondary' | 'error' = 'stopped'
  error: string | null = null
  private server?: Pick<EmbeddedMcpServer, 'start' | 'close' | 'sessionViews'>
  private activeConfig?: ServerConfig
  private generation = 0
  private destroyed = false
  private started = false
  private initialized = false
  private suspended = false
  private savingConfig = false
  private approvingClient = false
  private chain: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<() => void>()
  private readonly cleanup: (() => void)[] = []

  constructor(
    private readonly config: ConfigService,
    bootstrap: WindowBootstrapSource,
    private readonly lease: RuntimeLeaseState,
    private readonly gatekeeper: ApprovalGatekeeper,
    private readonly profiles: AuthorizedProfilesService,
    private readonly audit: AuditService,
    private readonly presenter: NgBootstrapApprovalPresenter,
    private readonly dependencies: HttpRuntimeDependencies = {},
  ) {
    this.isMainWindow = bootstrap().isMainWindow
    this.credentials = dependencies.credentials ?? new CredentialStore(join(dirname(resolveAuditLogPath()), 'http-credentials.json'))
    if (!this.isMainWindow) this.status = 'secondary'
  }

  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private changed(): void {
    try {
      (this.dependencies.notify ?? (work => work()))(() => {
        for (const listener of this.listeners) { try { listener() } catch { /* UI observers do not own shutdown. */ } }
      })
    } catch { /* A disposed Angular zone must not prevent request cancellation. */ }
  }
  sessions() { return this.server?.sessionViews() ?? [] }
  serverConfig(): ServerConfig {
    try { return readConfig(this.config) } catch { return { enabled: false, port: 50333 } }
  }

  async start(): Promise<void> {
    if (this.started || this.destroyed || !this.isMainWindow) return
    this.started = true
    const subscription = this.config.changed$?.subscribe(() => {
      if (!this.initialized || this.savingConfig) return
      try {
        const desired = readConfig(this.config)
        if (this.server && (!desired.enabled || this.activeConfig?.port !== desired.port)) void this.stopNow().catch(() => {})
      } catch { void this.stopNow().catch(() => {}) }
      void this.reconcile()
    })
    if (subscription) this.cleanup.push(() => subscription.unsubscribe())
    this.cleanup.push(this.credentials.onChange(() => this.changed()))
    try {
      await this.credentials.load()
      if (this.destroyed) return
      this.initialized = true
      await this.reconcile()
    } catch {
      this.status = 'error'
      this.error = 'Could not load MCP credentials or start the local service. Check the private credential file and port availability.'
      this.changed()
    }
  }

  private stopNow(): Promise<void> {
    ++this.generation
    this.lease.clear()
    this.profiles.clearRefCache()
    const previous = this.server
    this.server = undefined
    this.activeConfig = undefined
    this.status = this.isMainWindow ? 'stopped' : 'secondary'
    this.changed()
    return previous?.close() ?? Promise.resolve()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const close of this.cleanup.splice(0)) close()
    void this.stopNow().catch(() => {})
    this.listeners.clear()
  }

  async setServerConfig(enabled: boolean, port: number): Promise<void> {
    if (!this.isMainWindow || this.destroyed || this.savingConfig) throw new Error('Manage MCP from the main Tabby window.')
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be an integer from 1024 to 65535.')
    this.savingConfig = true
    this.suspended = true
    const closed = this.stopNow()
    const store = this.config.store
    const previous = { enabled: store.secureMcp?.http?.enabled ?? false, port: store.secureMcp?.http?.port ?? 50333 }
    try {
      await closed
      if (!store.secureMcp) throw new Error('Configuration is unavailable.')
      if (!store.secureMcp.http) store.secureMcp.http = {}
      store.secureMcp.http.enabled = enabled
      store.secureMcp.http.port = port
      await this.config.save()
      if (this.config.store !== store) throw new Error('Configuration changed during save.')
      this.suspended = false
      this.error = null
    } catch {
      if (this.config.store === store && store.secureMcp?.http) {
        store.secureMcp.http.enabled = previous.enabled
        store.secureMcp.http.port = previous.port
      }
      this.error = 'Service stopped for this run, but the configuration was not saved. Retry before restarting Tabby.'
      this.changed()
      throw new Error(this.error)
    } finally { this.savingConfig = false }
    await this.reconcile()
  }

  private reconcile(): Promise<void> {
    const task = this.chain.then(async () => {
      if (this.destroyed || !this.initialized || this.suspended || this.savingConfig) return
      const desired = readConfig(this.config)
      if (this.server && this.activeConfig?.enabled === desired.enabled && this.activeConfig.port === desired.port) return
      await this.stopNow()
      if (!desired.enabled || this.destroyed || this.suspended) return
      const generation = this.generation
      this.status = 'starting'
      this.changed()
      const options: EmbeddedMcpOptions = {
        port: desired.port,
        credentials: this.credentials,
        dispatch: (request, context) => this.dispatch(request, context, generation),
        audit: (event, result) => this.audit.append({ event, result }),
        onChange: () => this.changed(),
        approveClient: async (client, signal, declaredName) => {
          if (this.approvingClient || this.gatekeeper.approvalBusy || this.generation !== generation || signal.aborted) return null
          this.approvingClient = true
            const deadline = performance.now() + APPROVAL_WINDOW_MS
          try {
            return await this.presenter.presentClient({
              clientIdentity: sanitizeApprovalDisplayText(client.name),
              companionLabel: sanitizeApprovalDisplayText(declaredName),
                remainingSeconds: APPROVAL_WINDOW_MS / 1000,
            }, { signal, deadlineMonotonicMs: deadline, remainingSeconds: () => Math.max(0, Math.ceil((deadline - performance.now()) / 1000)) })
          } finally { this.approvingClient = false }
        },
      }
      const server = (this.dependencies.createServer ?? (value => new EmbeddedMcpServer(value)))(options)
      this.server = server
      try {
        await server.start()
        if (this.destroyed || this.suspended || this.generation !== generation) { await server.close(); return }
        this.activeConfig = desired
        this.lease.grant(generation)
        this.status = 'running'
        this.error = null
      } catch {
        await this.stopNow().catch(() => {})
        this.status = 'error'
        this.error = 'Could not start local MCP. Check the configured port and audit/credential storage.'
      }
      this.changed()
    })
    this.chain = task.catch(() => { this.error = 'Invalid MCP service configuration.'; this.status = 'error'; this.changed() })
    return this.chain
  }

  private async dispatch(request: OperationalRequest, context: HttpCallContext, generation: number): Promise<HttpCallResult> {
      const current = () => !this.destroyed && this.status === 'running' && this.generation === generation && !context.signal.aborted && this.credentials.isCurrent(context.client)
    if (!current()) return { ok: false, code: 'plugin_unavailable' }
    if (this.approvingClient) return { ok: false, code: 'busy' }
    const { requestId, signal, deadlineMonotonicMs } = context
    let mayHaveExecuted = false
    try {
        const connection = { client: context.client, permissions: this.credentials,
          revision: this.credentials.connectionRevision(context.client), isCurrent: () => this.credentials.isCurrent(context.client) }
      switch (request.method) {
        case 'list_authorized_ssh_profiles': {
          const profiles = await this.profiles.listAuthorizedProfiles()
          if (!current()) return { ok: false, code: 'cancelled' }
          await this.audit.append({ event: 'list_result', result: 'ok', authorizedCount: profiles.length })
          if (!current()) return { ok: false, code: 'cancelled' }
          return { ok: true, result: { profiles: profiles.map(({ profile_ref, display_name }) => ({ profile_ref, display_name })) } }
        }
        case 'get_ssh_operation_authorization': {
            const value = await this.gatekeeper.describeOperationAuthorization(request.params.profile_ref, connection)
          if (!current()) return { ok: false, code: 'cancelled' }
          if (!value.ok) return value
          return { ok: true, result: { profile_ref: value.profileRef, open_session: value.openSession, operation_tier: value.operationTier, authorizes: 'ssh_command', policy: value.policy } }
        }
        case 'open_authorized_ssh_profile': {
          await this.audit.append({ event: 'open_requested', result: 'ok', requestId })
          if (!current() || this.approvingClient) {
            const code = current() ? 'busy' : 'cancelled'
            await this.audit.append({ event: 'open_result', result: 'error', requestId, errorCode: code })
            return { ok: false, code }
          }
          mayHaveExecuted = true
            const value = await this.gatekeeper.requestOpen({ requestId, leaseEpoch: generation, profileRef: request.params.profile_ref, clientIdentity: context.client.name, toolName: request.method, operation: request, deadlineMonotonicMs, signal, connection })
          if (!value.ok) {
            mayHaveExecuted = value.code === 'outcome_unknown' || value.code === 'target_unavailable'
            await this.audit.append({ event: 'open_result', result: 'error', requestId, errorCode: value.code })
            return value
          }
          await this.audit.append({ event: 'open_result', result: 'ok', requestId })
          if (!current()) return { ok: false, code: 'outcome_unknown' }
          return { ok: true, result: { status: 'opened' } }
        }
        case 'run_authorized_ssh_command': {
          mayHaveExecuted = true
            const value = await this.gatekeeper.runAuthorizedSshCommand({ requestId, leaseEpoch: generation, profileRef: request.params.profile_ref, command: request.params.command, deadlineMonotonicMs, signal, connection })
          if (!value.ok) {
            mayHaveExecuted = value.code === 'outcome_unknown' || value.code === 'target_unavailable'
            await this.audit.append({ event: 'command_result', result: 'error', requestId, errorCode: value.code })
            return value
          }
          await this.audit.append({ event: 'command_result', result: 'ok', requestId })
          if (!current()) return { ok: false, code: 'outcome_unknown' }
          return { ok: true, result: { status: value.truncated ? 'truncated' : 'completed', command_class: value.commandClass, output: value.output, truncated: value.truncated } }
        }
      }
    } catch { return { ok: false, code: mayHaveExecuted ? 'outcome_unknown' : 'audit_unavailable' } }
  }
}
