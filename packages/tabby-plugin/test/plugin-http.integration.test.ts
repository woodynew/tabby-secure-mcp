import '@angular/compiler'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CredentialStore } from '@tabby-secure-mcp/companion'
import { expect, it, vi } from 'vitest'
import { PluginHttpRuntime } from '../src/runtime/plugin-http-runtime'
import { RuntimeLeaseState } from '../src/runtime/runtime-lease-state'

it('serves five tools through the plugin and restores only the named permanent client after restart', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'tabby-http-integration-')))
  const reservation = createServer()
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = (reservation.address() as { port: number }).port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const config = { store: { secureMcp: { http: { enabled: true, port } } }, save: async () => {} }
  const audit = { append: vi.fn(async () => {}), safeAppend: vi.fn(async () => {}) }
  const ownedTab = { destroy: vi.fn() }
  const gate = {
    approvalBusy: false,
    requestOpen: vi.fn(async (request: any) => { request.onRetainedTab?.(ownedTab); return { ok: true, status: 'opened' } }),
    describeOperationAuthorization: async () => ({ ok: true, profileRef: 'ref', openSession: false, operationTier: 'auto_edit', policy: [] }),
    runAuthorizedSshCommand: vi.fn(async () => ({ ok: true, commandClass: 'read_only', commandRisk: 'low', output: 'test\n', truncated: false })),
  }
  const profiles = { listAuthorizedProfiles: async () => [{ profile_ref: 'ref', display_name: 'QA' }], clearRefCache() {} }
  const presenter = { presentClient: vi.fn(async () => 'permanent') }
  let runtime: PluginHttpRuntime | undefined
  let client: Client | undefined
  const start = async () => {
    const credentials = new CredentialStore(join(directory, 'credentials.json'))
    runtime = new PluginHttpRuntime(config as never, () => ({ isMainWindow: true, windowId: '1' }), new RuntimeLeaseState(), gate as never, profiles as never, audit as never, presenter as never, { credentials })
    await runtime.start()
    expect(runtime.status).toBe('running')
    return credentials
  }
  try {
    const credentials = await start()
    const named = await credentials.create('My named AI client')
    const token = credentials.tokenFor(named.id)
    const connect = async () => {
      client = new Client({ name: 'self-declared agent', version: '1' }, { capabilities: {}, supportedProtocolVersions: ['2025-11-25'] })
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
      await vi.waitFor(() => expect(runtime!.sessions()[0]?.state).toBe('approved'))
    }
    await connect()
    expect(presenter.presentClient.mock.calls[0]![0]).toMatchObject({ clientIdentity: 'My named AI client' })
    let tabRef: string | undefined
    for (const [name, args] of [
      ['list_authorized_ssh_profiles', {}],
      ['get_ssh_operation_authorization', { profile_ref: 'ref' }],
      ['open_authorized_ssh_profile', { profile_ref: 'ref' }],
      ['run_authorized_ssh_command', { profile_ref: 'ref', command: 'whoami' }],
    ] as const) {
      const result = await client!.callTool({ name, arguments: args })
      expect(result.isError).toBeFalsy()
      if (name === 'open_authorized_ssh_profile') tabRef = (result.structuredContent as any).tab_ref
    }
    expect(tabRef).toEqual(expect.any(String))
    expect((await client!.callTool({ name: 'close_mcp_ssh_tab', arguments: { tab_ref: tabRef } })).structuredContent).toEqual({ status: 'closed' })
    expect(ownedTab.destroy).toHaveBeenCalledOnce()
    expect(gate.requestOpen).toHaveBeenCalledOnce()
    expect(gate.runAuthorizedSshCommand).toHaveBeenCalledOnce()
    await client!.close()
    runtime!.destroy()
    await vi.waitFor(() => expect(runtime!.status).toBe('stopped'))
    await start()
    await connect()
    expect(presenter.presentClient).toHaveBeenCalledOnce()
    expect(runtime!.sessions()[0]?.duration).toBe('permanent')
  } finally {
    await client?.close()
    runtime?.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})
