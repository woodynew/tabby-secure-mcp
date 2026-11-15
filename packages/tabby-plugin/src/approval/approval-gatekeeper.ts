import { Injectable } from '@angular/core'
import { APPROVAL_WINDOW_MS } from '@tabby-secure-mcp/companion'
import type { ClientConnectionPermissions, ClientIdentity } from '@tabby-secure-mcp/companion'
import type { PartialProfile, Profile, ProfilesService } from 'tabby-core'

import type { AuthorizationMemory } from '../authorization/permanent-authorization-store'
import {
  publicOperationTierPolicy,
  type GrantedOperationTier,
  type OperationTierPolicy,
  type SshCommandClass,
} from '../authorization/operation-tier-policy'
import { authorizeSingleSshCommand } from '../authorization/ssh-command'
import { isSingleCommandTab, runSingleSshCommand } from '../ssh/ssh-command-runner'
import { presentWithApprovalDeadline } from './approval-deadline'
import { buildOpenApprovalDigest } from './approval-digest'
import {
  type ApprovalPresenter,
  buildOpenApprovalViewModel,
  buildPairingApprovalViewModel,
} from './approval-presenter'
import type { ApprovalScheduler } from './approval-scheduler'
import { SystemApprovalScheduler } from './approval-scheduler'
import {
  computeEffectiveOpenDeadline,
  isValidLeaseEpoch,
  isValidOpenRequestId,
  type OpenAuthorizedOperation,
  validateOpenApprovalRequest,
} from './open-request-validation'
import type { MonotonicClock } from './monotonic-clock'
import {
  buildProfileSecuritySnapshot,
  profileSecuritySnapshotsEqual,
  stableProfileDigest,
  type ProfileSecuritySnapshot,
} from './profile-security-snapshot'
import { AuthorizedProfilesService } from '../services/authorized-profiles.service'
import type { AuditEventInput } from '../audit/audit-types'

export interface ApprovalEffects {
  audit: { append(input: AuditEventInput): Promise<void> }
  closeTab(tab: unknown): Promise<void>
}

export { APPROVAL_WINDOW_MS }
const MAX_SEEN_REQUEST_IDS = 1024

export type ApprovalErrorCode =
  | 'busy'
  | 'cancelled'
  | 'not_approved'
  | 'target_unavailable'
  | 'audit_unavailable'
  | 'outcome_unknown'

export type { OpenAuthorizedOperation }

export interface ClientConnectionContext {
  client: ClientIdentity
  permissions: ClientConnectionPermissions
  revision: number
  isCurrent(): boolean
}

export interface OpenApprovalRequest {
  requestId: string
  leaseEpoch: number
  profileRef: string
  clientIdentity: string
  toolName: string
  operation: OpenAuthorizedOperation
  deadlineMonotonicMs: number
  signal?: AbortSignal
  authorizationRevision?: number
  connection?: ClientConnectionContext
}

export interface PairingApprovalRequest {
  clientIdentity: string
  companionLabel: string
  signal?: AbortSignal
}

export type OpenApprovalResult =
  | { ok: true; status: 'opened' }
  | { ok: false; code: ApprovalErrorCode }

export type PairingApprovalResult = { ok: true; approved: true } | { ok: false; code: ApprovalErrorCode }

export type LeaseEpochSource = () => number | null

export type PublicOperationTierPolicy = Pick<
  OperationTierPolicy,
  'tier' | 'rank' | 'label' | 'subject' | 'effect'
>

export type SshCommandErrorCode = ApprovalErrorCode | 'expired'

export interface SshCommandRequest {
  requestId: string
  leaseEpoch: number
  profileRef: string
  command: string
  deadlineMonotonicMs: number
  signal?: AbortSignal
  connection?: ClientConnectionContext
}

export type SshCommandResult =
  | { ok: true; commandClass: SshCommandClass; output: string; truncated: boolean }
  | { ok: false; code: SshCommandErrorCode }

export type OperationAuthorizationDescription =
  | {
      ok: true
      profileRef: string
      openSession: boolean
      operationTier: GrantedOperationTier
      policy: PublicOperationTierPolicy[]
    }
  | { ok: false; code: 'target_unavailable' }

