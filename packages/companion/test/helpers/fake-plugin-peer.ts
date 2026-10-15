import { createConnection, type Socket } from 'node:net'
import { readFile } from 'node:fs/promises'

import {
  encodeFrame,
  type IpcMessage,
  type OperationalRequest,
  type RpcResult,
} from '@tabby-secure-mcp/ipc-contract'

import {
  createPairingResponse,
  type RuntimeDescriptor,
} from '../../src/index.js'

export interface FakePluginPeerOptions {
  runtimeDirectory: string
  descriptorPath: string
  windowInstanceId: string
  isMainWindow: boolean
  pairingNonce: string
  pid: number
  endpoint: string
  approvePairing?: boolean
  onRpc?: (
    request: OperationalRequest,
    context: { requestId: string; leaseEpoch: number },
  ) => Omit<RpcResult, 'v' | 'seq'> | Promise<Omit<RpcResult, 'v' | 'seq'>>
  sendCoalesced?: boolean
  delayMs?: number
}

export class FakePluginPeer {
  readonly socket: Socket
  #buffer = Buffer.alloc(0)
  #seq = 0
  #leaseEpoch = 0
  #companionChallenge?: string
  #pluginChallenge = `plugin-${Math.random().toString(16).slice(2)}`
  readonly messages: IpcMessage[] = []

  private constructor(
    socket: Socket,
    private readonly options: FakePluginPeerOptions,
  ) {
    this.socket = socket
    socket.on('data', (chunk) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk])
      this.#drain()
    })
  }

  static async connect(options: FakePluginPeerOptions): Promise<FakePluginPeer> {
    const descriptor = JSON.parse(
      await readFile(options.descriptorPath, 'utf8'),
    ) as RuntimeDescriptor
    const socket = createConnection(descriptor.endpoint)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    const peer = new FakePluginPeer(socket, { ...options, endpoint: descriptor.endpoint })
    await peer.#send({
      v: 1,
      seq: 0,
      type: 'plugin_hello',
      window_instance_id: options.windowInstanceId,
      is_main_window: options.isMainWindow,
      plugin_challenge: peer.#pluginChallenge,
    })
    return peer
  }

  async waitForCancel(timeoutMs = 5_000): Promise<void> {
    const start = Date.now()
    while (!this.messages.some((message) => message.type === 'cancel_request')) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('timed out waiting for cancel_request')
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  async waitForLease(timeoutMs = 5_000): Promise<number> {
    const start = Date.now()
    while (this.#leaseEpoch === 0) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('timed out waiting for lease_granted')
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return this.#leaseEpoch
  }

  close(): void {
    this.socket.end()
    this.socket.destroy()
  }

  async #send(message: IpcMessage): Promise<void> {
    this.#seq += 1
    const frame = encodeFrame({ ...message, v: 1, seq: this.#seq })
    if (this.options.sendCoalesced) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs ?? 0))
      this.socket.write(frame)
      return
    }
    for (const byte of frame) {
      this.socket.write(Buffer.from([byte]))
      if (this.options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.options.delayMs))
      }
    }
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
      this.messages.push(message)
      void this.#handle(message)
    }
  }

  async #handle(message: IpcMessage): Promise<void> {
    if (message.type === 'companion_challenge') {
      this.#companionChallenge = message.companion_challenge
      const approved = this.options.approvePairing ?? true
      const response = approved
        ? createPairingResponse(this.options.pairingNonce, {
            endpoint: this.options.endpoint,
            pid: this.options.pid,
            protocolVersion: 1,
            companionChallenge: this.#companionChallenge,
            pluginChallenge: this.#pluginChallenge,
            windowInstanceId: this.options.windowInstanceId,
          })
        : '0000000000000000000000000000000000000000000000000000000000000000'
      await this.#send({
        v: 1,
        seq: 0,
        type: 'pairing_decision',
        window_instance_id: this.options.windowInstanceId,
        approved,
        response,
      })
      return
    }

    if (message.type === 'lease_granted') {
      this.#leaseEpoch = message.lease_epoch
      return
    }

    if (message.type === 'rpc_request' && this.options.onRpc) {
      const result = await this.options.onRpc(message.request, {
        requestId: message.request_id,
        leaseEpoch: message.lease_epoch,
      })
      await this.#send({ v: 1, seq: 0, ...result })
    }
  }
}
