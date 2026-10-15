import { Injectable } from '@angular/core'
import type { ProfilesService } from 'tabby-core'

import { buildOpenApprovalDigest } from './approval-digest'
import {
  type ApprovalDecision,
  type ApprovalPresenter,
  buildOpenApprovalViewModel,
  buildPairingApprovalViewModel,
} from './approval-presenter'
import type { MonotonicClock } from './monotonic-clock'
import {
  buildProfileSecuritySnapshot,
  profileSecuritySnapshotsEqual,
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

export type OpenAuthorizedOperation = {
  method: 'open_authorized_ssh_profile'
  params: {
    profile_ref: string
  }
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
      const decision = await this.presentWithDeadline(
        context =>
          this.presenter.presentPairing(
            buildPairingApprovalViewModel({
              clientIdentity: request.clientIdentity,
              companionLabel: request.companionLabel,
              remainingSeconds: context.remainingSeconds(),
            }),
            context,
          ),
        deadlineMonotonicMs,
        request.signal,
      )
      if (decision !== 'allow') {
        return { ok: false, code: 'not_approved' }
      }
      return { ok: true, approved: true }
    } finally {
      this.presentationInFlight = false
    }
  }

  async requestOpen(request: OpenApprovalRequest): Promise<OpenApprovalResult> {
    if (this.seenRequestIds.has(request.requestId)) {
      return { ok: false, code: 'not_approved' }
    }
    this.rememberRequestId(request.requestId)

    if (request.signal?.aborted) {
      return { ok: false, code: 'cancelled' }
    }

    const activeLeaseEpoch = this.leaseEpochSource()
    if (activeLeaseEpoch === null || request.leaseEpoch !== activeLeaseEpoch) {
      return { ok: false, code: 'not_approved' }
    }

    if (this.clock.now() >= request.deadlineMonotonicMs) {
      return { ok: false, code: 'not_approved' }
    }

    if (request.operation.params.profile_ref !== request.profileRef) {
      return { ok: false, code: 'not_approved' }
    }

    if (this.presentationInFlight) {
      return { ok: false, code: 'busy' }
    }

    this.presentationInFlight = true
    try {
      return await this.executeOpenAfterApproval(request)
    } finally {
      this.presentationInFlight = false
    }
  }

  private async executeOpenAfterApproval(request: OpenApprovalRequest): Promise<OpenApprovalResult> {
    let approvedSnapshot: ProfileSecuritySnapshot
    let displayName: string

    try {
      const profile = await this.authorizedProfiles.resolveAuthorizedProfile(request.profileRef)
      approvedSnapshot = buildProfileSecuritySnapshot(profile, this.runKey)
      const listed = await this.authorizedProfiles.listAuthorizedProfiles()
      displayName = listed.find(entry => entry.profile_ref === request.profileRef)?.display_name ?? profile.name
    } catch {
      return { ok: false, code: 'target_unavailable' }
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

    const decision = await this.presentWithDeadline(
      context =>
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
      request.deadlineMonotonicMs,
      request.signal,
    )

    if (request.signal?.aborted) {
      return { ok: false, code: 'cancelled' }
    }

    if (decision !== 'allow') {
      return { ok: false, code: 'not_approved' }
    }

    return this.consumeApprovalAndOpen(request, approvedSnapshot, approvalDigest)
  }

  private async consumeApprovalAndOpen(
    request: OpenApprovalRequest,
    approvedSnapshot: ProfileSecuritySnapshot,
    approvalDigest: string,
  ): Promise<OpenApprovalResult> {
    if (request.signal?.aborted) {
      return { ok: false, code: 'cancelled' }
    }

    const activeLeaseEpoch = this.leaseEpochSource()
    if (activeLeaseEpoch === null || request.leaseEpoch !== activeLeaseEpoch) {
      return { ok: false, code: 'not_approved' }
    }

    if (this.clock.now() >= request.deadlineMonotonicMs) {
      return { ok: false, code: 'not_approved' }
    }

    let freshProfile
    try {
      freshProfile = await this.authorizedProfiles.resolveAuthorizedProfile(request.profileRef)
    } catch {
      return { ok: false, code: 'target_unavailable' }
    }

    const freshSnapshot = buildProfileSecuritySnapshot(freshProfile, this.runKey)
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

    await this.profilesService.openNewTabForProfile(freshProfile)
    return { ok: true, status: 'opened' }
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

  private async presentWithDeadline(
    present: (context: {
      signal: AbortSignal
      deadlineMonotonicMs: number
      remainingSeconds: () => number
    }) => Promise<ApprovalDecision>,
    deadlineMonotonicMs: number,
    userSignal?: AbortSignal,
  ): Promise<ApprovalDecision> {
    const controller = new AbortController()
    const abortFromUser = (): void => {
      if (userSignal?.aborted) {
        controller.abort()
      }
    }
    userSignal?.addEventListener('abort', abortFromUser)
    abortFromUser()

    const context = {
      signal: controller.signal,
      deadlineMonotonicMs,
      remainingSeconds: () => Math.max(0, Math.ceil((deadlineMonotonicMs - this.clock.now()) / 1000)),
    }

    let decision: ApprovalDecision = 'deny'
    let presentationFinished = false
    const presentation = present(context)
      .then(result => {
        decision = result
        presentationFinished = true
      })
      .catch(() => {
        decision = 'deny'
        presentationFinished = true
      })

    while (this.clock.now() < deadlineMonotonicMs && !presentationFinished && !controller.signal.aborted) {
      await Promise.resolve()
    }

    if (controller.signal.aborted) {
      decision = 'deny'
    }

    if (this.clock.now() >= deadlineMonotonicMs) {
      controller.abort()
      decision = 'deny'
    }

    userSignal?.removeEventListener('abort', abortFromUser)
    await presentation.catch(() => undefined)

    return decision
  }
}