@Injectable()
export class ApprovalGatekeeper {
  private readonly runKey = new Uint8Array(32)
  private readonly seenRequestIds = new Set<string>()
  private readonly seenRequestQueue: string[] = []
  private presentationInFlight = false
  get approvalBusy(): boolean { return this.presentationInFlight }

  constructor(
    private readonly authorizedProfiles: AuthorizedProfilesService,
    private readonly profilesService: ProfilesService,
    private readonly presenter: ApprovalPresenter,
    private readonly clock: MonotonicClock,
    private readonly leaseEpochSource: LeaseEpochSource,
    private readonly scheduler: ApprovalScheduler = new SystemApprovalScheduler(),
    private readonly memory?: AuthorizationMemory,
      private readonly effects?: ApprovalEffects,
  ) {
    crypto.getRandomValues(this.runKey)
  }

  async requestPairingApproval(request: PairingApprovalRequest): Promise<PairingApprovalResult> {
    if (request.signal?.aborted) {
      return { ok: false, code: 'cancelled' }
    }
    if (this.presentationInFlight) {
      return { ok: false, code: 'busy' }
    }

    const deadlineMonotonicMs = this.clock.now() + APPROVAL_WINDOW_MS
    this.presentationInFlight = true
    try {
      const decision = await presentWithApprovalDeadline({
        clock: this.clock,
        scheduler: this.scheduler,
        deadlineMonotonicMs,
        userSignal: request.signal,
        present: context =>
          this.presenter.presentPairing(
            buildPairingApprovalViewModel({
              clientIdentity: request.clientIdentity,
              companionLabel: request.companionLabel,
              remainingSeconds: context.remainingSeconds(),
            }),
            context,
          ),
      })
      if (request.signal?.aborted) {
        return { ok: false, code: 'cancelled' }
      }
      if (decision !== 'allow') {
        return { ok: false, code: 'not_approved' }
      }
      return { ok: true, approved: true }
    } finally {
      this.presentationInFlight = false
    }
  }

  async requestOpen(request: OpenApprovalRequest): Promise<OpenApprovalResult> {
    if (request.signal?.aborted) {
      return { ok: false, code: 'cancelled' }
    }

    const validation = validateOpenApprovalRequest({
      requestId: request.requestId,
      leaseEpoch: request.leaseEpoch,
      profileRef: request.profileRef,
      toolName: request.toolName,
      operation: request.operation,
    })
    if (!validation.ok) {
      return validation.reason === 'invalid_profile_ref'
        ? { ok: false, code: 'target_unavailable' }
        : { ok: false, code: 'not_approved' }
    }

    if (this.seenRequestIds.has(request.requestId)) {
      return { ok: false, code: 'not_approved' }
    }

    const activeLeaseEpoch = this.leaseEpochSource()
    if (activeLeaseEpoch === null || request.leaseEpoch !== activeLeaseEpoch) {
      return { ok: false, code: 'not_approved' }
    }

    const receivedAt = this.clock.now()
    const effectiveDeadline = computeEffectiveOpenDeadline(receivedAt, request.deadlineMonotonicMs)

    if (this.presentationInFlight) {
      return { ok: false, code: 'busy' }
    }

    this.presentationInFlight = true
    try {
      const rememberedOpen = await this.peekRememberedOpen(request.profileRef, request.connection)
      if (!rememberedOpen && receivedAt >= effectiveDeadline) {
        return { ok: false, code: 'not_approved' }
      }

      this.rememberRequestId(request.requestId)
      return await this.executeOpenAfterApproval({
        ...request,
        deadlineMonotonicMs: effectiveDeadline,
          authorizationRevision: this.memory?.revision?.(),
      })
    } finally {
      this.presentationInFlight = false
    }
  }

