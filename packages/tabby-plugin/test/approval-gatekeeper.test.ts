import { describe, expect, it, vi } from 'vitest'
import type { PartialProfile, Profile } from 'tabby-core'

import type {
  ApprovalDecision,
  ApprovalPresentationContext,
  ApprovalPresenter,
} from '../src/approval/approval-presenter'
import { ApprovalGatekeeper, APPROVAL_WINDOW_MS } from '../src/approval/approval-gatekeeper'
import { FakeApprovalScheduler } from '../src/approval/approval-scheduler'
import type { MonotonicClock } from '../src/approval/monotonic-clock'
import { stableProfileDigest } from '../src/approval/profile-security-snapshot'
import type { AuthorizationMemory, EffectiveGrant } from '../src/authorization/permanent-authorization-store'
import { AuthorizedProfilesService } from '../src/services/authorized-profiles.service'

const SECRET_OPTIONS = {
  host: 'secret-host.example',
  user: 'secret-user',
  password: 'hunter2',
}

const REQUEST_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const REQUEST_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const REQUEST_C = 'cccccccccccccccccccccccccccccccc'

function sshProfile(overrides: Partial<PartialProfile<Profile>> = {}): PartialProfile<Profile> {
  return {
    id: 'allowed',
    type: 'ssh',
    name: 'Allowed SSH',
    options: { ...SECRET_OPTIONS },
    isBuiltin: false,
    isTemplate: false,
    ...overrides,
  }
}

type PresenterOutcome = ApprovalDecision | 'exception'

class FakeApprovalPresenter implements ApprovalPresenter {
  readonly openCalls: unknown[] = []
  readonly pairingCalls: unknown[] = []
  private readonly openOutcomes: PresenterOutcome[] = []
  private readonly pairingOutcomes: PresenterOutcome[] = []

  queueOpen(outcome: PresenterOutcome): void {
    this.openOutcomes.push(outcome)
  }

  queuePairing(outcome: PresenterOutcome): void {
    this.pairingOutcomes.push(outcome)
  }

  async presentPairing(viewModel: unknown, _context: ApprovalPresentationContext): Promise<ApprovalDecision> {
    this.pairingCalls.push(viewModel)
    return this.resolveOutcome(this.pairingOutcomes)
  }

  async presentOpen(viewModel: unknown, _context: ApprovalPresentationContext): Promise<ApprovalDecision> {
    this.openCalls.push(viewModel)
    return this.resolveOutcome(this.openOutcomes)
  }

  private async resolveOutcome(queue: PresenterOutcome[]): Promise<ApprovalDecision> {
    const next = queue.shift()
    if (next === 'exception') {
      throw new Error('modal failure')
    }
    return next ?? 'deny'
  }
}

class FakeClock implements MonotonicClock {
  private nowMs = 0

  advance(ms: number): void {
    this.nowMs += ms
  }

  now(): number {
    return this.nowMs
  }
}

