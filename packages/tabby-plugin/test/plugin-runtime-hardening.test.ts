import { Buffer } from 'node:buffer'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { startGatewayHarness } from '../../companion/test/helpers/gateway-harness.js'
import type { ApprovalPresenter } from '../src/approval/approval-presenter'
import { ApprovalGatekeeper } from '../src/approval/approval-gatekeeper'
import { SystemApprovalScheduler } from '../src/approval/approval-scheduler'
import type { MonotonicClock } from '../src/approval/monotonic-clock'
import {
  PluginRuntimeService,
  SendUnavailableError,
} from '../src/runtime/plugin-runtime-service'
import { RuntimeLeaseState } from '../src/runtime/runtime-lease-state'
import type { RuntimeDiagnosticCode } from '../src/runtime/runtime-diagnostics'

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})

class FakeClock implements MonotonicClock {
  now(): number {
    return 0
  }
}

describe('PluginRuntimeService hardening', () => {
  it('treats duplicate in-flight open request_id as protocol violation and reconnects', async () => {
    const harness = await startGatewayHarness()
    closers.push(() => harness.close())
    const base = await mkdtemp(path.join(tmpdir(), 'plugin-hard-'))
    const descriptorPath = path.join(base, 'descriptor.json')
    const descriptorBody = `${JSON.stringify({
      protocol_version: 1,
      endpoint: harness.endpoint,
      pid: harness.pid,
      expires_at: Date.now() + 60_000,
      pairing_nonce: harness.pairingNonce,
    })}\n`

    const diagnostics: RuntimeDiagnosticCode[] = []
    const presenter: ApprovalPresenter = {
      presentPairing: async () => 'allow',
      presentOpen: async () => new Promise<'allow' | 'deny'>(() => undefined),
    }
    const leaseState = new RuntimeLeaseState()
    const gatekeeper = new ApprovalGatekeeper(
      {
        listAuthorizedProfiles: vi.fn(),
        resolveAuthorizedProfile: vi.fn(async () => ({
          id: 'p1',
          type: 'ssh',
          name: 'n',
          options: { host: 'h', user: 'u' },
          isBuiltin: false,
          isTemplate: false,
        })),
        clearRefCache: vi.fn(),
      } as never,
      { getProfiles: vi.fn(async () => []), openNewTabForProfile: vi.fn(async () => ({})) } as never,
      presenter,
      new FakeClock(),
      () => leaseState.getLeaseEpoch(),
      new SystemApprovalScheduler(),
    )

    const runtime = new PluginRuntimeService(
      () => ({ isMainWindow: true, windowId: '1' }),
      leaseState,
      gatekeeper,
      {
        listAuthorizedProfiles: vi.fn(),
        clearRefCache: vi.fn(),
      } as never,
      { safeAppend: vi.fn(async () => undefined) } as never,
      {
        platform: 'linux',
        descriptorPaths: { descriptorPath },
        fs: {
          async stat() {
            return { isSymbolicLink: () => false, size: descriptorBody.length }
          },
          async readFile() {
            return descriptorBody
          },
        },
        isProcessAlive: () => true,
        onDiagnostic: (code) => diagnostics.push(code),
        random: {
          randomBytes: (size) => Buffer.alloc(size, 2),
          randomId: () => 'window-instance-dup',
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

    const requestId = 'cccccccccccccccccccccccccccccccc'
    const profileRef = 'dddddddddddddddddddddddddddddddd'
    const generation = (runtime as unknown as { connectionEpoch: number }).connectionEpoch
    const openMessage = {
      v: 1 as const,
      seq: 1,
      type: 'rpc_request' as const,
      request_id: requestId,
      lease_epoch: leaseState.getLeaseEpoch()!,
      request: {
        method: 'open_authorized_ssh_profile' as const,
        params: { profile_ref: profileRef },
      },
    }

    const handleOpen = (
      runtime as unknown as {
        handleOpenRpc: (message: typeof openMessage, generation: number) => Promise<void>
      }
    )['handleOpenRpc'].bind(runtime)

    void handleOpen(openMessage, generation)
    await handleOpen(openMessage, generation)

    expect(diagnostics).toContain('protocol_violation')
    runtime.destroy()
  })

  it('send rejects when socket generation is not current', async () => {
    const runtime = new PluginRuntimeService(
      () => ({ isMainWindow: true, windowId: '1' }),
      new RuntimeLeaseState(),
      new ApprovalGatekeeper(
        { listAuthorizedProfiles: vi.fn(), resolveAuthorizedProfile: vi.fn(), clearRefCache: vi.fn() } as never,
        { getProfiles: vi.fn(), openNewTabForProfile: vi.fn() } as never,
        { presentPairing: vi.fn(), presentOpen: vi.fn() },
        new FakeClock(),
        () => null,
        new SystemApprovalScheduler(),
      ),
      { listAuthorizedProfiles: vi.fn(), clearRefCache: vi.fn() } as never,
      { safeAppend: vi.fn() } as never,
    )

    const send = (
      runtime as unknown as { send: (message: unknown, generation: number) => Promise<void> }
    ).send.bind(runtime)

    await expect(
      send(
        {
          v: 1,
          seq: 0,
          type: 'plugin_hello',
          window_instance_id: 'x',
          is_main_window: true,
          plugin_challenge: 'y',
        },
        0,
      ),
    ).rejects.toBeInstanceOf(SendUnavailableError)
  })
})
