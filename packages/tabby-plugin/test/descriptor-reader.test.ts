import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'

import { readRuntimeDescriptor, type DescriptorFileSystem } from '../src/runtime/descriptor-reader'

const VALID_NONCE = Buffer.alloc(32, 7).toString('base64url')

function fsWith(content: string, options: { symlink?: boolean; size?: number } = {}): DescriptorFileSystem {
  return {
    async stat() {
      return {
        isSymbolicLink: () => options.symlink ?? false,
        size: options.size ?? Buffer.byteLength(content, 'utf8'),
      }
    },
    async readFile() {
      return content
    },
  }
}

describe('readRuntimeDescriptor', () => {
  const endpoint = '/run/user/1000/tabby-secure-mcp/companion.sock'

  it('rejects symlinks, oversize files, expiry, bad nonce, and forbidden endpoints', async () => {
    await expect(
      readRuntimeDescriptor('/d.json', fsWith('{}', { symlink: true }), { platform: 'linux' }),
    ).resolves.toMatchObject({ ok: false, code: 'symlink' })

    await expect(
      readRuntimeDescriptor('/d.json', fsWith('x'.repeat(5000), { size: 5000 }), {
        platform: 'linux',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'oversize' })

    const expired = JSON.stringify({
      protocol_version: 1,
      endpoint,
      pid: 1,
      expires_at: 1,
      pairing_nonce: VALID_NONCE,
    })
    await expect(
      readRuntimeDescriptor('/d.json', fsWith(expired), { nowMs: 2, platform: 'linux' }),
    ).resolves.toMatchObject({ ok: false, code: 'expired' })

    const badNonce = JSON.stringify({
      protocol_version: 1,
      endpoint,
      pid: 1,
      expires_at: Date.now() + 60_000,
      pairing_nonce: 'short',
    })
    await expect(
      readRuntimeDescriptor('/d.json', fsWith(badNonce), { platform: 'linux' }),
    ).resolves.toMatchObject({ ok: false, code: 'invalid' })

    const tcp = JSON.stringify({
      protocol_version: 1,
      endpoint: 'tcp://127.0.0.1:9999',
      pid: 1,
      expires_at: Date.now() + 60_000,
      pairing_nonce: VALID_NONCE,
    })
    await expect(
      readRuntimeDescriptor('/d.json', fsWith(tcp), { platform: 'linux' }),
    ).resolves.toMatchObject({ ok: false, code: 'endpoint_forbidden' })
  })

  it('accepts a valid unix descriptor', async () => {
    const body = JSON.stringify({
      protocol_version: 1,
      endpoint,
      pid: 42,
      expires_at: Date.now() + 60_000,
      pairing_nonce: VALID_NONCE,
    })
    const result = await readRuntimeDescriptor('/d.json', fsWith(body), { platform: 'linux' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.descriptor.endpoint).toBe(endpoint)
    }
  })
})
