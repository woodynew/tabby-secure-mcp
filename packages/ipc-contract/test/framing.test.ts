import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'

import {
  IpcFrameDecoder,
  MAX_BUFFER_BYTES,
  MAX_FRAME_BYTES,
  encodeFrame,
} from '../src/index.js'

function challenge(seq: number) {
  return {
    v: 1 as const,
    type: 'companion_challenge' as const,
    seq,
    companion_challenge: `challenge-${seq}`,
  }
}

function rawFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(body.byteLength)
  return Buffer.concat([header, body])
}

describe('IPC framing', () => {
  it('encodes a four-byte big-endian length followed by UTF-8 JSON', () => {
    const frame = encodeFrame(challenge(1))
    expect(frame.readUInt32BE(0)).toBe(frame.byteLength - 4)
    expect(JSON.parse(frame.subarray(4).toString('utf8'))).toEqual(challenge(1))
  })

  it('decodes fragmented and coalesced frames', () => {
    const first = encodeFrame(challenge(1))
    const second = encodeFrame(challenge(2))
    const decoder = new IpcFrameDecoder()

    expect(decoder.push(first.subarray(0, 2))).toEqual([])
    expect(decoder.push(first.subarray(2))).toEqual([challenge(1)])
    expect(decoder.push(Buffer.concat([second, encodeFrame(challenge(3))]))).toEqual([
      challenge(2),
      challenge(3),
    ])
  })

  it('closes on oversized frames and buffered input', () => {
    const oversizedHeader = Buffer.alloc(4)
    oversizedHeader.writeUInt32BE(MAX_FRAME_BYTES + 1)
    const frameDecoder = new IpcFrameDecoder()
    expect(() => frameDecoder.push(oversizedHeader)).toThrow(/frame.*large/i)
    expect(frameDecoder.closed).toBe(true)

    const bufferDecoder = new IpcFrameDecoder()
    expect(() => bufferDecoder.push(Buffer.alloc(MAX_BUFFER_BYTES + 1))).toThrow(/buffer.*large/i)
    expect(bufferDecoder.closed).toBe(true)
  })

  it('closes on malformed JSON, invalid schemas and dangerous keys', () => {
    const malformedBody = Buffer.from('{', 'utf8')
    const malformed = Buffer.alloc(5)
    malformed.writeUInt32BE(malformedBody.byteLength)
    malformedBody.copy(malformed, 4)
    expect(() => new IpcFrameDecoder().push(malformed)).toThrow(/json/i)

    expect(() =>
      new IpcFrameDecoder().push(rawFrame({ ...challenge(1), unknown: true })),
    ).toThrow(/schema/i)

    const dangerous = `{"v":1,"type":"rpc_result","seq":1,"request_id":"r","lease_epoch":1,"ok":true,"result":{"__proto__":{"polluted":true}}}`
    const dangerousBody = Buffer.from(dangerous, 'utf8')
    const dangerousFrame = Buffer.alloc(4 + dangerousBody.byteLength)
    dangerousFrame.writeUInt32BE(dangerousBody.byteLength)
    dangerousBody.copy(dangerousFrame, 4)
    expect(() => new IpcFrameDecoder().push(dangerousFrame)).toThrow(/schema/i)
  })

  it('requires strictly increasing incoming sequences', () => {
    const decoder = new IpcFrameDecoder()
    expect(decoder.push(encodeFrame(challenge(2)))).toEqual([challenge(2)])
    expect(() => decoder.push(encodeFrame(challenge(2)))).toThrow(/sequence/i)

    const decreasing = new IpcFrameDecoder()
    decreasing.push(encodeFrame(challenge(3)))
    expect(() => decreasing.push(encodeFrame(challenge(2)))).toThrow(/sequence/i)
  })

  it('supports explicit close and clean reset', () => {
    const decoder = new IpcFrameDecoder()
    decoder.push(encodeFrame(challenge(5)))
    decoder.close()
    expect(decoder.closed).toBe(true)
    expect(() => decoder.push(encodeFrame(challenge(6)))).toThrow(/closed/i)

    decoder.reset()
    expect(decoder.closed).toBe(false)
    expect(decoder.push(encodeFrame(challenge(1)))).toEqual([challenge(1)])
  })
})
