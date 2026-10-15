import { Buffer } from 'node:buffer'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { startGatewayHarness } from '../../companion/test/helpers/gateway-harness.js'
import { AuditService } from '../src/audit/audit-service'
import { ApprovalGatekeeper } from '../src/approval/approval-gatekeeper'
import type { ApprovalPresenter } from '../src/approval/approval-presenter'
import { SystemApprovalScheduler } from '../src/approval/approval-scheduler'
import type { MonotonicClock } from '../src/approval/monotonic-clock'
import { PluginRuntimeService } from '../src/runtime/plugin-runtime-service'
import { createPairingResponse } from '../src/runtime/pairing'
import { RuntimeLeaseState } from '../src/runtime/runtime-lease-state'
import { AuthorizedProfilesService } from '../src/services/authorized-profiles.service'

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})

class FakeClock implements MonotonicClock {
  now(): number {
    return 0
  }
}

class AllowPresenter implements ApprovalPresenter {
  async presentPairing() {
    return 'allow' as const
  }
  async presentOpen() {
    return 'allow' as const
  }
}

function descriptorFs(descriptorPath: string, body: string) {
  return {
    async stat(filePath: string) {
      if (filePath !== descriptorPath) {
        throw new Error('missing')
      }
      return { isSymbolicLink: () => false, size: body.length }
    },
    async readFile(filePath: string) {
      if (filePath !== descriptorPath) {
        throw new Error('missing')
      }
      return body
    },
  }
}

function createRuntime(options: {
  descriptorPath: string
  descriptorBody: string
  gatekeeper?: ApprovalGatekeeper
  authorizedProfiles?: AuthorizedProfilesService
  isMainWindow?: boolean
  timers?: { schedule(delayMs: number, callback: () => void): { cancel(): void } }
}) {
  const leaseState = new RuntimeLeaseState()
  const audit = new AuditService({ logPath: path.join(tmpdir(), `audit-${Math.random()}.jsonl`) })
  const authorizedProfiles =
    options.authorizedProfiles ??
    ({
      listAuthorizedProfiles: vi.fn(async () => []),
      clearRefCache: vi.fn(),
    } as unknown as AuthorizedProfilesService)
  const gatekeeper =
    options.gatekeeper ??
    new ApprovalGatekeeper(
      authorizedProfiles,
      { getProfiles: vi.fn(), openNewTabForProfile: vi.fn() } as never,
      new AllowPresenter(),
      new FakeClock(),
      () => leaseState.getLeaseEpoch(),
      new SystemApprovalScheduler(),
    )

  const runtime = new PluginRuntimeService(
    () => ({ isMainWindow: options.isMainWindow ?? true, windowId: '1' }),
    leaseState,
    gatekeeper,
    authorizedProfiles,
    audit,
    {
      platform: 'linux',
      descriptorPaths: { descriptorPath: options.descriptorPath },
      fs: descriptorFs(options.descriptorPath, options.descriptorBody),
      timers: options.timers ?? {
        schedule: (delayMs, callback) => {
          const handle = setTimeout(callback, delayMs)
          return { cancel: () => clearTimeout(handle) }
        },
      },
      reconnectDelayMs: 5,
      isProcessAlive: () => true,
      random: {
        randomBytes: (size) => Buffer.alloc(size, 3),
        randomId: () => 'window-instance-1',
      },
    },
  )
  return { runtime, leaseState, authorizedProfiles, gatekeeper }
}

describe('PluginRuntimeService', () => {
  it('pairs with canonical HMAC and becomes lease holder', async () => {
    const harness = await startGatewayHarness()
    closers.push(() => harness.close())
    const base = await mkdtemp(path.join(tmpdir(), 'plugin-rt-'))
    const descriptorPath = path.join(base, 'descriptor.json')
    const descriptorBody = `${JSON.stringify({
      protocol_version: 1,
      endpoint: harness.endpoint,
      pid: harness.pid,
      expires_at: Date.now() + 60_000,
      pairing_nonce: harness.pairingNonce,
    })}\n`
    await writeFile(descriptorPath, descriptorBody)

    const { runtime, leaseState } = createRuntime({ descriptorPath, descriptorBody })
    runtime.start()

    await vi.waitFor(
      () => {
        expect(leaseState.getLeaseEpoch()).not.toBeNull()
      },
      { timeout: 5_000 },
    )
    expect(runtime.isHolder()).toBe(true)

    const transcript = {
      endpoint: harness.endpoint,
      pid: harness.pid,
      protocolVersion: 1,
      companionChallenge: 'unused',
      pluginChallenge: 'unused',
      windowInstanceId: 'window-instance-1',
    }
    expect(
      createPairingResponse(harness.pairingNonce, {
        ...transcript,
        companionChallenge: 'a',
        pluginChallenge: 'b',
      }),
    ).toMatch(/^[a-f0-9]{64}$/)

    runtime.destroy()
  })

  it('lists only strict DTO fields for authorized profiles', async () => {
    const harness = await startGatewayHarness()
    closers.push(() => harness.close())
    const base = await mkdtemp(path.join(tmpdir(), 'plugin-rt-'))
    const descriptorPath = path.join(base, 'descriptor.json')
    const descriptorBody = `${JSON.stringify({
      protocol_version: 1,
      endpoint: harness.endpoint,
      pid: harness.pid,
      expires_at: Date.now() + 60_000,
      pairing_nonce: harness.pairingNonce,
    })}\n`

    const list = vi.fn(async () => [
      { profile_ref: 'ffffffffffffffffffffffffffffffff', display_name: 'Safe' },
    ])
    const { runtime } = createRuntime({
      descriptorPath,
      descriptorBody,
      authorizedProfiles: { listAuthorizedProfiles: list, clearRefCache: vi.fn() } as never,
    })
    runtime.start()
    await vi.waitFor(
      () => {
        expect(runtime.isHolder()).toBe(true)
      },
      { timeout: 5_000 },
    )

    const result = await harness.gateway.call({
      method: 'list_authorized_ssh_profiles',
      params: {},
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result).toEqual({
        profiles: [{ profile_ref: 'ffffffffffffffffffffffffffffffff', display_name: 'Safe' }],
      })
      expect(JSON.stringify(result.result)).not.toMatch(/password|secret/)
    }
    runtime.destroy()
  })

  it('cancels reconnect timer on destroy', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'plugin-rt-'))
    const descriptorPath = path.join(base, 'missing.json')
    const cancelled = vi.fn()
    const timers = {
      schedule: (_delay: number, cb: () => void) => {
        const handle = setTimeout(cb, 20)
        return {
          cancel: () => {
            cancelled()
            clearTimeout(handle)
          },
        }
      },
    }
    const { runtime } = createRuntime({
      descriptorPath,
      descriptorBody: '{}',
      timers,
    })
    runtime.start()
    runtime.destroy()
    expect(cancelled).toHaveBeenCalled()
  })
})