  private async executeOpenAfterApproval(request: OpenApprovalRequest): Promise<OpenApprovalResult> {
    let approvedSnapshot: ProfileSecuritySnapshot
    let displayName: string
    let rememberedOpen = false

    try {
      const profile = await this.authorizedProfiles.resolveAuthorizedProfile(request.profileRef)
      approvedSnapshot = buildProfileSecuritySnapshot(profile, this.runKey)
      rememberedOpen = this.profileHasRememberedOpen(profile, request.connection)
      const listed = await this.authorizedProfiles.listAuthorizedProfiles()
      displayName = listed.find(entry => entry.profile_ref === request.profileRef)?.display_name ?? profile.name
    } catch {
      return { ok: false, code: 'target_unavailable' }
    }

    if (!rememberedOpen && this.clock.now() >= request.deadlineMonotonicMs) {
      return { ok: false, code: 'not_approved' }
    }

    const approvalDigest = buildOpenApprovalDigest(
      {
        toolName: request.toolName,
        profileRef: request.profileRef,
        snapshot: approvedSnapshot,
        operation: request.operation,
        leaseEpoch: request.leaseEpoch,
        requestId: request.requestId,
        deadlineMonotonicMs: request.deadlineMonotonicMs,
      },
      this.runKey,
    )

    if (!rememberedOpen) {
      const decision = await this.presentConnectionApproval(request, displayName, request.toolName, request.operation, request.clientIdentity)

      if (request.signal?.aborted) {
        return { ok: false, code: 'cancelled' }
      }

      if (decision !== 'allow') {
        return { ok: false, code: 'not_approved' }
      }
    } else if (request.signal?.aborted) {
      return { ok: false, code: 'cancelled' }
    }

    return this.consumeApprovalAndOpen(request, approvedSnapshot, approvalDigest, {
      enforceDeadline: !rememberedOpen,
      rememberAfterOpen: !rememberedOpen,
    })
  }

  async describeOperationAuthorization(profileRef: string, connection?: ClientConnectionContext): Promise<OperationAuthorizationDescription> {
    try {
      await this.authorizedProfiles.listAuthorizedProfiles()
      const profile = await this.authorizedProfiles.resolveAuthorizedProfile(profileRef)
      if (typeof profile.id !== 'string') {
        return { ok: false, code: 'target_unavailable' }
      }
      const grant = this.memory
        ? this.memory.effectiveGrant(profile.id, stableProfileDigest(profile))
        : { openSession: false, operationTier: 'none' as const }
      return {
        ok: true,
        profileRef,
        openSession: this.profileHasRememberedOpen(profile, connection),
        operationTier: grant.operationTier,
        policy: publicOperationTierPolicy(),
      }
    } catch {
      return { ok: false, code: 'target_unavailable' }
    }
  }

  private async consumeApprovalAndOpen(
    request: OpenApprovalRequest,
    approvedSnapshot: ProfileSecuritySnapshot,
    approvalDigest: string,
    options: { enforceDeadline: boolean; rememberAfterOpen: boolean },
  ): Promise<OpenApprovalResult> {
    if (request.signal?.aborted) {
      return { ok: false, code: 'cancelled' }
    }

    const activeLeaseEpoch = this.leaseEpochSource()
    if (activeLeaseEpoch === null || request.leaseEpoch !== activeLeaseEpoch) {
      return { ok: false, code: 'not_approved' }
    }

    if (options.enforceDeadline && this.clock.now() >= request.deadlineMonotonicMs) {
      return { ok: false, code: 'not_approved' }
    }

    let freshProfile
    try {
      freshProfile = await this.authorizedProfiles.resolveAuthorizedProfile(request.profileRef)
    } catch {
      return { ok: false, code: 'target_unavailable' }
    }

    let freshSnapshot: ProfileSecuritySnapshot
    try {
      freshSnapshot = buildProfileSecuritySnapshot(freshProfile, this.runKey)
    } catch {
      return { ok: false, code: 'target_unavailable' }
    }

    if (!profileSecuritySnapshotsEqual(approvedSnapshot, freshSnapshot)) {
      return { ok: false, code: 'target_unavailable' }
    }

    const reboundDigest = buildOpenApprovalDigest(
      {
        toolName: request.toolName,
        profileRef: request.profileRef,
        snapshot: freshSnapshot,
        operation: request.operation,
        leaseEpoch: request.leaseEpoch,
        requestId: request.requestId,
        deadlineMonotonicMs: request.deadlineMonotonicMs,
      },
      this.runKey,
    )

    if (reboundDigest !== approvalDigest) {
      return { ok: false, code: 'target_unavailable' }
    }

    if (!await this.auditCritical('open_authorized', request.requestId)) return { ok: false, code: 'audit_unavailable' }
    const checked = this.checkCurrent(request, approvedSnapshot, options.enforceDeadline, request.authorizationRevision, undefined, !options.enforceDeadline)
    if (!checked.ok) return checked

    try {
      const opened = await this.openDedicatedTab(checked.profile)
      if (opened === null) {
        return { ok: false, code: 'target_unavailable' }
      }
      if (!this.connectionCurrent(request.connection) || request.signal?.aborted || this.leaseEpochSource() !== request.leaseEpoch || (request.authorizationRevision !== undefined && this.memory?.revision?.() !== request.authorizationRevision)) {
        await this.closeOwnedTab(opened)
        return { ok: false, code: 'outcome_unknown' }
      }
      if (options.rememberAfterOpen) {
        await this.rememberApprovedOpen(freshProfile, request.connection)
      }
      return { ok: true, status: 'opened' }
    } catch {
      return { ok: false, code: 'target_unavailable' }
    }
  }

