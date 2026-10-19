import { Buffer } from 'node:buffer'

import type { ApprovalScheduler } from '../approval/approval-scheduler'
import type { MonotonicClock } from '../approval/monotonic-clock'

export const MAX_SSH_COMMAND_OUTPUT_BYTES = 4096

interface Subscription {
  unsubscribe(): void
}

interface Subscribable<T> {
  subscribe(observer: { next?: (value: T) => void }): Subscription
}

export interface SingleCommandTab {
  sendInput(data: string): void
  output$: Subscribable<string>
  frontendReady$: Subscribable<void>
  session?: { open?: boolean } | null
  sessionChanged$?: Subscribable<unknown>
}

export type SingleCommandRun =
  | { ok: true; output: string; truncated: boolean }
  | { ok: false; reason: 'not_ready' | 'expired' | 'cancelled' }

export function isSingleCommandTab(value: unknown): value is SingleCommandTab {
  if (!value || typeof value !== 'object') {
    return false
  }
  const tab = value as Partial<SingleCommandTab>
  return typeof tab.sendInput === 'function' && tab.output$ != null && tab.frontendReady$ != null
}

export async function runSingleSshCommand(input: {
  tab: SingleCommandTab
  command: string
  markerNonce: string
  signal?: AbortSignal
  deadlineMonotonicMs: number
  clock: MonotonicClock
  scheduler: ApprovalScheduler
}): Promise<SingleCommandRun> {
  if (typeof input.tab.sendInput !== 'function' || !input.tab.output$ || !input.tab.frontendReady$) {
    return { ok: false, reason: 'not_ready' }
  }
  if (input.signal?.aborted) {
    return { ok: false, reason: 'cancelled' }
  }

  const marker = `__tabby_secure_mcp_${input.markerNonce}__`
  let output = ''
  let truncated = false
  let sawMarker = false
  let notifyOutput: (() => void) | null = null
  const subscriptions: Subscription[] = []

  const append = (chunk: string): void => {
    if (sawMarker || truncated) {
      return
    }
    const next = capUtf8(output + stripTerminalText(chunk), MAX_SSH_COMMAND_OUTPUT_BYTES)
    output = next.text
    truncated = next.truncated
    if (output.includes(marker)) {
      sawMarker = true
    }
    if (sawMarker || truncated) {
      notifyOutput?.()
    }
  }

  subscriptions.push(input.tab.output$.subscribe({ next: append }))

  try {
    const ready = await waitUntilSessionOpen(input)
    if (input.signal?.aborted) {
      return { ok: false, reason: 'cancelled' }
    }
    if (!ready) {
      return input.clock.now() >= input.deadlineMonotonicMs
        ? { ok: false, reason: 'expired' }
        : { ok: false, reason: 'not_ready' }
    }

    output = ''
    truncated = false
    sawMarker = false
    input.tab.sendInput(`${input.command}\r`)
    input.tab.sendInput(`printf '%s\\n' '${marker}'\r`)

    const finished = await waitForMarker({
      signal: input.signal,
      deadlineMonotonicMs: input.deadlineMonotonicMs,
      clock: input.clock,
      scheduler: input.scheduler,
      isDone: () => sawMarker || truncated,
      listen: (notify) => {
        notifyOutput = notify
      },
    })
    if (finished === 'cancelled') {
      return { ok: false, reason: 'cancelled' }
    }
    if (!sawMarker && !truncated) {
      return output.length > 0
        ? { ok: true, output, truncated: true }
        : { ok: false, reason: 'expired' }
    }
    return {
      ok: true,
      output: outputBeforeMarker(output, marker),
      truncated: truncated && !sawMarker,
    }
  } finally {
    for (const subscription of subscriptions) {
      subscription.unsubscribe()
    }
  }
}

function outputBeforeMarker(output: string, marker: string): string {
  const at = output.indexOf(marker)
  return at >= 0 ? output.slice(0, at) : output
}

async function waitUntilSessionOpen(input: {
  tab: SingleCommandTab
  signal?: AbortSignal
  deadlineMonotonicMs: number
  clock: MonotonicClock
  scheduler: ApprovalScheduler
}): Promise<boolean> {
  if (input.tab.session?.open) {
    return true
  }
  if (input.signal?.aborted || input.clock.now() >= input.deadlineMonotonicMs) {
    return false
  }
  return new Promise(resolve => {
    let settled = false
    const subscriptions: Subscription[] = []
    let cancelTimer = (): void => undefined
    const finish = (ready: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      cancelTimer()
      for (const subscription of subscriptions) {
        subscription.unsubscribe()
      }
      input.signal?.removeEventListener('abort', onAbort)
      resolve(ready)
    }
    const onAbort = (): void => finish(false)
    const check = (): void => {
      if (input.tab.session?.open) {
        finish(true)
      }
    }
    input.signal?.addEventListener('abort', onAbort)
    const delay = Math.max(0, input.deadlineMonotonicMs - input.clock.now())
    cancelTimer = input.scheduler.schedule(delay, () => finish(Boolean(input.tab.session?.open)))
    subscriptions.push(input.tab.frontendReady$.subscribe({ next: check }))
    if (input.tab.sessionChanged$) {
      subscriptions.push(input.tab.sessionChanged$.subscribe({ next: check }))
    }
    check()
  })
}

async function waitForMarker(input: {
  signal?: AbortSignal
  deadlineMonotonicMs: number
  clock: MonotonicClock
  scheduler: ApprovalScheduler
  isDone: () => boolean
  listen: (notify: () => void) => void
}): Promise<'done' | 'deadline' | 'cancelled'> {
  if (input.signal?.aborted) {
    return 'cancelled'
  }
  if (input.isDone()) {
    return 'done'
  }
  if (input.clock.now() >= input.deadlineMonotonicMs) {
    return 'deadline'
  }
  return new Promise(resolve => {
    let settled = false
    const finish = (outcome: 'done' | 'deadline' | 'cancelled'): void => {
      if (settled) {
        return
      }
      settled = true
      cancelTimer()
      input.signal?.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const delay = Math.max(0, input.deadlineMonotonicMs - input.clock.now())
    const cancelTimer = input.scheduler.schedule(delay, () => finish(input.isDone() ? 'done' : 'deadline'))
    const onAbort = (): void => finish('cancelled')
    input.signal?.addEventListener('abort', onAbort)
    input.listen(() => finish(input.isDone() ? 'done' : 'deadline'))
    if (input.isDone()) {
      finish('done')
    }
  })
}

function stripTerminalText(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001a\u001c-\u001f\u007f]/g, '')
}

function capUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return { text: value, truncated: false }
  }
  let low = 0
  let high = value.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, mid), 'utf8') <= maxBytes) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  return { text: value.slice(0, low), truncated: true }
}
