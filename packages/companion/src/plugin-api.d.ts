import type { ApprovedCommandRule } from '@tabby-secure-mcp/ipc-contract/command-policy'
export type { ApprovedCommandRule } from '@tabby-secure-mcp/ipc-contract/command-policy'
// Public facade stays compatible with the Tabby host's TypeScript 4.9 compiler.
export type ErrorCode = 'target_unavailable' | 'not_approved' | 'expired' | 'cancelled' | 'busy' | 'rate_limited' | 'plugin_unavailable' | 'internal' | 'audit_unavailable' | 'outcome_unknown' | 'command_disabled' | 'unsupported_command' | 'approval_unavailable' | 'file_transfer_disabled' | 'file_transfer_failed' | 'file_exists' | 'file_too_large' | 'invalid_path'
export type OperationalRequest =
  | { method: 'list_authorized_ssh_profiles'; params: Record<string, never> }
  | { method: 'open_authorized_ssh_profile'; params: { profile_ref: string } }
  | { method: 'close_mcp_ssh_tab'; params: { tab_ref: string } }
  | { method: 'get_ssh_operation_authorization'; params: { profile_ref: string } }
  | { method: 'run_authorized_ssh_command'; params: { profile_ref: string; command: string; tab_ref?: string; new_tab?: boolean } }
  | { method: 'upload_ssh_file'; params: { profile_ref: string; local_path: string; remote_path: string } }
  | { method: 'download_ssh_file'; params: { profile_ref: string; local_path: string; remote_path: string } }
export type ApprovalDuration = 'session' | '24h' | 'permanent'
export declare const APPROVAL_WINDOW_MS: number
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

export interface CredentialStore extends CredentialStorePort {}
export declare const CredentialStore: { new(filePath: string): CredentialStore }
export declare class EmbeddedMcpServer {
  constructor(options: EmbeddedMcpOptions)
  start(): Promise<void>
  close(): Promise<void>
  sessionViews(): HttpSessionView[]
}
