import { describe, expect, it, vi } from 'vitest'
import { ApprovalGatekeeper } from '../src/approval/approval-gatekeeper'
import { AuthorizedProfilesService } from '../src/services/authorized-profiles.service'
import { PermanentAuthorizationStore } from '../src/authorization/permanent-authorization-store'
import { runSingleSshCommand } from '../src/ssh/ssh-command-runner'

function fixture() {
  const profile = { id: 'p', name: 'test', type: 'ssh', options: { host: 'test.invalid' }, isBuiltin: false, isTemplate: false }
  const config = { store: { profiles: [profile], secureMcp: { authorizedSshProfileIds: ['p'], permanentAuthorizations: [] as any[] } }, save: async () => {} }
  const sent: string[] = []
  let output!: (chunk: string) => void
  let ready!: () => void
  const tab = { session: { open: true },
    frontendReady$: { subscribe(observer: any) { ready = observer.next; return { unsubscribe() {} } } },
    output$: { subscribe(observer: any) { output = observer.next; return { unsubscribe() {} } } },
    sendInput(data: string) {
      sent.push(data)
      const parts = data.match(/'([0-9a-f]+)' '([0-9a-f]+)'\r$/)
      if (parts) output(`\u001e${parts[1]}${parts[2]}:start\u001ffiles\n\u001e${parts[1]}${parts[2]}:end\u001f`)
      const legacy = data.match(/'(__tabby_secure_mcp_[0-9a-f]+__)'/)
      if (legacy) output(legacy[1])
    },
  }
  const profiles = { getProfiles: async () => structuredClone(config.store.profiles), getConfigProxyForProfile: (p: any) => p, openNewTabForProfile: vi.fn(async () => tab) }
  const authorized = new AuthorizedProfilesService(profiles as never, config as never)
  const memory = new PermanentAuthorizationStore(config as never)
  const audit = { append: vi.fn(async () => {}) }
  const closeTab = vi.fn(async () => {})
  const controller = new AbortController()
  const gate = new ApprovalGatekeeper(authorized, profiles as never, { presentOpen: async () => 'allow', presentPairing: async () => 'allow' }, { now: () => 0 }, () => 1, { schedule: () => () => {} }, memory, { audit, closeTab } as any)
  return { config, profile, tab, profiles, authorized, memory, audit, closeTab, controller, gate, sent, ready: () => ready() }
}

async function request(f: ReturnType<typeof fixture>) {
  const [entry] = await f.authorized.listAuthorizedProfiles()
  return { requestId: 'a'.repeat(32), leaseEpoch: 1, profileRef: entry.profile_ref, deadlineMonotonicMs: 45000, signal: f.controller.signal }
}

describe('execution security regressions', () => {
  it('does not reuse a transport authenticated with older credentials', async () => {
    const f = fixture()
    ;(f.profile.options as any).reuseSession = true
    const req = await request(f)
    const result = await f.gate.requestOpen({ ...req, clientIdentity: 'test', toolName: 'open_authorized_ssh_profile', operation: { method: 'open_authorized_ssh_profile', params: { profile_ref: req.profileRef } } })
    expect(result.ok).toBe(true)
    expect((f.profiles.openNewTabForProfile.mock.calls[0][0] as any).options.reuseSession).toBe(false)
    expect((f.config.store.profiles[0].options as any).reuseSession).toBe(true)
  })
  it('passes a writable copy to Tabby without changing the approved snapshot', async () => {
    const f = fixture()
    const req = await request(f)
    f.profiles.openNewTabForProfile.mockImplementation(async (profile: any) => { profile.normalizedByTabby = true; return f.tab })
    const result = await f.gate.requestOpen({ ...req, clientIdentity: 'test', toolName: 'open_authorized_ssh_profile', operation: { method: 'open_authorized_ssh_profile', params: { profile_ref: req.profileRef } } })
    expect(result).toEqual({ ok: true, status: 'opened' })
    expect(f.config.store.profiles[0]).not.toHaveProperty('normalizedByTabby')
  })
  it('does not open when the final profile read completes after cancellation', async () => {
    const f = fixture()
    const req = await request(f)
    let reads = 0
    const resolve = f.authorized.resolveAuthorizedProfile.bind(f.authorized)
    f.authorized.resolveAuthorizedProfile = async ref => { const p = await resolve(ref); if (++reads === 3) f.controller.abort(); return p }
    await f.gate.requestOpen({ ...req, clientIdentity: 'test', toolName: 'open_authorized_ssh_profile', operation: { method: 'open_authorized_ssh_profile', params: { profile_ref: req.profileRef } } })
    expect(f.profiles.openNewTabForProfile).not.toHaveBeenCalled()
  })

  it('refuses an open when critical audit persistence fails', async () => {
    const f = fixture()
    const req = await request(f)
    f.audit.append.mockRejectedValue(new Error('ENOSPC'))
    const result = await f.gate.requestOpen({ ...req, clientIdentity: 'test', toolName: 'open_authorized_ssh_profile', operation: { method: 'open_authorized_ssh_profile', params: { profile_ref: req.profileRef } } })
    expect(result).toEqual({ ok: false, code: 'audit_unavailable' })
    expect(f.profiles.openNewTabForProfile).not.toHaveBeenCalled()
  })

  it('does not send after authorization is revoked while the new session connects', async () => {
    const f = fixture()
    const req = await request(f)
    await f.memory.setManagedGrant('p', f.profile, { openSession: true, operationTier: 'readonly' })
    f.tab.session.open = false
    const running = f.gate.runAuthorizedSshCommand({ ...req, command: 'ls' })
    await vi.waitFor(() => expect(f.profiles.openNewTabForProfile).toHaveBeenCalled())
    await f.memory.setManagedGrant('p', f.profile, { openSession: false, operationTier: 'none' })
    f.tab.session.open = true
    f.ready()
    const result = await running
    expect(result.ok).toBe(false)
    expect(f.sent).toEqual([])
    expect(f.closeTab).toHaveBeenCalledWith(f.tab)
  })

  it('does not mistake input echo for a completion record', async () => {
    let emit!: (chunk: string) => void
    let sent = false
    let finished = false
    const clock = { now: () => 0 }
    const scheduler = { schedule: () => () => {} }
    const tab = { session: { open: true }, frontendReady$: { subscribe: () => ({ unsubscribe() {} }) },
      output$: { subscribe(observer: any) { emit = observer.next; return { unsubscribe() {} } } },
      sendInput(data: string) { sent = true; emit(data) },
    }
    const promise = runSingleSshCommand({ tab, command: "command -p 'ls' '--'", markerNonce: 'abcdef12', deadlineMonotonicMs: 45000, clock, scheduler })
    void promise.then(() => { finished = true })
    await vi.waitFor(() => expect(sent).toBe(true))
    await Promise.resolve()
    expect(finished).toBe(false)
    emit('\u001eabcdef12:start\u001ffiles\n\u001eabcd')
    emit('ef12:end\u001f')
    expect(await promise).toMatchObject({ ok: true, truncated: false })
  })
})
