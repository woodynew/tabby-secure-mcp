import '@angular/compiler'
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises'
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
import { commandRuleFromText } from '@tabby-secure-mcp/ipc-contract/command-policy'

it('enforces independent preauthorized connections over real HTTP with the production gatekeeper', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'tabby-client-http-')))
  const reservation = createServer()
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = (reservation.address() as { port: number }).port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const profile = { id: 'qa', name: 'Fixture SSH', type: 'ssh', options: { host: 'fixture.invalid' }, isBuiltin: false, isTemplate: false }
  const config = { store: { profiles: [profile], secureMcp: { http: { enabled: true, port }, authorizedSshProfileIds: ['qa'], permanentAuthorizations: [] as any[] } }, save: async () => {} }
  const audit = { append: vi.fn(async () => {}) }
  const presenter = { presentOpen: vi.fn(async () => 'deny' as 'allow' | 'deny'), presentPairing: async () => 'deny' as const, presentClient: vi.fn(async () => null),
    presentCommand: vi.fn(async () => 'deny' as 'allow' | 'deny' | 'remember') }
  const createdTabs: Array<{ destroy: ReturnType<typeof vi.fn> }> = []
  const remoteFiles = new Map<string, Buffer>()
  const sftp = {
    stat: async (name: string) => {
      const bytes = remoteFiles.get(name)
      if (!bytes) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return { size: bytes.length, isDirectory: false, mode: 0o100600 }
    },
    open: async (name: string, flags: number) => {
      if (flags & 2) {
        if (remoteFiles.has(name)) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
        if ((flags & 32) === 0) throw new Error('exclusive creation required')
        remoteFiles.set(name, Buffer.alloc(0))
      }
      let read = false
      return { read: async () => { if (read) return new Uint8Array(); read = true; return remoteFiles.get(name)! },
        write: async (chunk: Uint8Array) => { remoteFiles.set(name, Buffer.concat([remoteFiles.get(name)!, Buffer.from(chunk)])) }, close: async () => {} }
    },
    unlink: async (_name: string) => { throw new Error('remote deletion must not be used') },
  }
  const profiles = { getProfiles: async () => structuredClone(config.store.profiles), getConfigProxyForProfile: (p: any) => p,
    openNewTabForProfile: vi.fn(async () => {
      let output!: (chunk: string) => void
      const tab = { destroy: vi.fn(), sshSession: { openSFTP: async () => sftp }, session: { open: true }, frontendReady$: { subscribe: () => ({ unsubscribe() {} }) },
        output$: { subscribe(observer: any) { output = observer.next; return { unsubscribe() {} } } },
        sendInput(data: string) {
          const marker = data.match(/'([0-9a-f]+)' '([0-9a-f]+)'\r$/)
          if (marker) output(`\u001e${marker[1]}${marker[2]}:start\u001ffixture result\n\u001e${marker[1]}${marker[2]}:end\u001f`)
        },
      }
      createdTabs.push(tab)
      return tab
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
  await memory.setManagedGrant('qa', profile, { openSession: true, operationTier: 'auto_edit' })
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
      return client.callTool({ name, arguments: name === 'close_mcp_ssh_tab' ? args : { profile_ref: ref, ...args } })
    }
    expect((await call(ca, 'get_ssh_operation_authorization')).structuredContent).toMatchObject({ open_session: true })
    expect((await call(cb, 'get_ssh_operation_authorization')).structuredContent).toMatchObject({ open_session: false })
    const openedByA = await call(ca, 'open_authorized_ssh_profile')
    expect(openedByA.structuredContent).toMatchObject({ status: 'opened', tab_ref: expect.any(String) })
    const openTabRef = (openedByA.structuredContent as any).tab_ref
    const sourcePath = join(directory, 'source.bin'), downloadedPath = join(directory, 'downloaded.bin')
    const bytes = Buffer.from([0, 255, 4, 13, 10, 128])
    await writeFile(sourcePath, bytes)
    const upload = { local_path: sourcePath, remote_path: '/fixture/upload.bin' }
    expect((await call(ca, 'upload_ssh_file', upload)).isError).toBe(true)
    expect(remoteFiles.size).toBe(0)
    await credentials.setFileTransferPermission(currentA!, 'qa', stableProfileDigest(profile), credentials.fileTransferRevision())
    expect((await call(ca, 'upload_ssh_file', upload)).structuredContent).toMatchObject({ status: 'uploaded', bytes_transferred: bytes.length, tab_ref: openTabRef })
    expect(remoteFiles.get('/fixture/upload.bin')).toEqual(bytes)
    expect((await call(cb, 'download_ssh_file', { local_path: downloadedPath, remote_path: '/fixture/upload.bin' })).isError).toBe(true)
    expect((await call(ca, 'download_ssh_file', { local_path: downloadedPath, remote_path: '/fixture/upload.bin' })).structuredContent).toMatchObject({ status: 'downloaded', bytes_transferred: bytes.length, tab_ref: openTabRef })
    expect(await readFile(downloadedPath)).toEqual(bytes)
    await credentials.setFileTransferPermission(currentA!, 'qa', null, credentials.fileTransferRevision())
    expect((await call(ca, 'download_ssh_file', { local_path: join(directory, 'denied.bin'), remote_path: '/fixture/upload.bin' })).isError).toBe(true)
    expect((await call(cb, 'close_mcp_ssh_tab', { tab_ref: openTabRef })).isError).toBe(true)
    expect(createdTabs[0]!.destroy).not.toHaveBeenCalled()
    expect((await call(ca, 'run_authorized_ssh_command', { command: 'id', tab_ref: openTabRef })).structuredContent).toMatchObject({ tab_ref: openTabRef, tab_reusable: true, reused_tab: true })
    expect((await call(ca, 'run_authorized_ssh_command', { command: 'id' })).structuredContent).toMatchObject({ tab_ref: openTabRef, reused_tab: true })
    expect(createdTabs).toHaveLength(1)
    expect((await call(cb, 'run_authorized_ssh_command', { command: 'id', tab_ref: openTabRef })).isError).toBe(true)
    expect(createdTabs).toHaveLength(1)
    const commandByA = await call(ca, 'run_authorized_ssh_command', { command: 'id', new_tab: true })
    expect(commandByA.structuredContent).toMatchObject({ output: 'fixture result\n', tab_ref: expect.any(String), tab_reusable: true, reused_tab: false })
    expect((commandByA.structuredContent as any).tab_ref).not.toBe(openTabRef)
    expect(createdTabs).toHaveLength(2)
    expect((await call(ca, 'close_mcp_ssh_tab', { tab_ref: openTabRef })).structuredContent).toEqual({ status: 'closed' })
    expect(createdTabs[0]!.destroy).toHaveBeenCalledOnce()
    expect((await call(ca, 'close_mcp_ssh_tab', { tab_ref: openTabRef })).isError).toBe(true)
    const commandTabRef = (commandByA.structuredContent as any).tab_ref
    config.store.secureMcp.authorizedSshProfileIds = []
    expect((await call(ca, 'close_mcp_ssh_tab', { tab_ref: commandTabRef })).structuredContent).toEqual({ status: 'closed' })
    expect(createdTabs[1]!.destroy).toHaveBeenCalledOnce()
    config.store.secureMcp.authorizedSshProfileIds = ['qa']
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
    // Exercise approval modes and persisted command sets through the real HTTP contract.
    await memory.setManagedGrant('qa', profile, { openSession: false, operationTier: 'ask' })
    presenter.presentCommand.mockResolvedValueOnce('remember')
    expect((await call(ca, 'run_authorized_ssh_command', { command: 'uci get openclash.config.en_mode' })).isError).toBeFalsy()
    expect((await call(ca, 'run_authorized_ssh_command', { command: 'uci get openclash.config.enable' })).isError).toBeFalsy()
    expect(presenter.presentCommand).toHaveBeenCalledOnce()
    expect(credentials.commandSet(currentA!, 'qa', stableProfileDigest(profile)).rules).toHaveLength(1)
    expect(credentials.commandSet(currentB!, 'qa', stableProfileDigest(profile)).rules).toHaveLength(0)
    await credentials.setDefaultCommandSet([commandRuleFromText('docker ps', 'family')], credentials.commandRevision())
    expect((await call(ca, 'run_authorized_ssh_command', { command: 'docker ps' })).structuredContent).toMatchObject({ command_risk: 'low' })
    expect(presenter.presentCommand).toHaveBeenCalledOnce()
    await credentials.setCommandSet(currentA!, 'qa', stableProfileDigest(profile), { inheritDefaults: false, rules: [] }, credentials.commandRevision())
    expect((await call(ca, 'run_authorized_ssh_command', { command: 'docker ps' })).isError).toBe(true)
    expect(presenter.presentCommand).toHaveBeenCalledTimes(2)
    await memory.setManagedGrant('qa', profile, { openSession: false, operationTier: 'auto_edit' })
    await credentials.setCommandSet(currentA!, 'qa', stableProfileDigest(profile), { inheritDefaults: false, rules: [commandRuleFromText('rm /tmp/demo', 'exact')] }, credentials.commandRevision())
    presenter.presentCommand.mockResolvedValue('allow')
    for (let i = 0; i < 2; i++) expect((await call(ca, 'run_authorized_ssh_command', { command: 'rm /tmp/demo' })).structuredContent).toMatchObject({ command_risk: 'high' })
    expect(presenter.presentCommand).toHaveBeenCalledTimes(4)
    expect((await call(ca, 'get_ssh_operation_authorization')).structuredContent).toMatchObject({ approval_mode: 'auto_edit' })
    const restarted = new CredentialStore(credentialsFile)
    await restarted.load()
    expect(restarted.hasConnectionPermission(currentA!, 'qa', stableProfileDigest(profile))).toBe(true)
    expect(restarted.hasConnectionPermission(currentB!, 'qa', stableProfileDigest(profile))).toBe(false)
    expect(restarted.defaultCommandSet().rules).toEqual([commandRuleFromText('docker ps', 'family')])
    expect(restarted.commandSet(currentA!, 'qa', stableProfileDigest(profile))).toMatchObject({ inheritDefaults: false })
  } finally {
    await Promise.all(clients.map(client => client.close()))
    runtime.destroy()
    clock.mockRestore()
    await rm(directory, { recursive: true, force: true })
  }
})
