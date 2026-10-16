import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createPluginGateway } from '../../companion/src/gateway/plugin-gateway.js'
import { createTestEndpoint } from '../../companion/test/helpers/gateway-harness.js'
import { createPairingNonce } from '../../companion/src/runtime/pairing.js'
import { AuditService } from '../src/audit/audit-service'
import { ApprovalGatekeeper } from '../src/approval/approval-gatekeeper'
import type { ApprovalPresenter } from '../src/approval/approval-presenter'
import { SystemApprovalScheduler } from '../src/approval/approval-scheduler'
import type { MonotonicClock } from '../src/approval/monotonic-clock'
import { PluginRuntimeService } from '../src/runtime/plugin-runtime-service'
import { RuntimeLeaseState } from '../src/runtime/runtime-lease-state'
import { AuthorizedProfilesService } from '../src/services/authorized-profiles.service'

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})

class AllowPresenter implements ApprovalPresenter {
  async presentPairing() {
    return 'allow' as const
  }
  async presentOpen() {
    return 'allow' as const
  }
}

class FakeClock implements MonotonicClock {
  now(): number {
    return 0
  }
}

describe('PluginRuntimeService integration', () => {
  it('lists authorized profiles without leaking secret fields over rpc_result', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'plugin-int-'))
    const endpoint = createTestEndpoint(base)
    if (process.platform !== 'win32') {
      await mkdir(path.dirname(endpoint), { recursive: true })
    }
    const pairingNonce = createPairingNonce(() => Buffer.alloc(32, 4))
    const gateway = createPluginGateway({ endpoint, pid: 9001, pairingNonce })
    await gateway.listen()
    closers.push(() => gateway.close())

    const descriptorPath = path.join(base, 'descriptor.json')
    await writeFile(
      descriptorPath,
      `${JSON.stringify({
        protocol_version: 1,
        endpoint,
        pid: 9001,
        expires_at: Date.now() + 60_000,
        pairing_nonce: pairingNonce,
      })}\n`,
    )

    const secretProfile = {
      id: 'allowed',
      type: 'ssh',
      name: 'Secret SSH',
      options: { host: 'secret-host', user: 'secret-user', password: 'hunter2' },
      isBuiltin: false,
      isTemplate: false,
    }
    const authorizedProfiles = {
      listAuthorizedProfiles: vi.fn(async () => [
        { profile_ref: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', display_name: 'Safe Name' },
      ]),
      resolveAuthorizedProfile: vi.fn(),
      clearRefCache: vi.fn(),
    } as unknown as AuthorizedProfilesService

    const leaseState = new RuntimeLeaseState()
    const gatekeeper = new ApprovalGatekeeper(
      authorizedProfiles,
      {
        getProfiles: vi.fn(async () => [secretProfile]),
        openNewTabForProfile: vi.fn(async () => ({})),
      } as never,
      new AllowPresenter(),
      new FakeClock(),
      () => leaseState.getLeaseEpoch(),
      new SystemApprovalScheduler(),
    )

    const runtime = new PluginRuntimeService(
      () => ({ isMainWindow: true, windowId: '1' }),
      leaseState,
      gatekeeper,
      authorizedProfiles,
      AuditService.forTests({ logPath: path.join(base, 'audit.jsonl') }),
      {
        platform: 'linux',
        descriptorPaths: { descriptorPath },
        reconnectDelayMs: 20,
        isProcessAlive: () => true,
        random: {
          randomBytes: (size) => Buffer.alloc(size, 5),
          randomId: () => 'integration-window',
        },
      },
    )

    runtime.start()
    await vi.waitFor(
      () => {
        expect(leaseState.getLeaseEpoch()).not.toBeNull()
      },
      { timeout: 5_000 },
    )

    const result = await gateway.call({
      method: 'list_authorized_ssh_profiles',
      params: {},
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result).toEqual({
        profiles: [{ profile_ref: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', display_name: 'Safe Name' }],
      })
      expect(JSON.stringify(result.result)).not.toMatch(/hunter2|secret-host|secret-user/)
    }

    runtime.destroy()
  })
})