  async runAuthorizedSshCommand(request: SshCommandRequest): Promise<SshCommandResult> {
    const revision = this.memory?.revision?.()
    if (request.signal?.aborted) {
      return { ok: false, code: 'cancelled' }
    }
    if (!isValidOpenRequestId(request.requestId) || !isValidLeaseEpoch(request.leaseEpoch)) {
      return { ok: false, code: 'not_approved' }
    }
    const activeLeaseEpoch = this.leaseEpochSource()
    if (activeLeaseEpoch === null || request.leaseEpoch !== activeLeaseEpoch) {
      return { ok: false, code: 'not_approved' }
    }
    if (this.seenRequestIds.has(request.requestId)) {
      return { ok: false, code: 'not_approved' }
    }
    const authorized = authorizeSingleSshCommand({
      command: request.command,
      grantedTier: 'full',
      grantFresh: true,
    })
    if (!authorized.ok && authorized.reason === 'not_a_single_command') {
      return { ok: false, code: 'not_approved' }
    }
    if (this.presentationInFlight) {
      return { ok: false, code: 'busy' }
    }

    this.presentationInFlight = true
    this.rememberRequestId(request.requestId)
    try {
      let profile
      try {
        await this.authorizedProfiles.listAuthorizedProfiles()
        profile = await this.authorizedProfiles.resolveAuthorizedProfile(request.profileRef)
      } catch {
        return { ok: false, code: 'target_unavailable' }
      }
      if (typeof profile.id !== 'string') {
        return { ok: false, code: 'target_unavailable' }
      }
      let digest: string
      let approvedSnapshot: ProfileSecuritySnapshot
      try {
        digest = stableProfileDigest(profile)
        approvedSnapshot = buildProfileSecuritySnapshot(profile, this.runKey)
      } catch {
        return { ok: false, code: 'target_unavailable' }
      }
      const grant = this.memory
        ? this.memory.effectiveGrant(profile.id, digest)
        : { openSession: false, operationTier: 'none' as const }
      const decision = authorizeSingleSshCommand({
        command: request.command,
        grantedTier: grant.operationTier,
        grantFresh: true,
      })
      if (!decision.ok) {
        return { ok: false, code: 'not_approved' }
      }
      if (request.signal?.aborted) {
        return { ok: false, code: 'cancelled' }
      }
      if (this.clock.now() >= request.deadlineMonotonicMs) {
        return { ok: false, code: 'expired' }
      }

        const rememberedOpen = this.profileHasRememberedOpen(profile, request.connection)
        if (!rememberedOpen) {
          const toolName = 'run_authorized_ssh_command'
          const approval = await this.presentConnectionApproval(request, profile.name, toolName,
            { method: toolName, params: { profile_ref: request.profileRef, command: request.command } }, request.connection?.client.name ?? 'Local client')
          if (approval !== 'allow') return { ok: false, code: 'not_approved' }
        }

      if (!await this.auditCritical('command_requested', request.requestId)) return { ok: false, code: 'audit_unavailable' }
        const beforeOpen = this.checkCurrent(request, approvedSnapshot, true, revision, request.command, rememberedOpen)
      if (!beforeOpen.ok) return beforeOpen
      let opened: unknown
      try {
        opened = await this.openDedicatedTab(beforeOpen.profile)
      } catch {
        return { ok: false, code: 'target_unavailable' }
      }
      if (!isSingleCommandTab(opened)) {
        if (opened) await this.closeOwnedTab(opened)
        return { ok: false, code: 'target_unavailable' }
      }

      let freshProfile
      try {
        freshProfile = await this.authorizedProfiles.resolveAuthorizedProfile(request.profileRef)
        const freshSnapshot = buildProfileSecuritySnapshot(freshProfile, this.runKey)
        if (!profileSecuritySnapshotsEqual(approvedSnapshot, freshSnapshot)) {
            await this.closeOwnedTab(opened)
          return { ok: false, code: 'target_unavailable' }
        }
      } catch {
          await this.closeOwnedTab(opened)
        return { ok: false, code: 'target_unavailable' }
      }

        const nonceBytes = new Uint8Array(16)
      crypto.getRandomValues(nonceBytes)
      const markerNonce = Array.from(nonceBytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
      const ran = await runSingleSshCommand({
        tab: opened,
        command: decision.command,
        markerNonce,
        signal: request.signal,
        deadlineMonotonicMs: request.deadlineMonotonicMs,
        clock: this.clock,
        scheduler: this.scheduler,
          beforeSend: async () => {
            if (!await this.auditCritical('command_authorized', request.requestId)) return 'audit_unavailable'
              const checked = this.checkCurrent(request, approvedSnapshot, true, revision, request.command, rememberedOpen)
            if (checked.ok) return undefined
            return checked.code === 'target_unavailable' ? 'target_unavailable' : 'not_approved'
          },
            validateBeforeSend: () => this.checkCurrent(request, approvedSnapshot, true, revision, request.command, rememberedOpen).ok,
      })
      if (!ran.ok) {
          await this.closeOwnedTab(opened)
        return {
          ok: false,
            code: ran.started ? 'outcome_unknown' : ran.reason === 'not_ready' ? 'target_unavailable' : ran.reason,
        }
      }
        if (!rememberedOpen && this.connectionCurrent(request.connection) && (revision === undefined || revision === this.memory?.revision?.())) {
          await this.rememberApprovedOpen(profile, request.connection)
        }
        return {
        ok: true,
        commandClass: decision.commandClass,
        output: ran.output,
        truncated: ran.truncated,
      }
    } finally {
      this.presentationInFlight = false
    }
  }

  private async auditCritical(event: AuditEventInput['event'], requestId: string): Promise<boolean> {
    if (!this.effects) return false
    try { await this.effects.audit.append({ event, result: 'ok', requestId }); return true } catch { return false }
  }

  private presentConnectionApproval(
    request: Pick<SshCommandRequest, 'deadlineMonotonicMs' | 'signal'>,
    displayName: string, toolName: string, operation: unknown, clientIdentity: string,
  ) {
    return presentWithApprovalDeadline({
      clock: this.clock, scheduler: this.scheduler,
      deadlineMonotonicMs: Math.min(request.deadlineMonotonicMs, this.clock.now() + APPROVAL_WINDOW_MS),
      userSignal: request.signal,
      present: context => this.presenter.presentOpen(buildOpenApprovalViewModel({
        clientIdentity, toolName, targetDisplayName: displayName, operation,
        remainingSeconds: context.remainingSeconds(),
      }), context),
    })
  }

  private connectionCurrent(connection?: ClientConnectionContext): boolean {
    try { return !connection || (connection.isCurrent() && connection.permissions.connectionRevision(connection.client) === connection.revision) }
    catch { return false }
  }

  private async openDedicatedTab(profile: PartialProfile<Profile>) {
    const nativeProfile = JSON.parse(JSON.stringify(profile))
    // Tabby's multiplexer key omits authentication options; never inherit an older authenticated transport.
    nativeProfile.options = { ...nativeProfile.options, reuseSession: false }
    return this.profilesService.openNewTabForProfile(nativeProfile)
  }

  private async closeOwnedTab(tab: unknown): Promise<void> {
    try { await this.effects?.closeTab(tab) } catch { /* Never reuse this request's tab after cleanup failure. */ }
  }

  private checkCurrent(
    request: Pick<SshCommandRequest, 'signal' | 'leaseEpoch' | 'profileRef' | 'deadlineMonotonicMs' | 'connection'>,
    snapshot: ProfileSecuritySnapshot,
    enforceDeadline: boolean,
    revision?: number,
    command?: string,
    remembered = false,
  ): { ok: true; profile: PartialProfile<Profile> } | { ok: false; code: ApprovalErrorCode } {
    if (request.signal?.aborted) return { ok: false, code: 'cancelled' }
    if (!this.connectionCurrent(request.connection)) return { ok: false, code: 'not_approved' }
    if (this.leaseEpochSource() !== request.leaseEpoch || (enforceDeadline && this.clock.now() >= request.deadlineMonotonicMs) || (revision !== undefined && this.memory?.revision?.() !== revision)) return { ok: false, code: 'not_approved' }
    try {
      const profile = this.authorizedProfiles.resolveAuthorizedProfileNow(request.profileRef)
      if (!profileSecuritySnapshotsEqual(snapshot, buildProfileSecuritySnapshot(profile, this.runKey))) return { ok: false, code: 'target_unavailable' }
      const grant = this.memory?.effectiveGrant(profile.id!, stableProfileDigest(profile))
      if (command && !authorizeSingleSshCommand({ command, grantedTier: grant?.operationTier ?? 'none', grantFresh: true }).ok) return { ok: false, code: 'not_approved' }
      if (remembered && !this.profileHasRememberedOpen(profile, request.connection)) return { ok: false, code: 'not_approved' }
      return { ok: true, profile }
    } catch { return { ok: false, code: 'target_unavailable' } }
  }

  private async peekRememberedOpen(profileRef: string, connection?: ClientConnectionContext): Promise<boolean> {
    if (!connection && !this.memory) {
      return false
    }
    try {
      const profile = await this.authorizedProfiles.resolveAuthorizedProfile(profileRef)
      return this.profileHasRememberedOpen(profile, connection)
    } catch {
      return false
    }
  }

  private profileHasRememberedOpen(profile: PartialProfile<Profile>, connection?: ClientConnectionContext): boolean {
    if (!connection || !this.connectionCurrent(connection) || typeof profile.id !== 'string') {
      return false
    }
    try {
      return connection.permissions.hasConnectionPermission(connection.client, profile.id, stableProfileDigest(profile))
    } catch {
      return false
    }
  }

  private async rememberApprovedOpen(profile: PartialProfile<Profile>, connection?: ClientConnectionContext): Promise<void> {
    if (!connection || !this.connectionCurrent(connection) || typeof profile.id !== 'string') {
      return
    }
    try {
      await connection.permissions.setConnectionPermission(connection.client, profile.id, stableProfileDigest(profile), connection.revision)
      connection.revision = connection.permissions.connectionRevision(connection.client)
    } catch {
      // The SSH tab is already open. A config write failure must not hide that success.
    }
  }

  private rememberRequestId(requestId: string): void {
    if (this.seenRequestIds.has(requestId)) {
      return
    }
    this.seenRequestIds.add(requestId)
    this.seenRequestQueue.push(requestId)
    while (this.seenRequestQueue.length > MAX_SEEN_REQUEST_IDS) {
      const evicted = this.seenRequestQueue.shift()
      if (evicted) {
        this.seenRequestIds.delete(evicted)
      }
    }
  }
}
