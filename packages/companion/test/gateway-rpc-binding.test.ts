import { afterEach, describe, expect, it } from 'vitest'

import { RawPluginPeer, startGatewayHarness } from './helpers/gateway-harness.js'

const harnesses: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((close) => close()))
})

describe('PluginGateway RPC reply binding', () => {
  it('ignores standby rpc_result and keeps the holder request pending', async () => {
    const harness = await startGatewayHarness()
    harnesses.push(() => harness.close())

    const standby = await RawPluginPeer.connect(harness.endpoint, 'standby-challenge')
    await standby.hello('standby', false)
    await standby.waitForMessage('companion_challenge')

    const holder = await RawPluginPeer.connect(harness.endpoint, 'main-challenge')
    await holder.hello('main', true)
    await holder.waitForMessage('companion_challenge')
    await standby.pairingDecision(harness, 'standby')
    await holder.pairingDecision(harness, 'main')
    await holder.waitForMessage('lease_granted')

    const callPromise = harness.gateway.call(
      { method: 'list_authorized_ssh_profiles', params: {} },
      { deadlineMs: 60_000 },
    )

    let forgedRequestId = 'forged-request-id'
    await standby.send({
      v: 1,
      seq: 50,
      type: 'rpc_result',
      request_id: forgedRequestId,
      lease_epoch: 1,
      ok: true,
      result: { profiles: [{ profile_ref: 'evil', display_name: 'Evil' }] },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(standby.connected).toBe(false)

    let settledEarly = false
    void callPromise.then(() => {
      settledEarly = true
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(settledEarly).toBe(false)

    const rpc = await holder.waitForMessage('rpc_request')
    await holder.send({
      v: 1,
      seq: 0,
      type: 'rpc_result',
      request_id: rpc.request_id,
      lease_epoch: rpc.lease_epoch,
      ok: true,
      result: { profiles: [] },
    })
    const result = await callPromise
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result).toEqual({ profiles: [] })
    }
  }, 15_000)

  it('grants standby after a failed main pairing clears the dead main candidate', async () => {
    const harness = await startGatewayHarness()
    harnesses.push(() => harness.close())

    const standby = await RawPluginPeer.connect(harness.endpoint, 'standby-challenge')
    await standby.hello('standby', false)
    await standby.waitForMessage('companion_challenge')

    const main = await RawPluginPeer.connect(harness.endpoint, 'main-challenge')
    await main.hello('main', true)
    await main.waitForMessage('companion_challenge')
    await main.pairingDecision(harness, 'main', false)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(main.connected).toBe(false)

    await standby.pairingDecision(harness, 'standby')
    const grant = await standby.waitForMessage('lease_granted')
    expect(grant).toMatchObject({ lease_epoch: 1 })
  })
})
