import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CredentialStore } from '../../companion/src/http/credentials'
import { ApprovalGatekeeper } from '../src/approval/approval-gatekeeper'
import { stableProfileDigest } from '../src/approval/profile-security-snapshot'
import { AuthorizedProfilesService } from '../src/services/authorized-profiles.service'
import { PermanentAuthorizationStore } from '../src/authorization/permanent-authorization-store'
import { McpOwnedTabs } from '../src/runtime/mcp-owned-tabs'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))) })
async function fixture() {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'plugin-client-connections-'))
  directories.push(dir)
  const permissions = new CredentialStore(path.join(dir, 'private', 'credentials.json'))
  await permissions.load()
  const a = await permissions.create('Agent'), b = await permissions.create('Agent')
  const profile = { id: 'p', name: 'SSH', type: 'ssh', options: { host: 'test.invalid' }, isBuiltin: false, isTemplate: false }
  const config = { store: { profiles: [profile], secureMcp: { authorizedSshProfileIds: ['p'], permanentAuthorizations: [] as any[] } }, save: async () => {} }
  const sent: string[] = []
  let output!: (chunk: string) => void
  let ready!: () => void
  const tab = { destroy: vi.fn(), session: { open: true },
    frontendReady$: { subscribe(observer: any) { ready = observer.next; return { unsubscribe() {} } } },
    output$: { subscribe(observer: any) { output = observer.next; return { unsubscribe() {} } } },
    sendInput(data: string) {
      sent.push(data)
      const marker = data.match(/'([0-9a-f]+)' '([0-9a-f]+)'\r$/)
      if (marker) output(`\u001e${marker[1]}${marker[2]}:start\u001ffiles\n\u001e${marker[1]}${marker[2]}:end\u001f`)
    },
  }
  const profiles = { getProfiles: async () => structuredClone(config.store.profiles), getConfigProxyForProfile: (p: any) => p, openNewTabForProfile: vi.fn(async () => tab) }
  const authorized = new AuthorizedProfilesService(profiles as never, config as never)
  const memory = new PermanentAuthorizationStore(config as never)
  const presenter = { presentOpen: vi.fn(async () => 'deny' as 'allow' | 'deny'), presentPairing: async () => 'deny' as const }
  const closeTab = vi.fn(async () => {})
  const gate = new ApprovalGatekeeper(authorized, profiles as never, presenter, { now: () => 0 }, () => 1, { schedule: () => () => {} }, memory, { audit: { append: async () => {} }, closeTab })
  const [entry] = await authorized.listAuthorizedProfiles()
  let sequence = 0
  const request = (client = a) => ({ requestId: (++sequence).toString(16).padStart(32, '0'), leaseEpoch: 1, profileRef: entry.profile_ref,
    deadlineMonotonicMs: 45000, clientIdentity: client.name,
    connection: { client, permissions, revision: permissions.connectionRevision(client), isCurrent: () => permissions.isCurrent(client) },
    toolName: 'open_authorized_ssh_profile', operation: { method: 'open_authorized_ssh_profile' as const, params: { profile_ref: entry.profile_ref } },
  })
  return { permissions, a, b, profile, memory, presenter, profiles, gate, request, sent, tab, closeTab, ready: () => ready() }
}

