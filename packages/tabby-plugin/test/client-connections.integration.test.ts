import '@angular/compiler'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CredentialStore } from '@tabby-secure-mcp/companion'
import { expect, it, vi } from 'vitest'
vi.mock('tabby-core', () => ({ ConfigService: class {}, ProfilesService: class {}, AppService: class {}, HostWindowService: class {} }))
import { ApprovalGatekeeper } from '../src/approval/approval-gatekeeper'
import { stableProfileDigest } from '../src/approval/profile-security-snapshot'
import { PermanentAuthorizationStore } from '../src/authorization/permanent-authorization-store'
import { AuthorizedProfilesService } from '../src/services/authorized-profiles.service'
import { PluginHttpRuntime } from '../src/runtime/plugin-http-runtime'
import { RuntimeLeaseState } from '../src/runtime/runtime-lease-state'

it('enforces independent preauthorized connections over real HTTP with the production gatekeeper', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'tabby-client-http-')))
  const reservation = createServer()
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = (reservation.address() as { port: number }).port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const profile = { id: 'qa', name: 'Fixture SSH', type: 'ssh', options: { host: 'fixture.invalid' }, isBuiltin: false, isTemplate: false }
  const config = { store: { profiles: [profile], secureMcp: { http: { enabled: true, port }, authorizedSshProfileIds: ['qa'], permanentAuthorizations: [] as any[] } }, save: async () => {} }
  const audit = { append: vi.fn(async () => {}) }
  const presenter = { presentOpen: vi.fn(async () => 'deny' as 'allow' | 'deny'), presentPairing: async () => 'deny' as const, presentClient: vi.fn(async () => null) }
  const profiles = { getProfiles: async () => structuredClone(config.store.profiles), getConfigProxyForProfile: (p: any) => p,
    openNewTabForProfile: vi.fn(async () => {
      let output!: (chunk: string) => void
      return { session: { open: true }, frontendReady$: { subscribe: () => ({ unsubscribe() {} }) },
        output$: { subscribe(observer: any) { output = observer.next; return { unsubscribe() {} } } },
        sendInput(data: string) {
          const marker = data.match(/'([0-9a-f]+)' '([0-9a-f]+)'\r$/)
          if (marker) output(`\u001e${marker[1]}${marker[2]}:start\u001ffixture result\n\u001e${marker[1]}${marker[2]}:end\u001f`)
        },
      }
    }),
  }
  const credentialsFile = join(directory, 'private', 'credentials.json')
  const credentials = new CredentialStore(credentialsFile)
  await credentials.load()
  const a = await credentials.create('Same name'), b = await credentials.create('Same name')
  await credentials.setPermission(a.id, a.generation, 'permanent')
  await credentials.setPermission(b.id, b.generation, 'permanent')
  const [currentA, currentB] = credentials.list()
  await credentials.setConnectionPermission(currentA!, 'qa', stableProfileDigest(profile))
  const lease = new RuntimeLeaseState()
  const authorized = new AuthorizedProfilesService(profiles as never, config as never)
  const memory = new PermanentAuthorizationStore(config as never)
  await memory.setManagedGrant('qa', profile, { openSession: true, operationTier: 'readonly' })
  const gate = new ApprovalGatekeeper(authorized, profiles as never, presenter, { now: () => performance.now() }, () => lease.getLeaseEpoch(), undefined, memory, { audit, closeTab: async () => {} })
  const now = performance.now.bind(performance)
  let elapsed = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now() + elapsed)
  const runtime = new PluginHttpRuntime(config as never, () => ({ isMainWindow: true, windowId: '1' }), lease, gate, authorized, audit as never, presenter as never, { credentials })
  const clients: Client[] = []
  try {
    await runtime.start()
    const connect = async (id: string) => {
      const client = new Client({ name: 'Untrusted same name', version: '1' }, { capabilities: {}, supportedProtocolVersions: ['2025-11-25'] })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${credentials.tokenFor(id)}` } } }))
      return client
    }
    const ca = await connect(a.id), cb = await connect(b.id)
    const listed = await ca.callTool({ name: 'list_authorized_ssh_profiles', arguments: {} })
    const ref = (listed.structuredContent as any).profiles[0].profile_ref
    const call = (client: Client, name: string, args = {}) => {
      elapsed += 3100 // Refill the production 20/minute bucket between completed requests.
      return client.callTool({ name, arguments: { profile_ref: ref, ...args } })
    }
    expect((await call(ca, 'get_ssh_operation_authorization')).structuredContent).toMatchObject({ open_session: true })
    expect((await call(cb, 'get_ssh_operation_authorization')).structuredContent).toMatchObject({ open_session: false })
    expect((await call(ca, 'open_authorized_ssh_profile')).isError).toBeFalsy()
    expect((await call(ca, 'run_authorized_ssh_command', { command: 'id' })).structuredContent).toMatchObject({ output: 'fixture result\n' })
    expect(presenter.presentOpen).not.toHaveBeenCalled()
    expect(presenter.presentClient).not.toHaveBeenCalled()
    expect((await call(cb, 'open_authorized_ssh_profile')).isError).toBe(true)
    expect(presenter.presentOpen).toHaveBeenCalledOnce()
    presenter.presentOpen.mockResolvedValueOnce('allow')
    const approvedCommand = await call(cb, 'run_authorized_ssh_command', { command: 'id' })
    expect(approvedCommand.isError, JSON.stringify(approvedCommand)).toBeFalsy()
    expect(credentials.hasConnectionPermission(currentB!, 'qa', stableProfileDigest(profile))).toBe(true)
    await credentials.setConnectionPermission(currentB!, 'qa', null)
    const opened = profiles.openNewTabForProfile.mock.calls.length
    expect((await call(cb, 'run_authorized_ssh_command', { command: 'id' })).isError).toBe(true)
    expect(profiles.openNewTabForProfile).toHaveBeenCalledTimes(opened)
    const restarted = new CredentialStore(credentialsFile)
    await restarted.load()
    expect(restarted.hasConnectionPermission(currentA!, 'qa', stableProfileDigest(profile))).toBe(true)
    expect(restarted.hasConnectionPermission(currentB!, 'qa', stableProfileDigest(profile))).toBe(false)
  } finally {
    await Promise.all(clients.map(client => client.close()))
    runtime.destroy()
    clock.mockRestore()
    await rm(directory, { recursive: true, force: true })
  }
})