function createHarness(options: {
  profiles?: PartialProfile<Profile>[]
  whitelist?: string[]
  leaseEpoch?: number | null
} = {}) {
  const profiles = (options.profiles ?? [sshProfile()]).map(p => ({
    ...p,
    options: { ...SECRET_OPTIONS, ...(p.options ?? {}) },
  }))
  let currentProfiles = profiles.map(p => ({ ...p, options: { ...p.options } }))
  const config = {
    store: { secureMcp: { authorizedSshProfileIds: [...(options.whitelist ?? ['allowed'])] } },
    save: vi.fn(async () => undefined),
  }
  const profilesService = {
    getProfiles: vi.fn(async () => currentProfiles.map(p => ({ ...p, options: { ...p.options } }))),
    openNewTabForProfile: vi.fn(async () => ({})),
    sendInput: vi.fn(),
    output$: { subscribe: vi.fn() },
    binaryOutput$: { subscribe: vi.fn() },
  }
  const authorizedProfiles = new AuthorizedProfilesService(profilesService as never, config as never)
  const presenter = new FakeApprovalPresenter()
  const clock = new FakeClock()
  const scheduler = new FakeApprovalScheduler(() => clock.now())
  let leaseEpoch = options.leaseEpoch ?? 1

  const gatekeeper = new ApprovalGatekeeper(
    authorizedProfiles,
    profilesService as never,
    presenter,
    clock,
    () => leaseEpoch,
    scheduler,
  )

  const advance = (ms: number): void => {
    clock.advance(ms)
    scheduler.flush()
  }

  return {
    gatekeeper,
    authorizedProfiles,
    profilesService,
    presenter,
    clock,
    scheduler,
    advance,
    config,
    setProfiles(next: PartialProfile<Profile>[]) {
      currentProfiles = next.map(p => ({ ...p, options: { ...SECRET_OPTIONS, ...(p.options ?? {}) } }))
    },
    setWhitelist(ids: string[]) {
      config.store.secureMcp.authorizedSshProfileIds = [...ids]
    },
    setLeaseEpoch(epoch: number | null) {
      leaseEpoch = epoch
    },
    getLeaseEpoch(): number | null {
      return leaseEpoch
    },
    async profileRef(): Promise<string> {
      const listed = await authorizedProfiles.listAuthorizedProfiles()
      return listed[0]!.profile_ref
    },
  }
}

function openRequest(
  harness: ReturnType<typeof createHarness>,
  overrides: Partial<{
    requestId: string
    leaseEpoch: number
    profileRef: string
    signal: AbortSignal
    deadlineMonotonicMs: number
  }> = {},
) {
  const profileRef = overrides.profileRef ?? ''
  return {
    requestId: overrides.requestId ?? REQUEST_A,
    leaseEpoch: overrides.leaseEpoch ?? 1,
    profileRef,
    clientIdentity: 'pid:4242 companion',
    toolName: 'open_authorized_ssh_profile',
    operation: {
      method: 'open_authorized_ssh_profile' as const,
      params: { profile_ref: profileRef },
    },
    deadlineMonotonicMs: overrides.deadlineMonotonicMs ?? harness.clock.now() + APPROVAL_WINDOW_MS,
    signal: overrides.signal,
  }
}

