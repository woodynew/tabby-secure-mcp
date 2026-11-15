import { describe, expect, it } from 'vitest'

import { FakeApprovalScheduler } from '../src/approval/approval-scheduler'
import type { MonotonicClock } from '../src/approval/monotonic-clock'
import {
  MAX_SSH_COMMAND_OUTPUT_BYTES,
  runSingleSshCommand,
  type SingleCommandTab,
} from '../src/ssh/ssh-command-runner'

class FakeClock implements MonotonicClock {
  nowMs = 0
  now(): number {
    return this.nowMs
  }
}

function readyTab(onSend: (data: string, emit: (chunk: string) => void) => void): {
  tab: SingleCommandTab
  sent: string[]
  unsubscribed: { count: number }
  emit: (chunk: string) => void
} {
  const sent: string[] = []
  const listeners: Array<(chunk: string) => void> = []
  const unsubscribed = { count: 0 }
  const emit = (chunk: string): void => {
    for (const listener of listeners) {
      listener(chunk)
    }
  }
  const tab: SingleCommandTab = {
    session: { open: true },
    frontendReady$: { subscribe: () => ({ unsubscribe() {} }) },
    output$: {
      subscribe(observer) {
        if (observer.next) {
          listeners.push(observer.next)
        }
        return {
          unsubscribe() {
            unsubscribed.count += 1
          },
        }
      },
    },
    sendInput(data) {
      sent.push(data)
      onSend(data, emit)
    },
  }
  return { tab, sent, unsubscribed, emit }
}

describe('single SSH command runner', () => {
  it('sends one command and returns output up to the completion marker', async () => {
    const clock = new FakeClock()
    const scheduler = new FakeApprovalScheduler(() => clock.now())
    const harness = readyTab((_data, emit) => {
      emit('\u001b[32mfiles\u001b[0m\r\n')
      emit('\r\n__tabby_secure_mcp_')
      emit('ab12__\r')
      emit('\n$ ')
    })

    const result = await runSingleSshCommand({
      tab: harness.tab,
      command: 'ls -la',
      markerNonce: 'ab12',
      deadlineMonotonicMs: 30_000,
      clock,
      scheduler,
    })

    expect(harness.sent).toHaveLength(1)
    expect(harness.sent[0]).toMatch(/^ls -la; printf /)
    expect(harness.sent[0]).not.toContain('__tabby_secure_mcp_ab12__')
    expect(result).toEqual({
      ok: true, output: 'files\n', truncated: false, completionConfirmed: true,
    })
    expect(harness.unsubscribed.count).toBe(1)
  })

  it('caps output and reports truncation', async () => {
    const clock = new FakeClock()
    const scheduler = new FakeApprovalScheduler(() => clock.now())
    const harness = readyTab((_data, emit) => {
      emit('x'.repeat(MAX_SSH_COMMAND_OUTPUT_BYTES + 50))
    })

    const result = await runSingleSshCommand({
      tab: harness.tab,
      command: 'cat /var/log/syslog',
      markerNonce: 'cd34',
      deadlineMonotonicMs: 30_000,
      clock,
      scheduler,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.truncated).toBe(true)
      expect(result.completionConfirmed).toBe(false)
      expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(MAX_SSH_COMMAND_OUTPUT_BYTES)
    }
  })

  it.each(['echo', 'partial', 'inline'])('does not confirm completion from %s output', async mode => {
    const clock = new FakeClock()
    const scheduler = new FakeApprovalScheduler(() => clock.now())
    const harness = readyTab((data, emit) => {
      emit(mode === 'echo' ? data : mode === 'partial'
        ? '\n__tabby_secure_mcp_ab12__'
        : 'prefix __tabby_secure_mcp_ab12__\n')
    })
    const pending = runSingleSshCommand({
      tab: harness.tab, command: 'ls', markerNonce: 'ab12',
      deadlineMonotonicMs: 100, clock, scheduler,
    })
    await Promise.resolve()
    clock.nowMs = 100
    scheduler.flush()
    expect(await pending).toMatchObject({
      ok: true, truncated: true, completionConfirmed: false,
    })
    expect(harness.unsubscribed.count).toBe(1)
  })

  it('preserves marker-like output before the actual completion line', async () => {
    const clock = new FakeClock()
    const scheduler = new FakeApprovalScheduler(() => clock.now())
    const harness = readyTab((_data, emit) => {
      emit('prefix __tabby_secure_mcp_ab12__\nreal output\n')
      emit('\n__tabby_secure_mcp_ab12__\n')
    })
    expect(await runSingleSshCommand({
      tab: harness.tab, command: 'false', markerNonce: 'ab12',
      deadlineMonotonicMs: 100, clock, scheduler,
    })).toEqual({
      ok: true, output: 'prefix __tabby_secure_mcp_ab12__\nreal output\n',
      truncated: false, completionConfirmed: true,
    })
  })

  it('cleans up output subscriptions when cancelled', async () => {
    const clock = new FakeClock()
    const scheduler = new FakeApprovalScheduler(() => clock.now())
    const controller = new AbortController()
    const harness = readyTab(() => undefined)
    const pending = runSingleSshCommand({
      tab: harness.tab, command: 'ls', markerNonce: 'ab12',
      deadlineMonotonicMs: 100, clock, scheduler, signal: controller.signal,
    })
    await Promise.resolve()
    controller.abort()
    expect(await pending).toEqual({ ok: false, reason: 'cancelled' })
    expect(harness.unsubscribed.count).toBe(1)
  })

  it('does not send to a tab that was closed before execution started', async () => {
    const clock = new FakeClock()
    const scheduler = new FakeApprovalScheduler(() => clock.now())
    const harness = readyTab(() => undefined)
    Object.assign(harness.tab, {
      destroyed$: {
        subscribe(observer: { complete?: () => void }) {
          observer.complete?.()
          return { unsubscribe() {} }
        },
      },
    })
    const pending = runSingleSshCommand({
      tab: harness.tab, command: 'ls', markerNonce: 'ab12',
      deadlineMonotonicMs: 100, clock, scheduler,
    })
    await Promise.resolve()
    expect(harness.sent).toHaveLength(0)
    expect(await pending).toEqual({ ok: false, reason: 'not_ready' })
    expect(harness.unsubscribed.count).toBe(1)
  })

  it('expires when the session never opens', async () => {
    const clock = new FakeClock()
    const scheduler = new FakeApprovalScheduler(() => clock.now())
    const tab: SingleCommandTab = {
      session: { open: false },
      frontendReady$: { subscribe: () => ({ unsubscribe() {} }) },
      output$: { subscribe: () => ({ unsubscribe() {} }) },
      sendInput() {
        throw new Error('should not send')
      },
    }

    const result = await runSingleSshCommand({
      tab,
      command: 'ls',
      markerNonce: 'ee56',
      deadlineMonotonicMs: 0,
      clock,
      scheduler,
    })

    expect(result).toEqual({ ok: false, reason: 'expired' })
  })
})
