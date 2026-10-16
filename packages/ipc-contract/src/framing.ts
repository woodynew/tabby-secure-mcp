import { Buffer } from 'node:buffer'
import { TextDecoder } from 'node:util'

import {
  MAX_BUFFER_BYTES,
  MAX_FRAME_BYTES,
  ipcMessageSchema,
  type IpcMessage,
} from './messages.js'

export type FrameProtocolErrorCode =
  | 'BUFFER_TOO_LARGE'
  | 'FRAME_TOO_LARGE'
  | 'MALFORMED_JSON'
  | 'INVALID_SCHEMA'
  | 'INVALID_SEQUENCE'
  | 'DECODER_CLOSED'

export class FrameProtocolError extends Error {
  constructor(
    readonly code: FrameProtocolErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'FrameProtocolError'
  }
}

export function encodeFrame(message: IpcMessage): Buffer {
  const parsed = ipcMessageSchema.safeParse(message)
  if (!parsed.success) {
    throw new FrameProtocolError('INVALID_SCHEMA', 'IPC message failed schema validation', {
      cause: parsed.error,
    })
  }
  const body = Buffer.from(JSON.stringify(parsed.data), 'utf8')
  if (body.byteLength > MAX_FRAME_BYTES) {
    throw new FrameProtocolError(
      'FRAME_TOO_LARGE',
      `IPC frame is too large (${body.byteLength} > ${MAX_FRAME_BYTES})`,
    )
  }
  const frame = Buffer.allocUnsafe(4 + body.byteLength)
  frame.writeUInt32BE(body.byteLength, 0)
  body.copy(frame, 4)
  return frame
}

export class IpcFrameDecoder {
  #buffer = Buffer.alloc(0)
  #lastSequence: number | undefined
  #closed = false

  get closed(): boolean {
    return this.#closed
  }

  push(chunk: Uint8Array): IpcMessage[] {
    if (this.#closed) {
      throw new FrameProtocolError('DECODER_CLOSED', 'IPC frame decoder is closed')
    }

    try {
      if (this.#buffer.byteLength + chunk.byteLength > MAX_BUFFER_BYTES) {
        throw new FrameProtocolError(
          'BUFFER_TOO_LARGE',
          `IPC buffer is too large (limit ${MAX_BUFFER_BYTES})`,
        )
      }
      this.#buffer = Buffer.concat([this.#buffer, chunk])
      const messages: IpcMessage[] = []

      while (this.#buffer.byteLength >= 4) {
        const frameLength = this.#buffer.readUInt32BE(0)
        if (frameLength > MAX_FRAME_BYTES) {
          throw new FrameProtocolError(
            'FRAME_TOO_LARGE',
            `IPC frame is too large (${frameLength} > ${MAX_FRAME_BYTES})`,
          )
        }
        if (this.#buffer.byteLength < frameLength + 4) {
          break
        }

        const body = this.#buffer.subarray(4, frameLength + 4)
        this.#buffer = this.#buffer.subarray(frameLength + 4)
        const message = this.#decodeBody(body)
        if (this.#lastSequence !== undefined && message.seq <= this.#lastSequence) {
          throw new FrameProtocolError(
            'INVALID_SEQUENCE',
            `IPC sequence must increase (received ${message.seq} after ${this.#lastSequence})`,
          )
        }
        this.#lastSequence = message.seq
        messages.push(message)
      }

      return messages
    } catch (error) {
      this.close()
      throw error
    }
  }

  close(): void {
    this.#buffer = Buffer.alloc(0)
    this.#lastSequence = undefined
    this.#closed = true
  }

  reset(): void {
    this.#buffer = Buffer.alloc(0)
    this.#lastSequence = undefined
    this.#closed = false
  }

  #decodeBody(body: Uint8Array): IpcMessage {
    let value: unknown
    try {
      const json = new TextDecoder('utf-8', { fatal: true }).decode(body)
      value = JSON.parse(json)
    } catch (error) {
      throw new FrameProtocolError('MALFORMED_JSON', 'IPC frame contains malformed JSON', {
        cause: error,
      })
    }

    const parsed = ipcMessageSchema.safeParse(value)
    if (!parsed.success) {
      throw new FrameProtocolError('INVALID_SCHEMA', 'IPC message failed schema validation', {
        cause: parsed.error,
      })
    }
    return parsed.data
  }
}

export const FrameDecoder = IpcFrameDecoder
