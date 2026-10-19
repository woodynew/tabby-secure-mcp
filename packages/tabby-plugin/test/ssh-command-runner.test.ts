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
      if (data.startsWith('printf ')) {
        const marker = data.match(/'(__tabby_secure_mcp_[0-9a-f]+__)'/)?.[1] ?? ''
        emit(`\u001b[32mfiles\u001b[0m\nprintf '${marker}'\n${marker}\n`)
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

    expect(harness.sent[0]).toBe('ls -la\r')
    expect(harness.sent[1]).toContain('__tabby_secure_mcp_ab12__')
    expect(result).toEqual({ ok: true, output: 'files\nprintf \'', truncated: false })
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
})
