import { mkdir, mkdtemp, unlink } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Buffer } from 'node:buffer'

import { encodeFrame, type IpcMessage } from '@tabby-secure-mcp/ipc-contract'

import { createPairingNonce, createPairingResponse } from '../../src/index.js'
import { createPluginGateway, type PluginGateway } from '../../src/gateway/plugin-gateway.js'

export interface GatewayHarness {
  gateway: PluginGateway
  endpoint: string
  pairingNonce: string
  pid: number
  close(): Promise<void>
}

export async function startGatewayHarness(
  options: { handshakeTimeoutMs?: number } = {},
): Promise<GatewayHarness> {
  const base = await mkdtemp(path.join(tmpdir(), 'tabby-gw-test-'))
  const endpoint = path.join(base, 'companion.sock')
  await mkdir(path.dirname(endpoint), { recursive: true, mode: 0o700 })
  const pairingNonce = createPairingNonce(() => Buffer.alloc(32, 0x42))
  const gateway = createPluginGateway({
    endpoint,
    pid: 4242,
    pairingNonce,
    handshakeTimeoutMs: options.handshakeTimeoutMs,
  })
  await gateway.listen()
  return {
    gateway,
    endpoint,
    pairingNonce,
    pid: 4242,
    close: async () => {
      await gateway.close()
      await unlink(endpoint).catch(() => undefined)
    },
  }
}

export class RawPluginPeer {
  readonly socket: Socket
  #buffer = Buffer.alloc(0)
  #seq = 0
  readonly inbound: IpcMessage[] = []
  companionChallenge?: string
  pluginChallenge: string
  autoListRpc = false

  private constructor(socket: Socket, pluginChallenge: string) {
    this.socket = socket
    this.pluginChallenge = pluginChallenge
    socket.on('data', (chunk) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk])
      this.#drain()
    })
  }

  static async connect(endpoint: string, pluginChallenge = 'plugin-challenge'): Promise<RawPluginPeer> {
    const socket = createConnection(endpoint)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    return new RawPluginPeer(socket, pluginChallenge)
  }

  get connected(): boolean {
    return !this.socket.destroyed && this.socket.writable
  }

  async send(message: IpcMessage): Promise<void> {
    this.#seq += 1
    const frame = encodeFrame({ ...message, v: 1, seq: this.#seq })
    await new Promise<void>((resolve, reject) => {
      this.socket.write(frame, (error) => (error ? reject(error) : resolve()))
    })
  }

  async hello(windowInstanceId: string, isMainWindow: boolean): Promise<void> {
    await this.send({
      v: 1,
      seq: 0,
      type: 'plugin_hello',
      window_instance_id: windowInstanceId,
      is_main_window: isMainWindow,
      plugin_challenge: this.pluginChallenge,
    })
  }

  async pairingDecision(
    harness: GatewayHarness,
    windowInstanceId: string,
    approved = true,
    companionChallengeOverride?: string,
  ): Promise<void> {
    const companionChallenge = companionChallengeOverride ?? this.companionChallenge
    if (!companionChallenge) {
      throw new Error('missing companion challenge')
    }
    const response = approved
      ? createPairingResponse(harness.pairingNonce, {
          endpoint: harness.endpoint,
          pid: harness.pid,
          protocolVersion: 1,
          companionChallenge,
          pluginChallenge: this.pluginChallenge,
          windowInstanceId,
        })
      : '0000000000000000000000000000000000000000000000000000000000000000'
    await this.send({
      v: 1,
      seq: 0,
      type: 'pairing_decision',
      window_instance_id: windowInstanceId,
      approved,
      response,
    })
  }

  async waitForMessage(
    type: IpcMessage['type'],
    timeoutMs = 5_000,
  ): Promise<IpcMessage> {
    const start = Date.now()
    while (true) {
      const found = this.inbound.find((message) => message.type === type)
      if (found) {
        return found
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting for ${type}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  close(): void {
    this.socket.destroy()
  }

  #drain(): void {
    while (this.#buffer.byteLength >= 4) {
      const frameLength = this.#buffer.readUInt32BE(0)
      if (this.#buffer.byteLength < frameLength + 4) {
        return
      }
      const body = this.#buffer.subarray(4, frameLength + 4)
      this.#buffer = this.#buffer.subarray(frameLength + 4)
      const message = JSON.parse(body.toString('utf8')) as IpcMessage
      this.inbound.push(message)
      if (message.type === 'companion_challenge') {
        this.companionChallenge = message.companion_challenge
      }
      if (message.type === 'rpc_request' && this.autoListRpc) {
        void this.send({
          v: 1,
          seq: 0,
          type: 'rpc_result',
          request_id: message.request_id,
          lease_epoch: message.lease_epoch,
          ok: true,
          result: { profiles: [] },
        })
      }
    }
  }
}
