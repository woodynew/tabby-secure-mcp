import { Injectable } from '@angular/core'
import type { PartialProfile, Profile, ProfilesService } from 'tabby-core'

import type { AuthorizationMemory } from '../authorization/permanent-authorization-store'
import {
  publicOperationTierPolicy,
  type GrantedOperationTier,
  type OperationTierPolicy,
} from '../authorization/operation-tier-policy'
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

export const APPROVAL_WINDOW_MS = 30_000
const MAX_SEEN_REQUEST_IDS = 1024

export type ApprovalErrorCode =
  | 'busy'
  | 'cancelled'
  | 'not_approved'
  | 'target_unavailable'

export type { OpenAuthorizedOperation }

export interface OpenApprovalRequest {
  requestId: string
  leaseEpoch: number
  profileRef: string
  clientIdentity: string
  toolName: string
  operation: OpenAuthorizedOperation
  deadlineMonotonicMs: number
  signal?: AbortSignal
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

  constructor(
    private readonly authorizedProfiles: AuthorizedProfilesService,
    private readonly profilesService: ProfilesService,
    private readonly presenter: ApprovalPresenter,
    private readonly clock: MonotonicClock,
    private readonly leaseEpochSource: LeaseEpochSource,
    private readonly scheduler: ApprovalScheduler = new SystemApprovalScheduler(),
    private readonly memory?: AuthorizationMemory,
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
      const rememberedOpen = await this.peekRememberedOpen(request.profileRef)
      if (!rememberedOpen && receivedAt >= effectiveDeadline) {
        return { ok: false, code: 'not_approved' }
      }

      this.rememberRequestId(request.requestId)
      return await this.executeOpenAfterApproval({
        ...request,
        deadlineMonotonicMs: effectiveDeadline,
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
      rememberedOpen = this.profileHasRememberedOpen(profile)
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
      const decision = await presentWithApprovalDeadline({
        clock: this.clock,
        scheduler: this.scheduler,
        deadlineMonotonicMs: request.deadlineMonotonicMs,
        userSignal: request.signal,
        present: context =>
          this.presenter.presentOpen(
            buildOpenApprovalViewModel({
              clientIdentity: request.clientIdentity,
              toolName: request.toolName,
              targetDisplayName: displayName,
              operation: request.operation,
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
    } else if (request.signal?.aborted) {
      return { ok: false, code: 'cancelled' }
    }

    return this.consumeApprovalAndOpen(request, approvedSnapshot, approvalDigest, {
      enforceDeadline: !rememberedOpen,
      rememberAfterOpen: !rememberedOpen,
    })
  }

  async describeOperationAuthorization(profileRef: string): Promise<OperationAuthorizationDescription> {
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
        openSession: grant.openSession,
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

    try {
      const opened = await this.profilesService.openNewTabForProfile(freshProfile)
      if (opened === null) {
        return { ok: false, code: 'target_unavailable' }
      }
      if (options.rememberAfterOpen) {
        await this.rememberApprovedOpen(freshProfile)
      }
      return { ok: true, status: 'opened' }
    } catch {
      return { ok: false, code: 'target_unavailable' }
    }
  }

  private async peekRememberedOpen(profileRef: string): Promise<boolean> {
    if (!this.memory) {
      return false
    }
    try {
      const profile = await this.authorizedProfiles.resolveAuthorizedProfile(profileRef)
      return this.profileHasRememberedOpen(profile)
    } catch {
      return false
    }
  }

  private profileHasRememberedOpen(profile: PartialProfile<Profile>): boolean {
    if (!this.memory || typeof profile.id !== 'string') {
      return false
    }
    try {
      return this.memory.effectiveGrant(profile.id, stableProfileDigest(profile)).openSession
    } catch {
      return false
    }
  }

  private async rememberApprovedOpen(profile: PartialProfile<Profile>): Promise<void> {
    if (!this.memory || typeof profile.id !== 'string') {
      return
    }
    try {
      await this.memory.rememberOpen(profile.id, stableProfileDigest(profile))
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
