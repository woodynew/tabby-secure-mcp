import { execSync } from 'node:child_process'
import { mkdtemp, readFile, stat, unlink } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { encodeFrame } from '@tabby-secure-mcp/ipc-contract'

import { FakePluginPeer } from './helpers/fake-plugin-peer.js'

const packageRoot = path.resolve(import.meta.dirname, '..')
const cliPath = path.join(packageRoot, 'dist', 'cli.js')
const activeClients: Client[] = []
const activePeers: FakePluginPeer[] = []
const runtimeDirs: string[] = []

beforeAll(() => {
  execSync('npm run build', { cwd: packageRoot, stdio: 'pipe' })
  const built = readFile(cliPath, 'utf8')
  return built.then((contents) => {
    expect(contents.startsWith('#!/usr/bin/env node')).toBe(true)
    expect(contents).toMatch(/serveStdio/)
    expect(contents).toMatch(/list_authorized_ssh_profiles/)
    expect(contents).toMatch(/tabby-secure-mcp-pairing-v1/)
  })
})

afterEach(async () => {
  await Promise.all(activeClients.splice(0).map((client) => client.close()))
  activePeers.splice(0).forEach((peer) => peer.close())
})

function runtimeIsolationEnv(runtimeDir: string): Record<string, string> {
  if (process.platform === 'win32') {
    return { LOCALAPPDATA: runtimeDir }
  }
  if (process.platform === 'darwin') {
    return { TMPDIR: runtimeDir }
  }
  return { XDG_RUNTIME_DIR: runtimeDir }
}

async function createRuntimeDir(): Promise<string> {
  const root = process.platform === 'darwin' ? '/tmp' : tmpdir()
  const prefix = process.platform === 'darwin' ? 'tsm-' : 'tabby-companion-int-'
  const dir = await mkdtemp(path.join(root, prefix))
  runtimeDirs.push(dir)
  return dir
}

async function startCompanion(
  runtimeDir: string,
  env: Record<string, string> = {},
): Promise<{
  client: Client
  transport: StdioClientTransport
  paths: { descriptorPath: string; endpoint: string; lockPath: string }
}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath],
    env: {
      ...process.env,
      ...runtimeIsolationEnv(runtimeDir),
      ...env,
    },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'integration-test', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport)
  activeClients.push(client)

  const descriptorPath = path.join(runtimeDir, 'tabby-secure-mcp', 'descriptor.json')
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as {
    endpoint: string
    pid: number
    pairing_nonce: string
  }

  return {
    client,
    transport,
    paths: {
      descriptorPath,
      endpoint: descriptor.endpoint,
      lockPath: path.join(runtimeDir, 'tabby-secure-mcp', 'companion.lock'),
    },
  }
}

async function pairPeer(
  runtimeDir: string,
  descriptorPath: string,
  endpoint: string,
  pairingNonce: string,
  pid: number,
  options: Partial<FakePluginPeerOptions> = {},
): Promise<FakePluginPeer> {
  const peer = await FakePluginPeer.connect({
    runtimeDirectory: runtimeDir,
    descriptorPath,
    endpoint,
    pairingNonce,
    pid,
    windowInstanceId: options.windowInstanceId ?? 'window-main',
    isMainWindow: options.isMainWindow ?? true,
    approvePairing: options.approvePairing,
    onRpc: options.onRpc,
    sendCoalesced: options.sendCoalesced,
    delayMs: options.delayMs,
  })
  activePeers.push(peer)
  await peer.waitForLease()
  return peer
}

type FakePluginPeerOptions = ConstructorParameters<typeof FakePluginPeer.connect>[0]

