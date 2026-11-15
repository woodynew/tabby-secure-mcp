// Public facade stays compatible with the Tabby host's TypeScript 4.9 compiler.
export type ErrorCode = 'target_unavailable' | 'not_approved' | 'expired' | 'cancelled' | 'busy' | 'rate_limited' | 'plugin_unavailable' | 'internal' | 'audit_unavailable' | 'outcome_unknown'
export type OperationalRequest =
  | { method: 'list_authorized_ssh_profiles'; params: Record<string, never> }
  | { method: 'open_authorized_ssh_profile'; params: { profile_ref: string } }
  | { method: 'get_ssh_operation_authorization'; params: { profile_ref: string } }
  | { method: 'run_authorized_ssh_command'; params: { profile_ref: string; command: string } }
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
export interface ClientConnectionPermissions {
  connectionGrants(client: ClientIdentity): ClientConnectionGrant[]
  connectionRevision(client: ClientIdentity): number
  hasConnectionPermission(client: ClientIdentity, profileId: string, profileDigest: string): boolean
  setConnectionPermission(client: ClientIdentity, profileId: string, profileDigest: string | null, expectedRevision?: number): Promise<void>
}
export interface CredentialStorePort extends ClientConnectionPermissions {
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
