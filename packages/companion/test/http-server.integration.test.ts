import type { Server } from 'node:http'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it, vi } from 'vitest'
import { EmbeddedMcpServer } from '../src/http/server.js'
import { CredentialStore } from '../src/http/credentials.js'
import type { CredentialStorePort, HttpCallContext } from '../src/http/contracts.js'

it.each([true, false])('negotiates all seven tool contracts over stateful JSON HTTP (retained command tab: %s)', async retainCommandTab => {
  const runOptions = retainCommandTab ? { tab_ref: 'tab-a', new_tab: false } : { new_tab: true }
  const identity = { id: 'client-a', generation: 1, name: 'SDK integration' }
  const credentials: CredentialStorePort = {
    load: async () => {}, list: () => [{ ...identity, permission: { kind: 'none' } }],
    create: async () => { throw new Error('unused') }, rename: async () => {}, reset: async () => {}, revoke: async () => {},
    setPermission: async () => {}, consumeSessionPermission: () => false,
    tokenFor: () => 'integration-token', authenticate: token => token === 'integration-token' ? identity : undefined,
    isCurrent: client => client.id === identity.id && client.generation === 1,
    permission: () => ({ kind: 'none' }), grant: async () => {},
    onInvalidated: () => () => {}, onChange: () => () => {}, hasUnpersistedRevocations: false,
    fileTransferRevision: () => 0, hasFileTransferPermission: () => false,
    setFileTransferPermission: async () => { throw new Error('unused') },
  }
  const realNow = performance.now.bind(performance)
  let elapsed = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => realNow() + elapsed)
  const contexts: HttpCallContext[] = []
  const server = new EmbeddedMcpServer({
    port: 0, credentials, approveClient: async () => 'session', audit: async () => {},
    dispatch: async (request, context) => {
      contexts.push(context)
      switch (request.method) {
        case 'list_authorized_ssh_profiles': return { ok: true, result: { profiles: [{ profile_ref: 'ref-a', display_name: 'Test' }] } }
        case 'open_authorized_ssh_profile': return { ok: true, result: { status: 'opened', tab_ref: 'tab-a', tab_reusable: true } }
        case 'close_mcp_ssh_tab':
          expect(request.params).toEqual({ tab_ref: 'tab-a' })
          return { ok: true, result: { status: 'closed' } }
        case 'get_ssh_operation_authorization': return { ok: true, result: { profile_ref: request.params.profile_ref, open_session: true, approval_mode: 'auto_edit', authorizes: 'ssh_command', policy: [] } }
        case 'run_authorized_ssh_command':
          expect(request.params).toEqual({ profile_ref: 'ref-a', command: 'echo hello', ...runOptions })
          return { ok: true, result: { status: 'completed', command_risk: 'low', output: 'hello', truncated: false, ...(retainCommandTab ? { tab_ref: 'tab-a', tab_reusable: true, reused_tab: true } : {}) } }
        case 'upload_ssh_file':
        case 'download_ssh_file':
          expect(request.params).toEqual({ profile_ref: 'ref-a', local_path: '/tmp/local file', remote_path: '/tmp/remote file' })
          return { ok: true, result: { status: request.method === 'upload_ssh_file' ? 'uploaded' : 'downloaded', bytes_transferred: 123, tab_ref: 'tab-a', tab_reusable: false } }
      }
    },
  })
  const client = new Client({ name: 'sdk', version: '1' }, { capabilities: {}, supportedProtocolVersions: ['2025-11-25'] })
  try {
    await server.start()
    const port = ((server as unknown as { httpServer: Server }).httpServer.address() as { port: number }).port
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer integration-token' } } })
    await client.connect(transport)
    expect(transport.sessionId).toBeTruthy()
    const tools = await client.listTools()
    expect(tools.tools.map(t => t.name).sort()).toEqual(['close_mcp_ssh_tab', 'download_ssh_file', 'get_ssh_operation_authorization', 'list_authorized_ssh_profiles', 'open_authorized_ssh_profile', 'run_authorized_ssh_command', 'upload_ssh_file'])
    const conflict = await client.callTool({ name: 'run_authorized_ssh_command', arguments: { profile_ref: 'ref-a', command: 'pwd', tab_ref: 'tab-a', new_tab: true } })
    expect(conflict.isError).toBe(true)
    expect(contexts).toHaveLength(0)
    const cases = [
      ['list_authorized_ssh_profiles', {}, { profiles: [{ profile_ref: 'ref-a', display_name: 'Test' }] }],
      ['open_authorized_ssh_profile', { profile_ref: 'ref-a' }, { status: 'opened', tab_ref: 'tab-a', tab_reusable: true }],
      ['get_ssh_operation_authorization', { profile_ref: 'ref-a' }, { profile_ref: 'ref-a', open_session: true, approval_mode: 'auto_edit', authorizes: 'ssh_command', policy: [] }],
      ['run_authorized_ssh_command', { profile_ref: 'ref-a', command: 'echo hello', ...runOptions }, { status: 'completed', command_risk: 'low', output: 'hello', truncated: false, ...(retainCommandTab ? { tab_ref: 'tab-a', tab_reusable: true, reused_tab: true } : {}) }],
      ['close_mcp_ssh_tab', { tab_ref: 'tab-a' }, { status: 'closed' }],
      ['upload_ssh_file', { profile_ref: 'ref-a', local_path: '/tmp/local file', remote_path: '/tmp/remote file' }, { status: 'uploaded', bytes_transferred: 123, tab_ref: 'tab-a', tab_reusable: false }],
      ['download_ssh_file', { profile_ref: 'ref-a', local_path: '/tmp/local file', remote_path: '/tmp/remote file' }, { status: 'downloaded', bytes_transferred: 123, tab_ref: 'tab-a', tab_reusable: false }],
    ] as const
    for (const [name, args, expected] of cases) {
      if (name === 'upload_ssh_file') elapsed += 6_000 // Refill two tokens for the additional file tools.
      const result = await client.callTool({ name, arguments: args })
      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toEqual(expected)
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(expected) }])
    }
    expect(new Set(contexts.map(c => c.requestId)).size).toBe(7)
    expect(contexts.every(c => c.client.id === 'client-a' && !c.signal.aborted && c.deadlineMonotonicMs > performance.now())).toBe(true)
    await transport.terminateSession()
    expect(server.sessionViews()).toEqual([])
  } finally { await client.close(); await server.close(); clock.mockRestore() }
})

