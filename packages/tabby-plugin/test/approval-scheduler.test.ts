import { describe, expect, it } from 'vitest'

import { presentWithApprovalDeadline } from '../src/approval/approval-deadline'
import type { MonotonicClock } from '../src/approval/monotonic-clock'
import { FakeApprovalScheduler } from '../src/approval/approval-scheduler'

class FakeClock implements MonotonicClock {
  private nowMs = 0

  advance(ms: number): void {
    this.nowMs += ms
  }

  now(): number {
    return this.nowMs
  }
}

describe('presentWithApprovalDeadline', () => {
  it('resolves deny at exactly 30_000ms without awaiting a hung presenter', async () => {
    const clock = new FakeClock()
    const scheduler = new FakeApprovalScheduler(() => clock.now())
    const deadline = clock.now() + 30_000

    const pending = presentWithApprovalDeadline({
      clock,
      scheduler,
      deadlineMonotonicMs: deadline,
      userSignal: undefined,
      present: () => new Promise(() => undefined),
    })

    clock.advance(30_000)
    scheduler.flush()
    const decision = await pending

    expect(decision).toBe('deny')
  })

  it('does not approve when the presenter resolves allow after the deadline', async () => {
    const clock = new FakeClock()
    const scheduler = new FakeApprovalScheduler(() => clock.now())
    const deadline = clock.now() + 30_000
    let releaseAllow!: () => void

    const pending = presentWithApprovalDeadline({
      clock,
      scheduler,
      deadlineMonotonicMs: deadline,
      userSignal: undefined,
      present: () =>
        new Promise<'allow' | 'deny'>(resolve => {
          releaseAllow = () => resolve('allow')
        }),
    })

    clock.advance(30_000)
    scheduler.flush()
    const decision = await pending
    expect(decision).toBe('deny')

    releaseAllow()
    await Promise.resolve()
  })

  it('approves only when the presenter allows before the deadline', async () => {
    const clock = new FakeClock()
    const scheduler = new FakeApprovalScheduler(() => clock.now())
    const deadline = clock.now() + 30_000

    const decision = await presentWithApprovalDeadline({
      clock,
      scheduler,
      deadlineMonotonicMs: deadline,
      userSignal: undefined,
      present: async () => 'allow',
    })

    expect(decision).toBe('allow')
  })
})
