import { afterEach, describe, expect, it, vi } from 'vitest'

import { LeaseManager } from '../src/index.js'
import { RawPluginPeer, startGatewayHarness } from './helpers/gateway-harness.js'

const harnesses: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((close) => close()))
})

describe('PluginGateway pairing lifecycle', () => {
  it('grants lease only to the preferred main window when both peers are connected', async () => {
    const harness = await startGatewayHarness()
    harnesses.push(() => harness.close())

    const standby = await RawPluginPeer.connect(harness.endpoint, 'standby-challenge')
    await standby.hello('standby', false)
    await standby.waitForMessage('companion_challenge')

    const main = await RawPluginPeer.connect(harness.endpoint, 'main-challenge')
    await main.hello('main', true)
    await main.waitForMessage('companion_challenge')

    await standby.pairingDecision(harness, 'standby')
    expect(standby.inbound.some((message) => message.type === 'lease_granted')).toBe(false)

    await main.pairingDecision(harness, 'main')
    const grant = await main.waitForMessage('lease_granted')
    expect(grant).toMatchObject({ lease_epoch: 1 })
    expect(standby.inbound.some((message) => message.type === 'lease_granted')).toBe(false)
  })

  it('disconnects all peers when the holder drops so stale pairing cannot replay', async () => {
    const harness = await startGatewayHarness()
    harnesses.push(() => harness.close())

    const main = await RawPluginPeer.connect(harness.endpoint, 'main-challenge')
    await main.hello('main', true)
    await main.waitForMessage('companion_challenge')
    const staleChallenge = main.companionChallenge
    await main.pairingDecision(harness, 'main')
    await main.waitForMessage('lease_granted')

    const standby = await RawPluginPeer.connect(harness.endpoint, 'standby-challenge')
    await standby.hello('standby', false)
    await standby.waitForMessage('companion_challenge')
    await standby.pairingDecision(harness, 'standby')

    main.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(standby.connected).toBe(false)

    const replay = await RawPluginPeer.connect(harness.endpoint, 'standby-challenge')
    await replay.hello('standby', false)
    await replay.waitForMessage('companion_challenge')
    await replay.pairingDecision(harness, 'standby', true, staleChallenge)
    expect(replay.inbound.some((message) => message.type === 'lease_granted')).toBe(false)
  })

  it('rejects duplicate window ids and out-of-order handshake messages', async () => {
    const harness = await startGatewayHarness()
    harnesses.push(() => harness.close())

    const first = await RawPluginPeer.connect(harness.endpoint)
    await first.hello('window-1', true)
    await first.waitForMessage('companion_challenge')

    const duplicate = await RawPluginPeer.connect(harness.endpoint)
    await duplicate.hello('window-1', true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(duplicate.connected).toBe(false)
    expect(first.connected).toBe(true)

    await first.pairingDecision(harness, 'window-1')
    await first.waitForMessage('lease_granted')
    await first.send({
      v: 1,
      seq: 9,
      type: 'pairing_decision',
      window_instance_id: 'window-1',
      approved: true,
      response: 'b'.repeat(64),
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(first.connected).toBe(false)
  })

  it('closes peers that do not finish handshake before the deadline', async () => {
    const harness = await startGatewayHarness({ handshakeTimeoutMs: 80 })
    harnesses.push(() => harness.close())

    const peer = await RawPluginPeer.connect(harness.endpoint)
    await peer.hello('slow', true)
    await peer.waitForMessage('companion_challenge')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(peer.connected).toBe(false)
  })

  it('destroys peers that send pairing_decision before plugin_hello', async () => {
    const harness = await startGatewayHarness({ handshakeTimeoutMs: 200 })
    harnesses.push(() => harness.close())

    const peer = await RawPluginPeer.connect(harness.endpoint)
    await peer.send({
      v: 1,
      seq: 1,
      type: 'pairing_decision',
      window_instance_id: 'early',
      approved: true,
      response: 'a'.repeat(64),
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(peer.connected).toBe(false)
  })

  it('returns busy when more than four gateway calls are in flight', async () => {
    const harness = await startGatewayHarness()
    harnesses.push(() => harness.close())

    const holder = await RawPluginPeer.connect(harness.endpoint)
    await holder.hello('main', true)
    await holder.waitForMessage('companion_challenge')
    await holder.pairingDecision(harness, 'main')
    await holder.waitForMessage('lease_granted')

    void Array.from({ length: 4 }, () =>
      harness.gateway.call(
        { method: 'list_authorized_ssh_profiles', params: {} },
        { deadlineMs: 60_000 },
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    const busy = await harness.gateway.call({
      method: 'list_authorized_ssh_profiles',
      params: {},
    })
    expect(busy).toEqual({ ok: false, code: 'busy' })
  })

  it('rate limits gateway calls after the burst budget is exhausted', async () => {
    const harness = await startGatewayHarness()
    harnesses.push(() => harness.close())

    const holder = await RawPluginPeer.connect(harness.endpoint)
    await holder.hello('main', true)
    await holder.waitForMessage('companion_challenge')
    await holder.pairingDecision(harness, 'main')
    await holder.waitForMessage('lease_granted')
    holder.autoListRpc = true

    const results = []
    for (let index = 0; index < 6; index += 1) {
      results.push(
        await harness.gateway.call({ method: 'list_authorized_ssh_profiles', params: {} }),
      )
    }
    expect(results.filter((result) => !result.ok && result.code === 'rate_limited').length).toBeGreaterThan(0)
  }, 15_000)
})

describe('LeaseManager pending tracking', () => {
  it('untracks pending requests when callers settle', () => {
    const leases = new LeaseManager()
    leases.registerWindow({ windowInstanceId: 'main', isMainWindow: true })
    const grant = leases.pairAndGrant('main')
    const onCancel = vi.fn()
    leases.trackPending({
      requestId: 'req-1',
      windowInstanceId: 'main',
      leaseEpoch: grant.leaseEpoch,
      onCancel,
    })
    leases.untrackPending('req-1')
    leases.disconnectWindow('main')
    expect(onCancel).not.toHaveBeenCalled()
  })
})