describe('ApprovalGatekeeper', () => {
  it('expires open approval at exactly 30 seconds without opening a tab', async () => {
    const harness = createHarness()
    const profileRef = await harness.profileRef()
    const hungPresenter: ApprovalPresenter = {
      presentPairing: async () => 'deny',
      presentOpen: () => new Promise(() => undefined),
    }
    const gatekeeper = new ApprovalGatekeeper(
      harness.authorizedProfiles,
      harness.profilesService as never,
      hungPresenter,
      harness.clock,
      () => 1,
      harness.scheduler,
    )

    const pending = gatekeeper.requestOpen(openRequest(harness, { profileRef, requestId: REQUEST_A }))
    harness.advance(APPROVAL_WINDOW_MS)
    const result = await pending

    expect(result).toEqual({ ok: false, code: 'not_approved' })
    expect(harness.profilesService.openNewTabForProfile).not.toHaveBeenCalled()
  })

  it('caps caller deadlines to receivedAt + 30_000ms', async () => {
    const harness = createHarness()
    const profileRef = await harness.profileRef()
    const hungPresenter: ApprovalPresenter = {
      presentPairing: async () => 'deny',
      presentOpen: () => new Promise(() => undefined),
    }
    const gatekeeper = new ApprovalGatekeeper(
      harness.authorizedProfiles,
      harness.profilesService as never,
      hungPresenter,
      harness.clock,
      () => 1,
      harness.scheduler,
    )

    const pending = gatekeeper.requestOpen(
      openRequest(harness, {
        profileRef,
        requestId: REQUEST_B,
        deadlineMonotonicMs: harness.clock.now() + 60_000,
      }),
    )
    harness.advance(APPROVAL_WINDOW_MS)
    const result = await pending
    expect(result).toEqual({ ok: false, code: 'not_approved' })
    expect(harness.profilesService.openNewTabForProfile).not.toHaveBeenCalled()
  })

  it('opens a tab once per approved request and never replays the same request_id', async () => {
    const harness = createHarness()
    const profileRef = await harness.profileRef()
    harness.presenter.queueOpen('allow')

    const first = await harness.gatekeeper.requestOpen(
      openRequest(harness, { requestId: REQUEST_A, profileRef }),
    )
    expect(first).toEqual({ ok: true, status: 'opened' })
    expect(harness.profilesService.openNewTabForProfile).toHaveBeenCalledTimes(1)

    harness.presenter.queueOpen('allow')
    const replay = await harness.gatekeeper.requestOpen(
      openRequest(harness, { requestId: REQUEST_A, profileRef }),
    )
    expect(replay).toEqual({ ok: false, code: 'not_approved' })
    expect(harness.profilesService.openNewTabForProfile).toHaveBeenCalledTimes(1)
  })

  it('allows busy retries with the same request_id before admission', async () => {
    const harness = createHarness()
    const profileRef = await harness.profileRef()
    harness.presenter.queueOpen('allow')

    const first = harness.gatekeeper.requestOpen(openRequest(harness, { requestId: REQUEST_A, profileRef }))
    const busy = await harness.gatekeeper.requestOpen(openRequest(harness, { requestId: REQUEST_B, profileRef }))
    expect(busy).toEqual({ ok: false, code: 'busy' })

    const retryWhileBusy = await harness.gatekeeper.requestOpen(
      openRequest(harness, { requestId: REQUEST_B, profileRef }),
    )
    expect(retryWhileBusy).toEqual({ ok: false, code: 'busy' })

    expect(await first).toEqual({ ok: true, status: 'opened' })

    harness.presenter.queueOpen('allow')
    const retryAfterAdmission = await harness.gatekeeper.requestOpen(
      openRequest(harness, { requestId: REQUEST_B, profileRef }),
    )
    expect(retryAfterAdmission).toEqual({ ok: true, status: 'opened' })
    expect(harness.profilesService.openNewTabForProfile).toHaveBeenCalledTimes(2)
  })

  it('denies on presenter deny, duplicate request_id, invalid lease, invalid request id, and cancellation', async () => {
    const harness = createHarness()
    const profileRef = await harness.profileRef()
    const base = openRequest(harness, { profileRef })

    harness.presenter.queueOpen('deny')
    expect(await harness.gatekeeper.requestOpen(base)).toEqual({ ok: false, code: 'not_approved' })

    harness.presenter.queueOpen('allow')
    expect(
      await harness.gatekeeper.requestOpen({
        ...base,
        requestId: REQUEST_C,
      }),
    ).toEqual({ ok: true, status: 'opened' })
    expect(await harness.gatekeeper.requestOpen({ ...base, requestId: REQUEST_C })).toEqual({
      ok: false,
      code: 'not_approved',
    })

    harness.setLeaseEpoch(2)
    harness.presenter.queueOpen('allow')
    expect(
      await harness.gatekeeper.requestOpen({
        ...base,
        requestId: 'dddddddddddddddddddddddddddddddd',
        leaseEpoch: 1,
      }),
    ).toEqual({ ok: false, code: 'not_approved' })

    expect(
      await harness.gatekeeper.requestOpen({
        ...base,
        requestId: 'not-a-valid-request-id',
      }),
    ).toEqual({ ok: false, code: 'not_approved' })

    const controller = new AbortController()
    controller.abort()
    expect(
      await harness.gatekeeper.requestOpen({
        ...base,
        requestId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        signal: controller.signal,
      }),
    ).toEqual({ ok: false, code: 'cancelled' })
  })

  it('serializes concurrent open requests through the presenter queue', async () => {
    const harness = createHarness()
    const profileRef = await harness.profileRef()
    harness.presenter.queueOpen('allow')
    harness.presenter.queueOpen('deny')

    const first = harness.gatekeeper.requestOpen(
      openRequest(harness, { requestId: REQUEST_A, profileRef }),
    )
    const second = harness.gatekeeper.requestOpen(
      openRequest(harness, { requestId: REQUEST_B, profileRef }),
    )

    const results = await Promise.all([first, second])
    expect(results[0]).toEqual({ ok: true, status: 'opened' })
    expect(results[1]).toEqual({ ok: false, code: 'busy' })
    expect(harness.presenter.openCalls).toHaveLength(1)
  })

  it('rejects TOCTOU changes after approval for whitelist, type, id, host, port, user, jump, proxy, auth, credential, host-key, and options', async () => {
    const mutations: Array<{ label: string; mutate: (h: ReturnType<typeof createHarness>) => void }> = [
      { label: 'whitelist', mutate: h => h.setWhitelist([]) },
      { label: 'type', mutate: h => h.setProfiles([sshProfile({ type: 'local' })]) },
      { label: 'id', mutate: h => h.setProfiles([sshProfile({ id: 'other-id' })]) },
      { label: 'host', mutate: h => h.setProfiles([sshProfile({ options: { ...SECRET_OPTIONS, host: 'changed.example' } })]) },
      { label: 'port', mutate: h => h.setProfiles([sshProfile({ options: { ...SECRET_OPTIONS, port: 2222 } })]) },
      { label: 'user', mutate: h => h.setProfiles([sshProfile({ options: { ...SECRET_OPTIONS, user: 'changed-user' } })]) },
      { label: 'jump', mutate: h => h.setProfiles([sshProfile({ options: { ...SECRET_OPTIONS, jumpHost: 'jump.example' } })]) },
      { label: 'proxy', mutate: h => h.setProfiles([sshProfile({ options: { ...SECRET_OPTIONS, proxyHost: 'proxy.example' } })]) },
      { label: 'auth', mutate: h => h.setProfiles([sshProfile({ options: { ...SECRET_OPTIONS, auth: 'password' } })]) },
      {
        label: 'credential',
        mutate: h =>
          h.setProfiles([
            sshProfile({ options: { ...SECRET_OPTIONS, privateKey: '-----BEGIN PRIVATE KEY-----\nchanged' } }),
          ]),
      },
      { label: 'host-key', mutate: h => h.setProfiles([sshProfile({ options: { ...SECRET_OPTIONS, hostKeyPolicy: 'accept-new' } })]) },
      { label: 'options', mutate: h => h.setProfiles([sshProfile({ options: { ...SECRET_OPTIONS, keepaliveInterval: 15 } })]) },
    ]

    for (const [index, { mutate }] of mutations.entries()) {
      const local = createHarness()
      const ref = await local.profileRef()
      const requestId = index.toString(16).padStart(32, '0')
      const deferredPresenter: ApprovalPresenter = {
        presentPairing: async () => 'deny',
        presentOpen: async () => {
          mutate(local)
          return 'allow'
        },
      }
      const gatekeeper = new ApprovalGatekeeper(
        local.authorizedProfiles,
        local.profilesService as never,
        deferredPresenter,
        local.clock,
        () => 1,
        local.scheduler,
      )

      const result = await gatekeeper.requestOpen({
        ...openRequest(local, { requestId, profileRef: ref }),
      })
      expect(result).toEqual({ ok: false, code: 'target_unavailable' })
      expect(local.profilesService.openNewTabForProfile).not.toHaveBeenCalled()
    }
  })

  it('binds approval to profile_ref and lease_epoch', async () => {
    const harness = createHarness()
    const profileRef = await harness.profileRef()
    harness.presenter.queueOpen('allow')

    const opened = await harness.gatekeeper.requestOpen({
      ...openRequest(harness, { requestId: REQUEST_A, profileRef, leaseEpoch: 1 }),
    })
    expect(opened).toEqual({ ok: true, status: 'opened' })

    harness.presenter.queueOpen('allow')
    const wrongRef = await harness.gatekeeper.requestOpen({
      ...openRequest(harness, {
        requestId: REQUEST_B,
        profileRef: '00000000000000000000000000000000',
        leaseEpoch: 1,
      }),
    })
    expect(wrongRef).toEqual({ ok: false, code: 'target_unavailable' })
  })

  it('returns target_unavailable when openNewTabForProfile returns null or throws', async () => {
    const harness = createHarness()
    const profileRef = await harness.profileRef()
    harness.presenter.queueOpen('allow')
    harness.profilesService.openNewTabForProfile.mockResolvedValueOnce(null)
    expect(
      await harness.gatekeeper.requestOpen(openRequest(harness, { requestId: REQUEST_A, profileRef })),
    ).toEqual({ ok: false, code: 'target_unavailable' })

    harness.presenter.queueOpen('allow')
    harness.profilesService.openNewTabForProfile.mockRejectedValueOnce(new Error('tab failed'))
    expect(
      await harness.gatekeeper.requestOpen(openRequest(harness, { requestId: REQUEST_B, profileRef })),
    ).toEqual({ ok: false, code: 'target_unavailable' })
    expect(harness.profilesService.openNewTabForProfile).toHaveBeenCalledTimes(2)
  })

  it('returns target_unavailable when profile snapshot canonicalization fails', async () => {
    const cyclic: Record<string, unknown> = { ...SECRET_OPTIONS }
    cyclic.loop = cyclic
    const harness = createHarness({ profiles: [sshProfile({ options: cyclic })] })
    const profileRef = await harness.profileRef()
    harness.presenter.queueOpen('allow')

    const result = await harness.gatekeeper.requestOpen(
      openRequest(harness, { requestId: REQUEST_A, profileRef }),
    )
    expect(result).toEqual({ ok: false, code: 'target_unavailable' })
    expect(harness.profilesService.openNewTabForProfile).not.toHaveBeenCalled()
  })

  it('denies when the presenter throws and on AbortSignal while a modal is active', async () => {
    const harness = createHarness()
    const profileRef = await harness.profileRef()

    harness.presenter.queueOpen('exception')
    expect(
      await harness.gatekeeper.requestOpen({
        ...openRequest(harness, { requestId: REQUEST_C, profileRef }),
      }),
    ).toEqual({ ok: false, code: 'not_approved' })

    const controller = new AbortController()
    const abortPresenter: ApprovalPresenter = {
      presentPairing: async () => 'deny',
      presentOpen: async (_viewModel, context) => {
        if (context.signal.aborted) {
          return 'deny'
        }
        await new Promise<void>(resolve => {
          context.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return context.signal.aborted ? 'deny' : 'allow'
      },
    }
    const gatekeeper = new ApprovalGatekeeper(
      harness.authorizedProfiles,
      harness.profilesService as never,
      abortPresenter,
      harness.clock,
      () => 1,
      harness.scheduler,
    )
    const pending = gatekeeper.requestOpen({
      ...openRequest(harness, {
        requestId: 'ffffffffffffffffffffffffffffffff',
        profileRef,
        signal: controller.signal,
      }),
    })
    controller.abort()
    expect(await pending).toEqual({ ok: false, code: 'cancelled' })
    expect(harness.profilesService.openNewTabForProfile).not.toHaveBeenCalled()
  })

  it('requires pairing approval showing companion identity before reporting approval', async () => {
    const harness = createHarness()
    harness.presenter.queuePairing('allow')

    const result = await harness.gatekeeper.requestPairingApproval({
      clientIdentity: 'local companion',
      companionLabel: 'pid:99123',
      signal: undefined,
    })

    expect(result).toEqual({ ok: true, approved: true })
    expect(harness.presenter.pairingCalls).toHaveLength(1)
    expect(harness.presenter.pairingCalls[0]).toMatchObject({
      clientIdentity: expect.any(String),
      companionLabel: 'pid:99123',
    })
  })

  it('expires pairing approval at exactly 30 seconds', async () => {
    const harness = createHarness()
    const hungPresenter: ApprovalPresenter = {
      presentPairing: () => new Promise(() => undefined),
      presentOpen: async () => 'deny',
    }
    const gatekeeper = new ApprovalGatekeeper(
      harness.authorizedProfiles,
      harness.profilesService as never,
      hungPresenter,
      harness.clock,
      () => 1,
      harness.scheduler,
    )

    const pending = gatekeeper.requestPairingApproval({
      clientIdentity: 'local companion',
      companionLabel: 'pid:99123',
    })
    harness.advance(APPROVAL_WINDOW_MS)
    expect(await pending).toEqual({ ok: false, code: 'not_approved' })
  })

  it('passes sanitized structured operation details to the open presenter', async () => {
    const harness = createHarness()
    const profileRef = await harness.profileRef()
    harness.presenter.queueOpen('deny')

    await harness.gatekeeper.requestOpen({
      ...openRequest(harness, { requestId: REQUEST_C, profileRef }),
    })

    const vm = harness.presenter.openCalls[0] as {
      clientIdentity: string
      operationDisplay: string
      targetDisplayName: string
    }
    expect(vm.clientIdentity).not.toMatch(/\u001b|\r|\n|\t/)
    expect(vm.operationDisplay).toContain('open_authorized_ssh_profile')
    expect(vm.operationDisplay).not.toMatch(/secret-host|secret-user|hunter2/)
    expect(vm.targetDisplayName).toBe('Allowed SSH')
  })

  it('skips the modal for a fresh permanent open grant, including an already expired deadline', async () => {
    const harness = createHarness()
    const profileRef = await harness.profileRef()
    const digest = stableProfileDigest(sshProfile())
    const memory = new FakeAuthorizationMemory()
    memory.remember('allowed', digest, { openSession: true, operationTier: 'full' })
    const gatekeeper = gatekeeperWithMemory(harness, memory)

    const opened = await gatekeeper.requestOpen(
      openRequest(harness, {
        requestId: REQUEST_A,
        profileRef,
        deadlineMonotonicMs: harness.clock.now(),
      }),
    )

    expect(opened).toEqual({ ok: true, status: 'opened' })
    expect(harness.presenter.openCalls).toEqual([])
    expect(harness.profilesService.openNewTabForProfile).toHaveBeenCalledTimes(1)
    expect(memory.rememberCalls).toEqual([])
  })

  it('still prompts when the stored open grant does not match the profile digest', async () => {
    const harness = createHarness()
    const profileRef = await harness.profileRef()
    const memory = new FakeAuthorizationMemory()
    memory.remember('allowed', 'ab'.repeat(32), { openSession: true, operationTier: 'full' })
    const gatekeeper = gatekeeperWithMemory(harness, memory)
    harness.presenter.queueOpen('deny')

    const result = await gatekeeper.requestOpen(openRequest(harness, { profileRef }))

    expect(result).toEqual({ ok: false, code: 'not_approved' })
    expect(harness.presenter.openCalls).toHaveLength(1)
    expect(harness.profilesService.openNewTabForProfile).not.toHaveBeenCalled()
  })

  it('remembers an approved open and still reports success if persistence fails', async () => {
    const harness = createHarness()
    const profileRef = await harness.profileRef()
    const memory = new FakeAuthorizationMemory()
    const gatekeeper = gatekeeperWithMemory(harness, memory)
    harness.presenter.queueOpen('allow')

    expect(
      await gatekeeper.requestOpen(openRequest(harness, { requestId: REQUEST_A, profileRef })),
    ).toEqual({ ok: true, status: 'opened' })
    expect(memory.rememberCalls).toEqual([
      { profileId: 'allowed', profileDigest: stableProfileDigest(sshProfile()) },
    ])

    const failing = new FakeAuthorizationMemory()
    failing.failRemember = true
    const failingGatekeeper = gatekeeperWithMemory(harness, failing)
    harness.presenter.queueOpen('allow')
    expect(
      await failingGatekeeper.requestOpen(openRequest(harness, { requestId: REQUEST_B, profileRef })),
    ).toEqual({ ok: true, status: 'opened' })
    expect(failing.rememberCalls).toHaveLength(1)
  })

  it('keeps abort, lease, and profile TOCTOU checks on a remembered open', async () => {
    const harness = createHarness()
    const profileRef = await harness.profileRef()
    const memory = new FakeAuthorizationMemory()
    memory.remember('allowed', stableProfileDigest(sshProfile()), {
      openSession: true,
      operationTier: 'readonly',
    })
    const gatekeeper = gatekeeperWithMemory(harness, memory)
    const controller = new AbortController()
    controller.abort()

    expect(
      await gatekeeper.requestOpen(
        openRequest(harness, { requestId: REQUEST_A, profileRef, signal: controller.signal }),
      ),
    ).toEqual({ ok: false, code: 'cancelled' })

    const calls = { count: 0 }
    const implementation = harness.profilesService.getProfiles.getMockImplementation()
    harness.profilesService.getProfiles.mockImplementation(async (...args: unknown[]) => {
      calls.count += 1
      if (calls.count === 3) {
        harness.setLeaseEpoch(null)
      }
      return implementation?.(...args)
    })
    expect(
      await gatekeeper.requestOpen(openRequest(harness, { requestId: REQUEST_B, profileRef })),
    ).toEqual({ ok: false, code: 'not_approved' })

    harness.setLeaseEpoch(1)
    calls.count = 0
    harness.profilesService.getProfiles.mockImplementation(async (...args: unknown[]) => {
      calls.count += 1
      if (calls.count === 4) {
        harness.setProfiles([
          sshProfile({ options: { ...SECRET_OPTIONS, host: 'changed.example' } }),
        ])
      }
      return implementation?.(...args)
    })
    expect(
      await gatekeeper.requestOpen(openRequest(harness, { requestId: REQUEST_C, profileRef })),
    ).toEqual({ ok: false, code: 'target_unavailable' })
    expect(harness.profilesService.openNewTabForProfile).not.toHaveBeenCalled()
    expect(harness.presenter.openCalls).toEqual([])
  })

  it('describes the effective operation tier without prompting', async () => {
    const harness = createHarness()
    const profileRef = await harness.profileRef()
    const memory = new FakeAuthorizationMemory()
    memory.remember('allowed', stableProfileDigest(sshProfile()), {
      openSession: true,
      operationTier: 'readwrite',
    })
    const gatekeeper = gatekeeperWithMemory(harness, memory)

    const described = await gatekeeper.describeOperationAuthorization(profileRef)

    expect(described).toMatchObject({
      ok: true,
      profileRef,
      openSession: true,
      operationTier: 'readwrite',
    })
    if (described.ok) {
      expect(described.policy.map(entry => entry.tier)).toEqual(['readonly', 'readwrite', 'full'])
    }
    expect(harness.presenter.openCalls).toEqual([])
    expect(
      await gatekeeper.describeOperationAuthorization('00000000000000000000000000000000'),
    ).toEqual({ ok: false, code: 'target_unavailable' })
    expect(
      await harness.gatekeeper.describeOperationAuthorization(profileRef),
    ).toMatchObject({ ok: true, openSession: false, operationTier: 'none' })
  })
})

class FakeAuthorizationMemory implements AuthorizationMemory {
  private readonly grants = new Map<string, EffectiveGrant>()
  readonly rememberCalls: Array<{ profileId: string; profileDigest: string }> = []
  failRemember = false

  remember(profileId: string, profileDigest: string, grant: EffectiveGrant): void {
    this.grants.set(`${profileId}:${profileDigest}`, grant)
  }

  effectiveGrant(profileId: string, profileDigest: string): EffectiveGrant {
    return this.grants.get(`${profileId}:${profileDigest}`) ?? { openSession: false, operationTier: 'none' }
  }

  async rememberOpen(profileId: string, profileDigest: string): Promise<void> {
    this.rememberCalls.push({ profileId, profileDigest })
    if (this.failRemember) {
      throw new Error('config save failed')
    }
    const current = this.effectiveGrant(profileId, profileDigest)
    this.remember(profileId, profileDigest, { ...current, openSession: true })
  }
}

function gatekeeperWithMemory(
  harness: ReturnType<typeof createHarness>,
  memory: AuthorizationMemory,
): ApprovalGatekeeper {
  return new ApprovalGatekeeper(
    harness.authorizedProfiles,
    harness.profilesService as never,
    harness.presenter,
    harness.clock,
    () => harness.getLeaseEpoch(),
    harness.scheduler,
    memory,
  )
}
