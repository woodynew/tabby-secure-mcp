import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'

import {
  IpcFrameDecoder,
  MAX_BUFFER_BYTES,
  MAX_FRAME_BYTES,
  encodeFrame,
  type IpcMessage,
} from '../src/index.js'

function rawFrame(body: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(4 + body.byteLength)
  frame.writeUInt32BE(body.byteLength, 0)
  body.copy(frame, 4)
  return frame
}

function challenge(seq: number): IpcMessage {
  return {
    v: 1,
    type: 'companion_challenge',
    seq,
    companion_challenge: `challenge-${seq}`,
  }
}

describe('IPC framing boundaries', () => {
  it('rejects encodeFrame when the serialized body exceeds MAX_FRAME_BYTES', () => {
    const profiles = Array.from({ length: 400 }, (_, index) => ({
      profile_ref: `profile-${index}`,
      display_name: 'x'.repeat(256),
    }))
    const message: IpcMessage = {
      v: 1,
      type: 'rpc_result',
      seq: 1,
      request_id: 'request-1',
      lease_epoch: 1,
      ok: true,
      result: { profiles },
    }
    expect(() => encodeFrame(message)).toThrow(/frame.*large/i)
  })

  it('decodes a frame whose body length is exactly MAX_FRAME_BYTES', () => {
    const profiles: Array<{ profile_ref: string; display_name: string }> = []
    const serialize = () =>
      Buffer.from(
        JSON.stringify({
          v: 1,
          type: 'rpc_result',
          seq: 1,
          request_id: 'request-1',
          lease_epoch: 1,
          ok: true,
          result: { profiles },
        }),
        'utf8',
      )

    let body = serialize()
    while (body.byteLength < MAX_FRAME_BYTES) {
      profiles.push({ profile_ref: `ref-${profiles.length}`, display_name: 'a' })
      const next = serialize()
      if (next.byteLength > MAX_FRAME_BYTES) {
        profiles.pop()
        break
      }
      body = next
      if (body.byteLength === MAX_FRAME_BYTES) {
        break
      }
    }

    const last = profiles.at(-1)
    if (last && body.byteLength !== MAX_FRAME_BYTES) {
      let low = 1
      let high = 256
      while (low <= high) {
        const mid = Math.floor((low + high) / 2)
        last.display_name = 'a'.repeat(mid)
        const candidate = serialize()
        if (candidate.byteLength === MAX_FRAME_BYTES) {
          body = candidate
          break
        }
        if (candidate.byteLength < MAX_FRAME_BYTES) {
          low = mid + 1
        } else {
          high = mid - 1
        }
      }
    }

    expect(body.byteLength).toBe(MAX_FRAME_BYTES)

    const decoder = new IpcFrameDecoder()
    const messages = decoder.push(rawFrame(body))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ type: 'rpc_result', ok: true })
  })

  it('closes when accumulated buffered bytes would exceed MAX_BUFFER_BYTES', () => {
    const decoder = new IpcFrameDecoder()
    const header = Buffer.alloc(4)
    header.writeUInt32BE(4096)
    decoder.push(header)
    decoder.push(Buffer.alloc(100))

    expect(() => decoder.push(Buffer.alloc(MAX_BUFFER_BYTES))).toThrow(/buffer.*large/i)
    expect(decoder.closed).toBe(true)
  })

  it('rejects a zero-length frame body and invalid UTF-8 payloads', () => {
    expect(() => new IpcFrameDecoder().push(rawFrame(Buffer.alloc(0)))).toThrow(/json/i)

    const invalidUtf8 = Buffer.from([0xff, 0xfe, 0xfd])
    expect(() => new IpcFrameDecoder().push(rawFrame(invalidUtf8))).toThrow(/json/i)
  })
})