describe('client connection checks at execution boundaries', () => {
  it('does not publish a reusable opened transport that disconnected during connection approval persistence', async () => {
    const f = await fixture()
    f.presenter.presentOpen.mockResolvedValueOnce('allow')
    const persist = f.permissions.setConnectionPermission.bind(f.permissions)
    vi.spyOn(f.permissions, 'setConnectionPermission').mockImplementationOnce(async (...args) => {
      await persist(...args)
      f.tab.session.open = false
    })
    const retained = vi.fn()
    expect((await f.gate.requestOpen({ ...f.request(), onRetainedTab: retained })).ok).toBe(true)
    const [tab, metadata] = retained.mock.calls[0]!
    const tabs = new McpOwnedTabs()
    const ref = tabs.track(f.a, tab, metadata, metadata.reusable)!
    expect(tabs.reusable(ref, f.a)).toBe(false)
    expect(tabs.owns(ref, f.a)).toBe(true)
  })

  it('publishes the exact newly opened tab only after a successful open', async () => {
    const f = await fixture()
    const retained = vi.fn()
    expect((await f.gate.requestOpen({ ...f.request(), onRetainedTab: retained })).ok).toBe(false)
    expect(retained).not.toHaveBeenCalled()
    await f.permissions.setConnectionPermission(f.a, 'p', stableProfileDigest(f.profile))
    expect((await f.gate.requestOpen({ ...f.request(), onRetainedTab: retained })).ok).toBe(true)
    expect(retained).toHaveBeenCalledWith(f.tab, expect.objectContaining({ profileId: f.profile.id, profileDigest: stableProfileDigest(f.profile), reusable: true, reused: false }))
  })

  it('ignores legacy global open grants and isolates client preauthorization', async () => {
    const f = await fixture()
    await f.memory.setManagedGrant('p', f.profile, { openSession: true, operationTier: 'auto_edit' })
    expect(await f.gate.requestOpen(f.request())).toEqual({ ok: false, code: 'not_approved' })
    await f.permissions.setConnectionPermission(f.a, 'p', stableProfileDigest(f.profile))
    expect(await f.gate.requestOpen(f.request())).toEqual({ ok: true, status: 'opened' })
    expect(await f.gate.requestOpen(f.request(f.b))).toEqual({ ok: false, code: 'not_approved' })
    expect(f.profiles.openNewTabForProfile).toHaveBeenCalledTimes(1)
    expect(await f.gate.describeOperationAuthorization(f.request().profileRef, f.request().connection)).toMatchObject({ openSession: true, operationTier: 'auto_edit' })
    expect(await f.gate.describeOperationAuthorization(f.request().profileRef, f.request(f.b).connection)).toMatchObject({ openSession: false })
  })

  it('prompts for command connections, remembers the client, and opens exactly one tab', async () => {
    const f = await fixture()
    await f.memory.setManagedGrant('p', f.profile, { openSession: false, operationTier: 'auto_edit' })
    f.presenter.presentOpen.mockResolvedValue('allow')
    expect(await f.gate.runAuthorizedSshCommand({ ...f.request(), command: 'ls' })).toMatchObject({ ok: true, output: 'files\n' })
    expect(f.presenter.presentOpen.mock.calls[0]?.[0]).toMatchObject({ toolName: 'run_authorized_ssh_command', clientIdentity: 'Agent' })
    expect(f.profiles.openNewTabForProfile).toHaveBeenCalledTimes(1)
    expect(f.permissions.hasConnectionPermission(f.a, 'p', stableProfileDigest(f.profile))).toBe(true)
    expect(f.permissions.hasConnectionPermission(f.b, 'p', stableProfileDigest(f.profile))).toBe(false)
    expect(await f.gate.runAuthorizedSshCommand({ ...f.request(), command: 'rm file' })).toMatchObject({ ok: false })
    expect(f.presenter.presentOpen).toHaveBeenCalledTimes(1)
  })

  it('does not restore an authorization revoked while its dialog was open', async () => {
    const f = await fixture()
    let allow!: (value: 'allow') => void
    f.presenter.presentOpen.mockImplementation(() => new Promise(resolve => { allow = resolve }))
    const pending = f.gate.requestOpen(f.request())
    await vi.waitFor(() => expect(allow).toBeTypeOf('function'))
    await f.permissions.setConnectionPermission(f.a, 'p', null)
    allow('allow')
    expect(await pending).toMatchObject({ ok: false })
    expect(f.profiles.openNewTabForProfile).not.toHaveBeenCalled()
    expect(f.permissions.connectionGrants(f.a)).toEqual([])
  })

  it('blocks command sending if connection permission is revoked while SSH becomes ready', async () => {
    const f = await fixture()
    await f.memory.setManagedGrant('p', f.profile, { openSession: false, operationTier: 'auto_edit' })
    await f.permissions.setConnectionPermission(f.a, 'p', stableProfileDigest(f.profile))
    f.tab.session.open = false
    const running = f.gate.runAuthorizedSshCommand({ ...f.request(), command: 'ls' })
    await vi.waitFor(() => expect(f.profiles.openNewTabForProfile).toHaveBeenCalled())
    await f.permissions.setConnectionPermission(f.a, 'p', null)
    f.tab.session.open = true
    f.ready()
    expect(await running).toMatchObject({ ok: false })
    expect(f.sent).toEqual([])
    expect(f.closeTab).toHaveBeenCalledWith(f.tab)
  })
})
