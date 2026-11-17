import { Injectable } from '@angular/core'
import { createHash } from 'node:crypto'
import { APPROVAL_WINDOW_MS } from '@tabby-secure-mcp/companion'
import type { ClientConnectionPermissions, ClientIdentity } from '@tabby-secure-mcp/companion'
import type { PartialProfile, Profile, ProfilesService } from 'tabby-core'

import type { AuthorizationMemory } from '../authorization/permanent-authorization-store'
import {
  publicOperationTierPolicy,
  type GrantedOperationTier,
  type SshCommandClass,
} from '../authorization/operation-tier-policy'
import { analyzeSshCommand, commandRuleMatches, type CommandRisk } from '@tabby-secure-mcp/ipc-contract/command-policy'
import { sanitizeApprovalDisplayText } from './display-sanitizer'
import { isSingleCommandTab, runSingleSshCommand } from '../ssh/ssh-command-runner'
import { presentWithApprovalDeadline } from './approval-deadline'
import { buildOpenApprovalDigest } from './approval-digest'
import {
  type ApprovalPresenter,
  buildOpenApprovalViewModel,
  buildPairingApprovalViewModel,
  buildCommandApprovalDetails,
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
import type { CommandSessionClosePolicy } from '../config/secure-mcp-config'
import type { RetainedTabMetadata, TabAcquisition, TabLease, TabTarget } from '../runtime/mcp-owned-tabs'

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
  | 'command_disabled'
  | 'unsupported_command'
  | 'approval_unavailable'

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
  onRetainedTab?(tab: unknown, metadata: RetainedTabMetadata): void
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

export type PublicOperationTierPolicy = ReturnType<typeof publicOperationTierPolicy>[number]

export type SshCommandErrorCode = ApprovalErrorCode | 'expired'

export interface SshCommandRequest {
  requestId: string
  leaseEpoch: number
  profileRef: string
  command: string
  deadlineMonotonicMs: number
  signal?: AbortSignal
  connection?: ClientConnectionContext
  onRetainedTab?(tab: unknown, metadata: RetainedTabMetadata): void
  acquireTab?(target: TabTarget): TabAcquisition
  onCreatedTab?(tab: unknown, metadata: RetainedTabMetadata): TabLease | undefined
}

export type SshCommandResult =
  | { ok: true; commandClass: SshCommandClass; commandRisk: CommandRisk; output: string; truncated: boolean }
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
    private readonly commandSessionClosePolicy: () => CommandSessionClosePolicy = () => 'keep',
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
    const checked = this.checkCurrent(request, approvedSnapshot, options.enforceDeadline, request.authorizationRevision, !options.enforceDeadline)
    if (!checked.ok) return checked

    try {
      const opened = await this.openDedicatedTab(checked.profile)
      if (opened === null) {
        return { ok: false, code: 'target_unavailable' }
      }
      const session = isSingleCommandTab(opened) ? opened.session ?? undefined : undefined
      const wasOpen = !!session?.open
      if (!this.connectionCurrent(request.connection) || request.signal?.aborted || this.leaseEpochSource() !== request.leaseEpoch || (request.authorizationRevision !== undefined && this.memory?.revision?.() !== request.authorizationRevision)) {
        await this.closeOwnedTab(opened)
        return { ok: false, code: 'outcome_unknown' }
      }
      request.onRetainedTab?.(opened, { profileId: freshProfile.id!, profileDigest: stableProfileDigest(freshProfile), session, wasOpen, reusable: true, reused: false })
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
    const permissions = request.connection?.permissions
    let commandRevision = permissions?.commandRevision?.()
    const closePolicy = this.commandSessionClosePolicy()
    if (request.signal?.aborted) return { ok: false, code: 'cancelled' }
    if (!isValidOpenRequestId(request.requestId) || !isValidLeaseEpoch(request.leaseEpoch)
      || this.leaseEpochSource() !== request.leaseEpoch || this.seenRequestIds.has(request.requestId)) {
      return { ok: false, code: 'not_approved' }
    }
    const analysis = analyzeSshCommand(request.command)
    if (!analysis) return { ok: false, code: 'unsupported_command' }
    const commandRuleId = createHash('sha256').update(JSON.stringify(analysis.rule)).digest('hex')
    if (this.presentationInFlight) return { ok: false, code: 'busy' }
    this.presentationInFlight = true
    this.rememberRequestId(request.requestId)
    let undoRemember: (() => Promise<void>) | undefined
    let succeeded = false
    let tabLease: TabLease | undefined
    let reusedTab = false
    let leaseReusable = true
    try {
      let profile: PartialProfile<Profile>
      try {
        await this.authorizedProfiles.listAuthorizedProfiles()
        profile = await this.authorizedProfiles.resolveAuthorizedProfile(request.profileRef)
      } catch { return { ok: false, code: 'target_unavailable' } }
      if (typeof profile.id !== 'string') return { ok: false, code: 'target_unavailable' }
      let digest: string
      let snapshot: ProfileSecuritySnapshot
      try {
        digest = stableProfileDigest(profile)
        snapshot = buildProfileSecuritySnapshot(profile, this.runKey)
      } catch { return { ok: false, code: 'target_unavailable' } }
      const mode = this.memory?.effectiveGrant(profile.id, digest).operationTier ?? 'none'
      if (mode !== 'ask' && mode !== 'auto_edit' && mode !== 'full') return { ok: false, code: 'command_disabled' }
      const connection = request.connection
      let rememberedOpen = this.profileHasRememberedOpen(profile, connection)
      const check = () => {
        if (tabLease && !tabLease.isCurrent()) return { ok: false as const, code: 'target_unavailable' as const }
        const current = this.checkCurrent(request, snapshot, true, revision, rememberedOpen)
        if (!current.ok) return current
        if (commandRevision !== permissions?.commandRevision?.()
          || this.memory?.effectiveGrant(profile.id!, digest).operationTier !== mode) {
          return { ok: false as const, code: 'not_approved' as const }
        }
        return current
      }
      const initial = check()
      if (!initial.ok) return initial
      const selected = request.acquireTab?.({ profileId: profile.id, profileDigest: digest })
      if (selected && !selected.ok) return selected
      tabLease = selected?.lease
      reusedTab = !!tabLease
      if (this.clock.now() >= request.deadlineMonotonicMs) return { ok: false, code: 'expired' }
      let saved
      try { saved = connection && permissions?.commandSet?.(connection.client, profile.id, digest) }
      catch { return { ok: false, code: 'approval_unavailable' } }
      const rules = saved && !saved.stale ? [...(saved.inheritDefaults ? saved.defaultRules : []), ...saved.rules] : []
      const needsCommandApproval = mode === 'ask' ? !rules.some(rule => commandRuleMatches(rule, analysis))
        : mode === 'auto_edit' && analysis.risk !== 'low'
      if (!await this.auditCritical('command_requested', request.requestId, { approvalMode: mode, commandRisk: analysis.risk, commandRuleId })) {
        return { ok: false, code: 'audit_unavailable' }
      }
      let remember = false
      if (needsCommandApproval) {
        const allowRemember = mode === 'ask' && !!connection && !!permissions?.setCommandSet
        const deadline = Math.min(request.deadlineMonotonicMs, this.clock.now() + APPROVAL_WINDOW_MS)
        const decision = await presentWithApprovalDeadline({
          clock: this.clock, scheduler: this.scheduler, deadlineMonotonicMs: deadline, userSignal: request.signal,
          present: context => this.presenter.presentCommand?.({
            ...buildOpenApprovalViewModel({
              clientIdentity: connection?.client.name ?? 'Local client', toolName: 'run_authorized_ssh_command',
              targetDisplayName: profile.name!, operation: request.command, remainingSeconds: context.remainingSeconds(),
            }),
            operationDisplay: sanitizeApprovalDisplayText(request.command),
            risk: analysis.risk, ...buildCommandApprovalDetails(analysis),
            allowRemember, approveConnection: !rememberedOpen,
          }, context) ?? Promise.resolve('deny' as const),
        })
        if (request.signal?.aborted) return { ok: false, code: 'cancelled' }
        if (this.clock.now() >= deadline) return { ok: false, code: 'expired' }
        if (decision === 'deny' || decision === 'remember' && !allowRemember) return { ok: false, code: 'not_approved' }
        remember = decision === 'remember'
      } else if (!rememberedOpen) {
        const approval = await this.presentConnectionApproval(request, profile.name!, 'run_authorized_ssh_command',
          { method: 'run_authorized_ssh_command', params: { profile_ref: request.profileRef, command: request.command } },
          connection?.client.name ?? 'Local client')
        if (approval !== 'allow') return { ok: false, code: request.signal?.aborted ? 'cancelled' : 'not_approved' }
      }
      const approved = check()
      if (!approved.ok) return approved
      if (!rememberedOpen && connection) {
        try {
          const saving = permissions!.setConnectionPermission(connection.client, profile.id, digest, connection.revision,
            () => this.checkCurrent(request, snapshot, true, revision).ok)
          // Capture only the version this call owns; a newer edit must invalidate this request.
          try { connection.revision = permissions!.connectionRevision(connection.client) }
          catch { await saving; return { ok: false, code: 'not_approved' } }
          commandRevision = permissions!.commandRevision?.()
          await saving
          rememberedOpen = true
        } catch {
          if (request.signal?.aborted) return { ok: false, code: 'cancelled' }
          const current = check()
          return current.ok ? { ok: false, code: 'approval_unavailable' } : current
        }
        const current = check()
        if (!current.ok) {
          // Cover invalidation between the persistence commit and this await continuation.
          try { await permissions!.setConnectionPermission(connection.client, profile.id, null, connection.revision) } catch {}
          return current
        }
      }
      const execute = async (): Promise<SshCommandResult> => {
        const beforeOpen = check()
        if (!beforeOpen.ok) return beforeOpen
        let opened: unknown
        try { opened = tabLease ? tabLease.tab : await this.openDedicatedTab(beforeOpen.profile) }
        catch { return { ok: false, code: 'target_unavailable' } }
        if (!isSingleCommandTab(opened)) {
          if (tabLease) leaseReusable = false
          else if (opened) await this.closeOwnedTab(opened)
          return { ok: false, code: 'target_unavailable' }
        }
        const commandTab = opened
        if (!reusedTab && request.onCreatedTab) {
          tabLease = request.onCreatedTab(opened, { profileId: profile.id!, profileDigest: digest, session: opened.session ?? undefined, wasOpen: !!opened.session?.open, reusable: true, reused: false })
          if (!tabLease || tabLease.tab !== opened || !tabLease.isCurrent()) {
            if (!tabLease) await this.closeOwnedTab(opened)
            return { ok: false, code: 'target_unavailable' }
          }
        }
        const canCleanup = () => !reusedTab && (!tabLease || tabLease.isCurrent())
        try {
          const fresh = await this.authorizedProfiles.resolveAuthorizedProfile(request.profileRef)
          if (!profileSecuritySnapshotsEqual(snapshot, buildProfileSecuritySnapshot(fresh, this.runKey))) {
            if (tabLease) leaseReusable = false
            if (canCleanup()) await this.closeOwnedTab(opened)
            return { ok: false, code: 'target_unavailable' }
          }
        } catch {
          if (tabLease) leaseReusable = false
          if (canCleanup()) await this.closeOwnedTab(opened)
          return { ok: false, code: 'target_unavailable' }
        }
        const nonce = new Uint8Array(16)
        crypto.getRandomValues(nonce)
        if (tabLease) leaseReusable = false
        let executionSession: { open?: boolean } | undefined
        const ran = await runSingleSshCommand({
          tab: opened, command: analysis.command,
          markerNonce: Array.from(nonce, byte => byte.toString(16).padStart(2, '0')).join(''),
          signal: request.signal, deadlineMonotonicMs: Math.min(request.deadlineMonotonicMs, this.clock.now() + 45_000), clock: this.clock, scheduler: this.scheduler,
          beforeSend: async () => {
            if (!await this.auditCritical('command_authorized', request.requestId, { approvalMode: mode, commandRisk: analysis.risk, commandRuleId })) return 'audit_unavailable'
            const current = check()
            if (current.ok) executionSession = commandTab.session ?? undefined
            return current.ok ? undefined : current.code === 'target_unavailable' ? 'target_unavailable' : 'not_approved'
          },
          validateBeforeSend: () => check().ok,
        })
        if (tabLease) leaseReusable = ran.ok ? ran.completionConfirmed : !ran.started
        if (!ran.ok) {
          if (canCleanup() && (!ran.started || ran.reason === 'not_approved' || ran.reason === 'audit_unavailable' || ran.reason === 'target_unavailable')) {
            await this.closeOwnedTab(opened)
          }
          return { ok: false, code: ran.started ? 'outcome_unknown' : ran.reason === 'not_ready' ? 'target_unavailable' : ran.reason }
        }
        let retained = true
        if (canCleanup() && closePolicy === 'after-completion' && ran.completionConfirmed && !request.signal?.aborted) {
          try { if (opened.destroy) { await opened.destroy(); retained = false } } catch { console.warn('[Secure MCP] Could not close the completed command session.') }
        }
        if (retained) request.onRetainedTab?.(opened, { profileId: profile.id!, profileDigest: digest, session: executionSession, wasOpen: true, reusable: ran.completionConfirmed, reused: reusedTab })
        return { ok: true, commandClass: analysis.commandClass, commandRisk: analysis.risk, output: ran.output, truncated: ran.truncated }
      }
      if (!remember || !connection || !permissions?.setCommandSet) {
        const outcome = await execute()
        succeeded = outcome.ok && !request.signal?.aborted
        return outcome
      }
      let outcome: SshCommandResult | undefined
      let attempted = false
      try {
        const previous = { inheritDefaults: saved?.inheritDefaults ?? true, rules: saved?.stale ? [] : saved?.rules ?? [] }
        const before = commandRevision
        const saving = permissions.setCommandSet(connection.client, profile.id, digest, {
          inheritDefaults: previous.inheritDefaults, rules: [...previous.rules, analysis.rule],
        }, commandRevision!, () => this.checkCurrent(request, snapshot, true, revision, rememberedOpen).ok,
        async () => {
          attempted = true
          outcome = await execute()
          if (!outcome.ok) throw new Error('Command request did not complete')
        })
        commandRevision = permissions.commandRevision?.()
        const ownedRevision = commandRevision
        if (ownedRevision !== undefined && ownedRevision !== before) {
          undoRemember = async () => {
            if (!connection.isCurrent() || permissions.commandRevision?.() !== ownedRevision) return
            await permissions.setCommandSet!(connection.client, profile.id!, digest, previous, ownedRevision)
          }
        }
        await saving
        succeeded = true
        return outcome!
      } catch {
        // The operation may already have run if finalizing its remembered approval failed.
        if (outcome) return outcome.ok ? { ok: false, code: 'outcome_unknown' } : outcome
        if (attempted) return { ok: false, code: 'outcome_unknown' }
        return { ok: false, code: request.signal?.aborted ? 'cancelled' : 'approval_unavailable' }
      }

    } finally {
      try { if (!succeeded) await undoRemember?.() }
      catch { /* The credential store keeps failed revocations denied until safely saved. */ }
      finally { tabLease?.release(leaseReusable); this.presentationInFlight = false }
    }
  }

  private async auditCritical(event: AuditEventInput['event'], requestId: string, metadata: Pick<AuditEventInput, 'approvalMode' | 'commandRisk' | 'commandRuleId'> = {}): Promise<boolean> {
    if (!this.effects) return false
    try { await this.effects.audit.append({ event, result: 'ok', requestId, ...metadata }); return true } catch { return false }
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
    remembered = false,
  ): { ok: true; profile: PartialProfile<Profile> } | { ok: false; code: ApprovalErrorCode } {
    if (request.signal?.aborted) return { ok: false, code: 'cancelled' }
    if (!this.connectionCurrent(request.connection)) return { ok: false, code: 'not_approved' }
    if (this.leaseEpochSource() !== request.leaseEpoch || (enforceDeadline && this.clock.now() >= request.deadlineMonotonicMs) || (revision !== undefined && this.memory?.revision?.() !== revision)) return { ok: false, code: 'not_approved' }
    try {
      const profile = this.authorizedProfiles.resolveAuthorizedProfileNow(request.profileRef)
      if (!profileSecuritySnapshotsEqual(snapshot, buildProfileSecuritySnapshot(profile, this.runKey))) return { ok: false, code: 'target_unavailable' }
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
