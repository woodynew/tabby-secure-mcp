import type { ApprovedCommandRule } from '@tabby-secure-mcp/ipc-contract/command-policy'
export type { ApprovedCommandRule } from '@tabby-secure-mcp/ipc-contract/command-policy'
import type { ErrorCode, OperationalRequest } from '@tabby-secure-mcp/ipc-contract'

export type ApprovalDuration = 'session' | '24h' | 'permanent'
export const APPROVAL_WINDOW_MS = 60_000
export interface ClientIdentity { id: string; name: string; generation: number }
export type ClientPermission =
  | { kind: 'none' }
  | { kind: 'session' }
  | { kind: 'until'; approvedAt: number; expiresAt: number }
  | { kind: 'permanent'; approvedAt: number }
export interface ClientCredentialView extends ClientIdentity { permission: ClientPermission }
export interface ClientConnectionGrant { profileId: string; profileDigest: string; updatedAt: number }
export interface ClientFileTransferGrant { profileId: string; profileDigest: string; updatedAt: number }
export interface FileTransferPermissions {
  fileTransferRevision(): number
  hasFileTransferPermission(client: ClientIdentity, profileId: string, profileDigest: string): boolean
  setFileTransferPermission(client: ClientIdentity, profileId: string, profileDigest: string | null, expectedRevision: number, stillCurrent?: () => boolean): Promise<void>
}
export interface DefaultCommandSet { rules: ApprovedCommandRule[]; revision: number }
export interface ClientCommandSet extends DefaultCommandSet {
  profileId: string
  profileDigest: string
  inheritDefaults: boolean
  defaultRules: ApprovedCommandRule[]
  stale: boolean
}
export interface CommandSetUpdate { inheritDefaults: boolean; rules: ApprovedCommandRule[] }
export interface CommandPermissions {
  commandRevision(): number
  defaultCommandSet(): DefaultCommandSet
  commandSet(client: ClientIdentity, profileId: string, profileDigest: string): ClientCommandSet
  setDefaultCommandSet(rules: ApprovedCommandRule[], expectedRevision: number): Promise<void>
  /** beforeCommit runs under the queued, durable guard; it must not enqueue writes to this store. */
  setCommandSet(client: ClientIdentity, profileId: string, profileDigest: string, update: CommandSetUpdate, expectedRevision: number, stillCurrent?: () => boolean, beforeCommit?: () => Promise<void>): Promise<void>
}
export interface ClientConnectionPermissions extends Partial<CommandPermissions>, Partial<FileTransferPermissions> {
  connectionGrants(client: ClientIdentity): ClientConnectionGrant[]
  connectionRevision(client: ClientIdentity): number
  hasConnectionPermission(client: ClientIdentity, profileId: string, profileDigest: string): boolean
  setConnectionPermission(client: ClientIdentity, profileId: string, profileDigest: string | null, expectedRevision?: number, stillCurrent?: () => boolean): Promise<void>
}
export interface CredentialStorePort extends ClientConnectionPermissions, FileTransferPermissions {
  fileTransferRevision(): number
  hasFileTransferPermission(client: ClientIdentity, profileId: string, profileDigest: string): boolean
  setFileTransferPermission(client: ClientIdentity, profileId: string, profileDigest: string | null, expectedRevision: number, stillCurrent?: () => boolean): Promise<void>
  commandRevision(): number
  defaultCommandSet(): DefaultCommandSet
  commandSet(client: ClientIdentity, profileId: string, profileDigest: string): ClientCommandSet
  setDefaultCommandSet(rules: ApprovedCommandRule[], expectedRevision: number): Promise<void>
  setCommandSet(client: ClientIdentity, profileId: string, profileDigest: string, update: CommandSetUpdate, expectedRevision: number, stillCurrent?: () => boolean, beforeCommit?: () => Promise<void>): Promise<void>
  load(): Promise<void>
  list(): ClientCredentialView[]
  create(name: string): Promise<ClientCredentialView>
  rename(id: string, name: string): Promise<void>
  reset(id: string): Promise<void>
  revoke(id: string): Promise<void>
  setPermission(id: string, generation: number, duration: ApprovalDuration | 'none'): Promise<void>
  consumeSessionPermission(id: string, generation: number): boolean
  tokenFor(id: string): string
  authenticate(token: string): ClientIdentity | undefined
  isCurrent(client: ClientIdentity): boolean
  permission(id: string): ClientPermission
  grant(id: string, generation: number, duration: '24h' | 'permanent'): Promise<void>
  onInvalidated(listener: (id: string) => void): () => void
  onChange(listener: () => void): () => void
  readonly hasUnpersistedRevocations: boolean
}
export type HttpCallResult = { ok: true; result: Record<string, unknown> } | { ok: false; code: ErrorCode }
export interface HttpCallContext {
  requestId: string
  signal: AbortSignal
  client: ClientIdentity
  deadlineMonotonicMs: number
}
export interface HttpSessionView {
  clientId: string
  clientName: string
  state: 'pending' | 'approved'
  duration?: ApprovalDuration
  expiresAt?: number
}
export interface EmbeddedMcpOptions {
  port: number
  credentials: CredentialStorePort
  approveClient(client: ClientIdentity, signal: AbortSignal, declaredName: string): Promise<ApprovalDuration | null>
  dispatch(request: OperationalRequest, context: HttpCallContext): Promise<HttpCallResult>
  audit(event: 'pairing_decision' | 'runtime_start' | 'runtime_stop', result: 'ok' | 'error'): Promise<void>
  onChange?(): void
}
