import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'

import {
  createRuntimePaths,
  runtimeDescriptorSchema,
  verifyPairingResponse,
  writeRuntimeDescriptor,
  type PairingTranscript,
} from '../src/index.js'

const validNonce = () => Buffer.alloc(32, 0x11).toString('base64url')

const transcript: PairingTranscript = {
  endpoint: '/run/user/1000/tabby-secure-mcp/companion.sock',
  pid: 1234,
  protocolVersion: 1,
  companionChallenge: 'companion-challenge',
  pluginChallenge: 'plugin-challenge',
  windowInstanceId: 'window-1',
}

describe('runtime descriptor validation', () => {
  it('requires pairing_nonce to decode from base64url to exactly 32 bytes', () => {
    expect(
      runtimeDescriptorSchema.safeParse({
        protocol_version: 1,
        endpoint: '/tmp/sock',
        pid: 1,
        expires_at: Date.now() + 60_000,
        pairing_nonce: validNonce(),
      }).success,
    ).toBe(true)

    expect(
      runtimeDescriptorSchema.safeParse({
        protocol_version: 1,
        endpoint: '/tmp/sock',
        pid: 1,
        expires_at: Date.now() + 60_000,
        pairing_nonce: Buffer.alloc(16).toString('base64url'),
      }).success,
    ).toBe(false)
    expect(
      runtimeDescriptorSchema.safeParse({
        protocol_version: 1,
        endpoint: '/tmp/sock',
        pid: 1,
        expires_at: Date.now() + 60_000,
        pairing_nonce: 'not-base64url!!!',
      }).success,
    ).toBe(false)
  })

  it('rejects invalid endpoint, pid, version, and expiry before writing', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'tabby-descriptor-test-'))
    const paths = createRuntimePaths({
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: parent },
      homedir: () => parent,
      tmpdir: () => parent,
      randomBytes: () => Buffer.alloc(8),
    })

    await expect(
      writeRuntimeDescriptor(
        paths,
        {
          protocol_version: 1,
          endpoint: '',
          pid: 1,
          expires_at: Date.now() + 60_000,
          pairing_nonce: validNonce(),
        },
        { platform: 'linux' },
      ),
    ).rejects.toThrow(/descriptor/i)

    await expect(
      writeRuntimeDescriptor(
        paths,
        {
          protocol_version: 1,
          endpoint: paths.endpoint,
          pid: 0,
          expires_at: Date.now() + 60_000,
          pairing_nonce: validNonce(),
        },
        { platform: 'linux' },
      ),
    ).rejects.toThrow(/descriptor/i)
  })
})

describe('pairing nonce verification boundaries', () => {
  it('returns false for malformed or wrong-length nonces before HMAC comparison', () => {
    const response = 'a'.repeat(64)
    expect(verifyPairingResponse('short', transcript, response)).toBe(false)
    expect(verifyPairingResponse(Buffer.alloc(16).toString('base64url'), transcript, response)).toBe(
      false,
    )
    expect(verifyPairingResponse('%%%', transcript, response)).toBe(false)
  })
})
