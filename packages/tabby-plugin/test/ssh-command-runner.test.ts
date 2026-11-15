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
} {
  const sent: string[] = []
  const listeners: Array<(chunk: string) => void> = []
  const unsubscribed = { count: 0 }
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
      onSend(data, (chunk) => {
        for (const listener of listeners) {
          listener(chunk)
        }
      })
    },
  }
  return { tab, sent, unsubscribed }
}

describe('single SSH command runner', () => {
  it('sends one command and returns output up to the completion marker', async () => {
    const clock = new FakeClock()
    const scheduler = new FakeApprovalScheduler(() => clock.now())
    const harness = readyTab((data, emit) => {
      if (data.startsWith('/bin/sh ')) {
        emit(data)
        emit('\u001eab12:start\u001f\u001b[32mfiles\u001b[0m\n\u001eab12:end\u001f')
      }
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
    expect(harness.sent[0]).toMatch(/^\/bin\/sh -c /)
    expect(result).toEqual({ ok: true, output: 'files\n', truncated: false })
    expect(harness.unsubscribed.count).toBe(1)
  })

  it('caps output and reports truncation', async () => {
    const clock = new FakeClock()
    const scheduler = new FakeApprovalScheduler(() => clock.now())
    const harness = readyTab((_data, emit) => {
      emit('\u001ecd34:start\u001f' + 'x'.repeat(MAX_SSH_COMMAND_OUTPUT_BYTES + 50))
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
      expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(MAX_SSH_COMMAND_OUTPUT_BYTES)
    }
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

  it('bounds unfinished protocol and ANSI data independently of visible output', async () => {
    for (const payload of ['\u001e' + 'x'.repeat(129), '\u001eaa:start\u001f\u001b]' + 'x'.repeat(257)]) {
      const clock = new FakeClock()
      const scheduler = new FakeApprovalScheduler(() => clock.now())
      const harness = readyTab((_data, emit) => emit(payload))
      const result = await runSingleSshCommand({ tab: harness.tab, command: 'ls', markerNonce: 'aa', deadlineMonotonicMs: 45000, clock, scheduler })
      expect(result).toMatchObject({ ok: true, truncated: true })
      if (result.ok) expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(4096)
    }
  })

  it('observes session opening after frontend and session-change events already fired', async () => {
    const clock = new FakeClock()
    const scheduler = new FakeApprovalScheduler(() => clock.now())
    const harness = readyTab((_data, emit) => emit('\u001eaa:start\u001ffiles\n\u001eaa:end\u001f'))
    harness.tab.session!.open = false
    harness.tab.frontendReady$ = { subscribe(observer) { observer.next?.(); return { unsubscribe() {} } } }
    harness.tab.sessionChanged$ = { subscribe(observer) { observer.next?.(harness.tab.session); return { unsubscribe() {} } } }
    const running = runSingleSshCommand({ tab: harness.tab, command: 'ls', markerNonce: 'aa', deadlineMonotonicMs: 45000, clock, scheduler })
    harness.tab.session!.open = true
    clock.nowMs = 50
    scheduler.flush()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(harness.sent).toHaveLength(1)
    expect(await running).toMatchObject({ ok: true, truncated: false })
  })

  it('preserves visible content inside non-protocol record separators', async () => {
    const clock = new FakeClock()
    const scheduler = new FakeApprovalScheduler(() => clock.now())
    const harness = readyTab((_data, emit) => emit('\u001eaa:start\u001fA\u001eB\u001fC\u001eaa:end\u001f'))
    expect(await runSingleSshCommand({ tab: harness.tab, command: 'ls', markerNonce: 'aa', deadlineMonotonicMs: 45000, clock, scheduler })).toEqual({ ok: true, output: 'ABC', truncated: false })
  })

  it('removes fragmented terminal escapes and preserves UTF-8 output limits', async () => {
    const clock = new FakeClock()
    const scheduler = new FakeApprovalScheduler(() => clock.now())
    const harness = readyTab((_data, emit) => {
      for (const chunk of ['\u001eaa:start\u001f', '\u001b[', '31m', '字'.repeat(1366), '\u001eaa:end\u001f']) emit(chunk)
    })
    const result = await runSingleSshCommand({ tab: harness.tab, command: 'ls', markerNonce: 'aa', deadlineMonotonicMs: 45000, clock, scheduler })
    expect(result).toMatchObject({ ok: true, truncated: true })
    if (result.ok) {
      expect(result.output).not.toContain('\u001b')
      expect(Buffer.byteLength(result.output)).toBe(4095)
    }
  })
})