it('changes an existing client lifetime over real HTTP while keeping its token and other clients intact', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'mcp-permission-')))
  const credentials = new CredentialStore(join(directory, 'credentials.json'))
  await credentials.load()
  const a = await credentials.create('Agent A'), b = await credentials.create('Agent B')
  const token = credentials.tokenFor(a.id)
  const realNow = performance.now.bind(performance)
  let elapsed = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => realNow() + elapsed)
  const approveClient = vi.fn(async () => 'session' as const)
  let activeCall: HttpCallContext | undefined
  let finishCall: (() => void) | undefined
  const server = new EmbeddedMcpServer({ port: 0, credentials, approveClient, audit: async () => {}, dispatch: async (request, context) => {
    if (request.method === 'run_authorized_ssh_command') {
      activeCall = context
      await new Promise<void>(resolve => { finishCall = resolve })
    }
    return { ok: true, result: { profiles: [] } }
  } })
  const clients: Client[] = []
  try {
    await server.start()
    const port = ((server as unknown as { httpServer: Server }).httpServer.address() as { port: number }).port
    const url = new URL(`http://127.0.0.1:${port}/mcp`)
    const connect = async (id: string) => {
      elapsed += 6_000 // Refill initialization rate limits between distinct user actions.
      const client = new Client({ name: 'generic-test-agent', version: '1' }, { capabilities: {}, supportedProtocolVersions: ['2025-11-25'] })
      clients.push(client)
      const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${credentials.tokenFor(id)}` } } })
      await client.connect(transport)
      await vi.waitFor(() => expect(server.sessionViews().find(s => s.clientId === id)?.state).toBe('approved'))
      return { client, transport }
    }
    const first = await connect(a.id)
    await connect(b.id)
    const running = first.client.callTool({ name: 'run_authorized_ssh_command', arguments: { profile_ref: 'ref', command: 'pwd' } }).catch(() => null)
    await vi.waitFor(() => expect(activeCall).toBeDefined())
    let generation = a.generation
    for (const duration of ['permanent', '24h', 'session', 'none'] as const) {
      const changing = credentials.setPermission(a.id, generation++, duration)
      expect(server.sessionViews().some(s => s.clientId === a.id)).toBe(false)
      expect(activeCall!.signal.aborted).toBe(true)
      expect(server.sessionViews().find(s => s.clientId === b.id)?.state).toBe('approved')
      await changing
      expect(credentials.tokenFor(a.id)).toBe(token)
      const approvalsBefore = approveClient.mock.calls.length
      const reconnected = await connect(a.id)
      expect(server.sessionViews().find(s => s.clientId === a.id)?.duration).toBe(duration === '24h' ? '24h' : duration === 'permanent' ? 'permanent' : 'session')
      expect(approveClient.mock.calls.length).toBe(approvalsBefore + (duration === 'none' ? 1 : 0))
      if (duration === 'session') {
        await reconnected.transport.terminateSession()
        await reconnected.client.close()
        await vi.waitFor(() => expect(server.sessionViews().some(s => s.clientId === a.id)).toBe(false))
        await connect(a.id)
        expect(approveClient.mock.calls.length).toBe(approvalsBefore + 1)
      }
    }
    finishCall!()
    await running
    await credentials.revoke(a.id)
    expect(credentials.authenticate(token)).toBeUndefined()
    expect(server.sessionViews().find(s => s.clientId === b.id)?.state).toBe('approved')
  } finally {
    finishCall?.()
    await Promise.all(clients.map(c => c.close()))
    await server.close()
    clock.mockRestore()
    await rm(directory, { recursive: true, force: true })
  }
})
