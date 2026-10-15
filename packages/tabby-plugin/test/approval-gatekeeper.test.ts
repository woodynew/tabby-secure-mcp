import { describe, expect, it, vi } from 'vitest'
import type { PartialProfile, Profile } from 'tabby-core'

import type {
  ApprovalDecision,
  ApprovalPresentationContext,
  ApprovalPresenter,
} from '../src/approval/approval-presenter'
import { ApprovalGatekeeper, APPROVAL_WINDOW_MS } from '../src/approval/approval-gatekeeper'
import type { MonotonicClock } from '../src/approval/monotonic-clock'
import { AuthorizedProfilesService } from '../src/services/authorized-profiles.service'

const SECRET_OPTIONS = {
  host: 'secret-host.example',
  user: 'secret-user',
  password: 'hunter2',
}

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

type PresenterOutcome =
  | ApprovalDecision
  | 'timeout'
  | 'exception'
  | 'blur'

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

  async presentOpen(viewModel: unknown, context: ApprovalPresentationContext): Promise<ApprovalDecision> {
    this.openCalls.push(viewModel)
    if (this.openOutcomes[0] === 'timeout') {
      await new Promise<void>(resolve => {
        const onAbort = (): void => resolve()
        if (context.signal.aborted) {
          resolve()
          return
        }
        context.signal.addEventListener('abort', onAbort, { once: true })
      })
      return 'deny'
    }
    return this.resolveOutcome(this.openOutcomes)
  }

  private async resolveOutcome(queue: PresenterOutcome[]): Promise<ApprovalDecision> {
    const next = queue.shift()
    if (next === 'exception') {
      throw new Error('modal failure')
    }
    if (next === 'timeout' || next === 'blur') {
      return 'deny'
    }
    return next ?? 'deny'
  }
}

class FakeClock implements MonotonicClock {
  private nowMs = 0

  set(ms: number): void {
    this.nowMs = ms
  }

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
    openNewTabForProfile: vi.fn(async () => null),
    sendInput: vi.fn(),
    output$: { subscribe: vi.fn() },
    binaryOutput$: { subscribe: vi.fn() },
  }
  const authorizedProfiles = new AuthorizedProfilesService(profilesService as never, config as never)
  const presenter = new FakeApprovalPresenter()
  const clock = new FakeClock()
  let leaseEpoch = options.leaseEpoch ?? 1

  const gatekeeper = new ApprovalGatekeeper(
    authorizedProfiles,
    profilesService as never,
    presenter,
    clock,
    () => leaseEpoch,
  )

  return {
    gatekeeper,
    authorizedProfiles,
    profilesService,
    presenter,
    clock,
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
  }> = {},
) {
  return {
    requestId: overrides.requestId ?? 'req-1',
    leaseEpoch: overrides.leaseEpoch ?? 1,
    profileRef: overrides.profileRef ?? '',
    clientIdentity: 'pid:4242 companion',
    toolName: 'open_authorized_ssh_profile',
    operation: {
      method: 'open_authorized_ssh_profile' as const,
      params: { profile_ref: overrides.profileRef ?? '' },
    },
    signal: overrides.signal,
  }
}