describe('companion stdio MCP integration', () => {
  it('exposes exactly two tools and returns structured list results', async () => {
    const runtimeDir = await createRuntimeDir()
    const { client, paths } = await startCompanion(runtimeDir)
    const descriptor = JSON.parse(await readFile(paths.descriptorPath, 'utf8'))
    await pairPeer(runtimeDir, paths.descriptorPath, paths.endpoint, descriptor.pairing_nonce, descriptor.pid, {
      onRpc: async (request, ctx) => ({
        type: 'rpc_result',
        request_id: ctx.requestId,
        lease_epoch: ctx.leaseEpoch,
        ok: true,
        result: {
          profiles: [{ profile_ref: 'ref-1', display_name: 'Primary' }],
        },
      }),
    })

    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'list_authorized_ssh_profiles',
      'open_authorized_ssh_profile',
    ])

    const result = await client.callTool({
      name: 'list_authorized_ssh_profiles',
      arguments: {},
    })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual({
      profiles: [{ profile_ref: 'ref-1', display_name: 'Primary' }],
    })
    expect(result.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({
          profiles: [{ profile_ref: 'ref-1', display_name: 'Primary' }],
        }),
      },
    ])
  })

  it('opens a profile and maps denial to safe MCP errors', async () => {
    const runtimeDir = await createRuntimeDir()
    const { client, paths } = await startCompanion(runtimeDir)
    const descriptor = JSON.parse(await readFile(paths.descriptorPath, 'utf8'))
    await pairPeer(runtimeDir, paths.descriptorPath, paths.endpoint, descriptor.pairing_nonce, descriptor.pid, {
      onRpc: async (request, ctx) => {
        if (request.method === 'open_authorized_ssh_profile') {
          return {
            type: 'rpc_result',
            request_id: ctx.requestId,
            lease_epoch: ctx.leaseEpoch,
            ok: true,
            result: { status: 'opened' },
          }
        }
        return {
          type: 'rpc_result',
          request_id: ctx.requestId,
          lease_epoch: ctx.leaseEpoch,
          ok: false,
          error: { code: 'not_approved', message: 'user denied' },
        }
      },
    })

    const opened = await client.callTool({
      name: 'open_authorized_ssh_profile',
      arguments: { profile_ref: 'ref-1' },
    })
    expect(opened.isError).toBeFalsy()
    expect(opened.structuredContent).toEqual({ status: 'opened' })

    const denied = await client.callTool({
      name: 'list_authorized_ssh_profiles',
      arguments: {},
    })
    expect(denied.isError).toBe(true)
    expect(denied.content[0]).toEqual({
      type: 'text',
      text: 'The operation was not approved in Tabby.',
    })
  })

  it('cancels in-flight work on abort and ignores late plugin results', async () => {
    const runtimeDir = await createRuntimeDir()
    const { client, paths } = await startCompanion(runtimeDir)
    const descriptor = JSON.parse(await readFile(paths.descriptorPath, 'utf8'))
    let peer!: FakePluginPeer
    peer = await pairPeer(runtimeDir, paths.descriptorPath, paths.endpoint, descriptor.pairing_nonce, descriptor.pid, {
      onRpc: async (_request, ctx) => {
        const deadline = Date.now() + 300
        while (Date.now() < deadline) {
          if (peer.messages.some((message) => message.type === 'cancel_request')) {
            return {
              type: 'rpc_cancelled',
              request_id: ctx.requestId,
              lease_epoch: ctx.leaseEpoch,
              reason: 'cancelled',
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        return {
          type: 'rpc_result',
          request_id: ctx.requestId,
          lease_epoch: ctx.leaseEpoch,
          ok: true,
          result: { profiles: [] },
        }
      },
    })

    const controller = new AbortController()
    const pending = client.callTool(
      { name: 'list_authorized_ssh_profiles', arguments: {} },
      { signal: controller.signal },
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    controller.abort()
    await expect(pending).rejects.toThrow(/aborted/i)
    await peer.waitForCancel()
    await new Promise((resolve) => setTimeout(resolve, 350))

    const tools = await client.listTools()
    expect(tools.tools).toHaveLength(2)
  }, 15_000)

  it('returns expired when the plugin does not answer before the deadline', async () => {
    const runtimeDir = await createRuntimeDir()
    const { client, paths } = await startCompanion(runtimeDir, {
      TABBY_SECURE_MCP_RPC_DEADLINE_MS: '50',
    })
    const descriptor = JSON.parse(await readFile(paths.descriptorPath, 'utf8'))
    await pairPeer(runtimeDir, paths.descriptorPath, paths.endpoint, descriptor.pairing_nonce, descriptor.pid, {
      onRpc: async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
        return {
          type: 'rpc_result',
          request_id: 'never',
          lease_epoch: 1,
          ok: true,
          result: { profiles: [] },
        }
      },
    })

    const result = await client.callTool({
      name: 'list_authorized_ssh_profiles',
      arguments: {},
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'The operation timed out before it could finish.',
    })
  })

  it('rejects plugin results whose shape does not match the originating method', async () => {
    const runtimeDir = await createRuntimeDir()
    const { client, paths } = await startCompanion(runtimeDir)
    const descriptor = JSON.parse(await readFile(paths.descriptorPath, 'utf8'))
    await pairPeer(runtimeDir, paths.descriptorPath, paths.endpoint, descriptor.pairing_nonce, descriptor.pid, {
      onRpc: async (request, ctx) => ({
        type: 'rpc_result',
        request_id: ctx.requestId,
        lease_epoch: ctx.leaseEpoch,
        ok: true,
        result: { status: 'opened' },
      }),
    })

    const result = await client.callTool({
      name: 'list_authorized_ssh_profiles',
      arguments: {},
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'The companion could not complete the operation.',
    })
  })

  it('maps disconnect and stale lease epochs to safe errors', async () => {
    const runtimeDir = await createRuntimeDir()
    const { client, paths } = await startCompanion(runtimeDir)
    const descriptor = JSON.parse(await readFile(paths.descriptorPath, 'utf8'))
    const peer = await pairPeer(runtimeDir, paths.descriptorPath, paths.endpoint, descriptor.pairing_nonce, descriptor.pid, {
      onRpc: async (request, ctx) => ({
        type: 'rpc_result',
        request_id: ctx.requestId,
        lease_epoch: ctx.leaseEpoch + 99,
        ok: true,
        result: { profiles: [] },
      }),
    })

    const stale = await client.callTool({
      name: 'list_authorized_ssh_profiles',
      arguments: {},
    })
    expect(stale.isError).toBe(true)
    expect(stale.content[0]?.text).toBe('The companion could not complete the operation.')

    peer.close()
    const unavailable = await client.callTool({
      name: 'list_authorized_ssh_profiles',
      arguments: {},
    })
    expect(unavailable.isError).toBe(true)
    expect(unavailable.content[0]?.text).toBe('Tabby is not connected or paired with this companion.')
  })

  it('rejects a second companion process for the same runtime', async () => {
    const runtimeDir = await createRuntimeDir()
    await startCompanion(runtimeDir)
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath],
      env: { ...process.env, ...runtimeIsolationEnv(runtimeDir) },
      stderr: 'pipe',
    })
    const second = new Client({ name: 'second', version: '0.0.0' }, { capabilities: {} })
    await expect(second.connect(transport)).rejects.toThrow()
  })

  it('handles partial, coalesced, and oversized frames during handshake', async () => {
    const runtimeDir = await createRuntimeDir()
    const { paths } = await startCompanion(runtimeDir)
    const descriptor = JSON.parse(await readFile(paths.descriptorPath, 'utf8'))
    await pairPeer(runtimeDir, paths.descriptorPath, paths.endpoint, descriptor.pairing_nonce, descriptor.pid, {
      sendCoalesced: true,
      delayMs: 1,
    })

    const socket = createConnection(paths.endpoint)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    const body = Buffer.from(
      JSON.stringify({
        v: 1,
        seq: 99,
        type: 'plugin_hello',
        window_instance_id: 'oversized',
        is_main_window: false,
        plugin_challenge: 'x'.repeat(9000),
      }),
      'utf8',
    )
    const oversized = Buffer.allocUnsafe(4 + body.byteLength)
    oversized.writeUInt32BE(body.byteLength, 0)
    body.copy(oversized, 4)
    socket.write(oversized)
    await new Promise((resolve) => setTimeout(resolve, 100))
    socket.destroy()

    expect((await stat(paths.descriptorPath)).isFile()).toBe(true)
  })

  it('cleans up socket, descriptor, and lock files on process exit', async () => {
    const runtimeDir = await createRuntimeDir()
    const { client, paths, transport } = await startCompanion(runtimeDir)
    const descriptor = JSON.parse(await readFile(paths.descriptorPath, 'utf8'))
    await pairPeer(runtimeDir, paths.descriptorPath, paths.endpoint, descriptor.pairing_nonce, descriptor.pid)
    await client.close()
    await transport.close()
    await new Promise((resolve) => setTimeout(resolve, 200))

    await expect(stat(paths.endpoint)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(paths.descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(paths.lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
