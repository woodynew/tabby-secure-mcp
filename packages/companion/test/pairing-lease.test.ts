import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'

import {
  LeaseManager,
  canonicalPairingTranscript,
  createPairingNonce,
  createPairingResponse,
  verifyPairingResponse,
  type PairingTranscript,
} from '../src/index.js'

const transcript: PairingTranscript = {
  endpoint: '/run/user/1000/tabby-secure-mcp/companion.sock',
  pid: 1234,
  protocolVersion: 1,
  companionChallenge: 'companion-challenge',
  pluginChallenge: 'plugin-challenge',
  windowInstanceId: 'window-1',
}

describe('pairing helpers', () => {
  it('requests exactly 32 random bytes for the descriptor nonce', () => {
    const randomBytes = vi.fn(() => Buffer.alloc(32, 0xab))
    const nonce = createPairingNonce(randomBytes)

    expect(randomBytes).toHaveBeenCalledWith(32)
    expect(Buffer.from(nonce, 'base64url')).toHaveLength(32)
  })

  it('uses a stable canonical transcript and verifies HMAC-SHA256 responses', () => {
    const nonce = Buffer.alloc(32, 0x42).toString('base64url')
    expect(canonicalPairingTranscript(transcript)).toBe(
      '["tabby-secure-mcp-pairing-v1","/run/user/1000/tabby-secure-mcp/companion.sock",1234,1,"companion-challenge","plugin-challenge","window-1"]',
    )

    const response = createPairingResponse(nonce, transcript)
    expect(response).toMatch(/^[a-f0-9]{64}$/)
    expect(verifyPairingResponse(nonce, transcript, response)).toBe(true)
  })

  it('rejects a tampered transcript or response', () => {
    const nonce = Buffer.alloc(32, 0x42).toString('base64url')
    const response = createPairingResponse(nonce, transcript)

    expect(
      verifyPairingResponse(nonce, { ...transcript, endpoint: '/tmp/attacker.sock' }, response),
    ).toBe(false)
    expect(
      verifyPairingResponse(
        nonce,
        { ...transcript, pluginChallenge: 'tampered' },
        response,
      ),
    ).toBe(false)
    expect(verifyPairingResponse(nonce, transcript, `0${response.slice(1)}`)).toBe(false)
  })
})

describe('LeaseManager', () => {
  it('prefers the main window and maintains one holder with standby peers', () => {
    const leases = new LeaseManager()
    leases.registerWindow({ windowInstanceId: 'secondary', isMainWindow: false })
    leases.registerWindow({ windowInstanceId: 'main', isMainWindow: true })
    leases.registerWindow({ windowInstanceId: 'secondary-2', isMainWindow: false })

    expect(leases.getPreferredPairingCandidate()?.windowInstanceId).toBe('main')
    const lease = leases.pairAndGrant('main')
    expect(lease).toEqual({ windowInstanceId: 'main', leaseEpoch: 1 })
    expect(leases.holder).toEqual(lease)
    expect(leases.standbyWindowIds).toEqual(['secondary', 'secondary-2'])
    expect(() => leases.pairAndGrant('secondary')).toThrow(/holder/i)
  })

  it('cancels pending work, increments epoch and requires a fresh pairing after disconnect', () => {
    const leases = new LeaseManager()
    leases.registerWindow({ windowInstanceId: 'main', isMainWindow: true })
    leases.registerWindow({ windowInstanceId: 'standby', isMainWindow: false })
    const first = leases.pairAndGrant('main')
    const cancelled = vi.fn()
    leases.trackPending({
      requestId: 'request-1',
      windowInstanceId: 'main',
      leaseEpoch: first.leaseEpoch,
      onCancel: cancelled,
    })

    const revoked = leases.disconnectWindow('main')

    expect(revoked).toEqual({ windowInstanceId: 'main', leaseEpoch: 2 })
    expect(cancelled).toHaveBeenCalledWith('cancelled')
    expect(leases.holder).toBeUndefined()
    expect(leases.epoch).toBe(2)
    expect(leases.getPreferredPairingCandidate()?.windowInstanceId).toBe('standby')
    expect(leases.holder).toBeUndefined()

    const replacement = leases.pairAndGrant('standby')
    expect(replacement.leaseEpoch).toBe(3)
  })

  it('leaves holder and epoch unchanged when a standby window disconnects', () => {
    const leases = new LeaseManager()
    leases.registerWindow({ windowInstanceId: 'main', isMainWindow: true })
    leases.registerWindow({ windowInstanceId: 'standby', isMainWindow: false })
    const grant = leases.pairAndGrant('main')

    const revoked = leases.disconnectWindow('standby')

    expect(revoked).toEqual({ windowInstanceId: 'standby', leaseEpoch: grant.leaseEpoch })
    expect(leases.holder).toEqual(grant)
    expect(leases.epoch).toBe(grant.leaseEpoch)
  })

  it('disconnectWindowIfConnected is idempotent for already disconnected windows', () => {
    const leases = new LeaseManager()
    leases.registerWindow({ windowInstanceId: 'main', isMainWindow: true })
    leases.pairAndGrant('main')
    leases.disconnectWindowIfConnected('main')
    leases.disconnectWindowIfConnected('main')
    expect(leases.getPreferredPairingCandidate()).toBeUndefined()
  })

  it('rejects pending work from a standby or stale epoch', () => {
    const leases = new LeaseManager()
    leases.registerWindow({ windowInstanceId: 'main', isMainWindow: true })
    leases.registerWindow({ windowInstanceId: 'standby', isMainWindow: false })
    const lease = leases.pairAndGrant('main')

    expect(() =>
      leases.trackPending({
        requestId: 'standby-request',
        windowInstanceId: 'standby',
        leaseEpoch: lease.leaseEpoch,
        onCancel: () => undefined,
      }),
    ).toThrow(/lease/i)
    expect(() =>
      leases.trackPending({
        requestId: 'stale-request',
        windowInstanceId: 'main',
        leaseEpoch: lease.leaseEpoch + 1,
        onCancel: () => undefined,
      }),
    ).toThrow(/lease/i)
  })
})