describe('ApprovalGatekeeper', () => {
  it('expires open approval at exactly 30 seconds without opening a tab', async () => {
    const harness = createHarness()
    const profileRef = await harness.profileRef()
    harness.presenter.queueOpen('timeout')
    const deadline = harness.clock.now() + APPROVAL_WINDOW_MS

    const pending = harness.gatekeeper.requestOpen({
      ...openRequest(harness, { profileRef }),
      deadlineMonotonicMs: deadline,
    })
    harness.clock.advance(APPROVAL_WINDOW_MS)
    const result = await pending

    expect(result).toEqual({ ok: false, code: 'not_approved' })
    expect(harness.profilesService.openNewTabForProfile).not.toHaveBeenCalled()
  })

  it('opens a tab once per approved request and never replays the same request_id', async () => {
    const harness = createHarness()
    const profileRef = await harness.profileRef()
    harness.presenter.queueOpen('allow')

    const deadline = harness.clock.now() + APPROVAL_WINDOW_MS
    const first = await harness.gatekeeper.requestOpen({
      ...openRequest(harness, { requestId: 'req-1', profileRef }),
      deadlineMonotonicMs: deadline,
    })
    expect(first).toEqual({ ok: true, status: 'opened' })
    expect(harness.profilesService.openNewTabForProfile).toHaveBeenCalledTimes(1)

    harness.presenter.queueOpen('allow')
    const replay = await harness.gatekeeper.requestOpen({
      ...openRequest(harness, { requestId: 'req-1', profileRef }),
      deadlineMonotonicMs: deadline,
    })
    expect(replay).toEqual({ ok: false, code: 'not_approved' })
    expect(harness.profilesService.openNewTabForProfile).toHaveBeenCalledTimes(1)
  })

  it('denies on presenter deny, duplicate request_id, invalid lease, and cancellation', async () => {
    const harness = createHarness()
    const profileRef = await harness.profileRef()
    const deadline = harness.clock.now() + APPROVAL_WINDOW_MS
    const base = {
      ...openRequest(harness, { profileRef }),
      deadlineMonotonicMs: deadline,
    }

    harness.presenter.queueOpen('deny')
    expect(await harness.gatekeeper.requestOpen(base)).toEqual({ ok: false, code: 'not_approved' })

    harness.presenter.queueOpen('allow')
    expect(
      await harness.gatekeeper.requestOpen({
        ...base,
        requestId: 'dup',
      }),
    ).toEqual({ ok: true, status: 'opened' })
    expect(await harness.gatekeeper.requestOpen({ ...base, requestId: 'dup' })).toEqual({
      ok: false,
      code: 'not_approved',
    })

    harness.setLeaseEpoch(2)
    harness.presenter.queueOpen('allow')
    expect(await harness.gatekeeper.requestOpen({ ...base, requestId: 'bad-lease', leaseEpoch: 1 })).toEqual({
      ok: false,
      code: 'not_approved',
    })

    const controller = new AbortController()
    controller.abort()
    expect(await harness.gatekeeper.requestOpen({ ...base, requestId: 'cancelled', signal: controller.signal })).toEqual(
      { ok: false, code: 'cancelled' },
    )
  })

  it('serializes concurrent open requests through the presenter queue', async () => {
    const harness = createHarness()
    const profileRef = await harness.profileRef()
    const deadline = harness.clock.now() + APPROVAL_WINDOW_MS
    harness.presenter.queueOpen('allow')
    harness.presenter.queueOpen('deny')

    const first = harness.gatekeeper.requestOpen({
      ...openRequest(harness, { requestId: 'one', profileRef }),
      deadlineMonotonicMs: deadline,
    })
    const second = harness.gatekeeper.requestOpen({
      ...openRequest(harness, { requestId: 'two', profileRef }),
      deadlineMonotonicMs: deadline,
    })

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
      )

      const result = await gatekeeper.requestOpen({
        ...openRequest(local, { requestId: `toctou-${index}`, profileRef: ref }),
        deadlineMonotonicMs: local.clock.now() + APPROVAL_WINDOW_MS,
      })
      expect(result).toEqual({ ok: false, code: 'target_unavailable' })
      expect(local.profilesService.openNewTabForProfile).not.toHaveBeenCalled()
    }
  })

  it('binds approval to profile_ref and lease_epoch', async () => {
    const harness = createHarness()
    const profileRef = await harness.profileRef()
    const deadline = harness.clock.now() + APPROVAL_WINDOW_MS
    harness.presenter.queueOpen('allow')

    const opened = await harness.gatekeeper.requestOpen({
      ...openRequest(harness, { requestId: 'bind-1', profileRef, leaseEpoch: 1 }),
      deadlineMonotonicMs: deadline,
    })
    expect(opened).toEqual({ ok: true, status: 'opened' })

    harness.presenter.queueOpen('allow')
    const wrongRef = await harness.gatekeeper.requestOpen({
      ...openRequest(harness, { requestId: 'bind-2', profileRef: '00000000000000000000000000000000', leaseEpoch: 1 }),
      deadlineMonotonicMs: deadline,
    })
    expect(wrongRef).toEqual({ ok: false, code: 'target_unavailable' })
  })

  it('denies when the presenter throws and on AbortSignal while a modal is active', async () => {
    const harness = createHarness()
    const profileRef = await harness.profileRef()
    const deadline = harness.clock.now() + APPROVAL_WINDOW_MS

    harness.presenter.queueOpen('exception')
    expect(
      await harness.gatekeeper.requestOpen({
        ...openRequest(harness, { requestId: 'modal-ex', profileRef }),
        deadlineMonotonicMs: deadline,
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
    )
    const pending = gatekeeper.requestOpen({
      ...openRequest(harness, { requestId: 'abort-mid', profileRef, signal: controller.signal }),
      deadlineMonotonicMs: deadline,
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

  it('passes sanitized structured operation details to the open presenter', async () => {
    const harness = createHarness()
    const profileRef = await harness.profileRef()
    harness.presenter.queueOpen('deny')

    await harness.gatekeeper.requestOpen({
      ...openRequest(harness, { requestId: 'sanitize', profileRef }),
      deadlineMonotonicMs: harness.clock.now() + APPROVAL_WINDOW_MS,
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
})
