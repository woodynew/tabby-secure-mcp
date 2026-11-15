import type { ApprovalScheduler } from '../approval/approval-scheduler'
import type { MonotonicClock } from '../approval/monotonic-clock'
import { quoteShellArgument } from '../authorization/ssh-command'
import { CommandOutputCollector } from './command-output'

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
  | { ok: false; reason: 'not_ready' | 'expired' | 'cancelled' | 'not_approved' | 'audit_unavailable' | 'target_unavailable'; started?: boolean }

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
  beforeSend?: () => Promise<'not_approved' | 'audit_unavailable' | 'target_unavailable' | undefined>
  validateBeforeSend?: () => boolean
}): Promise<SingleCommandRun> {
  if (typeof input.tab.sendInput !== 'function' || !input.tab.output$ || !input.tab.frontendReady$) {
    return { ok: false, reason: 'not_ready' }
  }
  if (input.signal?.aborted) {
    return { ok: false, reason: 'cancelled' }
  }

  let collector = new CommandOutputCollector(input.markerNonce, MAX_SSH_COMMAND_OUTPUT_BYTES)
  let notifyOutput: (() => void) | null = null
  const subscriptions: Subscription[] = []

  const append = (chunk: string): void => {
    collector.push(chunk)
    if (collector.complete || collector.truncated) {
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

    const session = input.tab.session
    if (input.tab.sessionChanged$) {
      subscriptions.push(input.tab.sessionChanged$.subscribe({ next: () => {
        if (input.tab.session !== session || !session?.open) notifyOutput?.()
      } }))
    }
    const denied = await input.beforeSend?.()
    if (denied) return { ok: false, reason: denied }
    if (input.signal?.aborted) return { ok: false, reason: 'cancelled' }
    if (input.clock.now() >= input.deadlineMonotonicMs) return { ok: false, reason: 'expired' }
    if (input.tab.session !== session || !session?.open || input.validateBeforeSend?.() === false) return { ok: false, reason: 'not_approved' }
    collector = new CommandOutputCollector(input.markerNonce, MAX_SSH_COMMAND_OUTPUT_BYTES)
    const split = Math.ceil(input.markerNonce.length / 2)
    const script = `printf '\\036%s%s:start\\037' "$1" "$2"; (${input.command}) </dev/null; printf '\\036%s%s:end\\037' "$1" "$2"`
    input.tab.sendInput(`/bin/sh -c ${quoteShellArgument(script)} tabby-secure-mcp ${quoteShellArgument(input.markerNonce.slice(0, split))} ${quoteShellArgument(input.markerNonce.slice(split))}\r`)

    const finished = await waitForMarker({
      signal: input.signal,
      deadlineMonotonicMs: input.deadlineMonotonicMs,
      clock: input.clock,
      scheduler: input.scheduler,
      isDone: () => collector.complete || collector.truncated || input.tab.session !== session || !session?.open,
      listen: (notify) => {
        notifyOutput = notify
      },
    })
    if (finished === 'cancelled') {
      return { ok: false, reason: 'cancelled', started: true }
    }
    if (input.tab.session !== session || !session?.open) return { ok: false, reason: 'not_approved', started: true }
    if (!collector.complete && !collector.truncated) {
      return collector.output.length > 0
        ? { ok: true, output: collector.output, truncated: true }
        : { ok: false, reason: 'expired', started: true }
    }
    return {
      ok: true,
      output: collector.output,
      truncated: collector.truncated && !collector.complete,
    }
  } finally {
    for (const subscription of subscriptions) {
      subscription.unsubscribe()
    }
  }
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
    let cancelPoll = (): void => undefined
    const finish = (ready: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      cancelTimer()
      cancelPoll()
      for (const subscription of subscriptions) {
        subscription.unsubscribe()
      }
      input.signal?.removeEventListener('abort', onAbort)
      resolve(ready)
    }
    const onAbort = (): void => finish(false)
    const check = (): void => {
      if (settled) return
      cancelPoll()
      if (input.tab.session?.open) {
        finish(true)
      } else if (input.signal?.aborted || input.clock.now() >= input.deadlineMonotonicMs) {
        finish(false)
      } else {
        cancelPoll = input.scheduler.schedule(Math.min(50, input.deadlineMonotonicMs - input.clock.now()), check)
      }
    }
    input.signal?.addEventListener('abort', onAbort)
    const delay = Math.max(0, input.deadlineMonotonicMs - input.clock.now())
    cancelTimer = input.scheduler.schedule(delay, () => finish(false))
    const frontend = input.tab.frontendReady$.subscribe({ next: check })
    if (settled) frontend.unsubscribe()
    else subscriptions.push(frontend)
    if (input.tab.sessionChanged$) {
      const changed = input.tab.sessionChanged$.subscribe({ next: check })
      if (settled) changed.unsubscribe()
      else subscriptions.push(changed)
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
