import type { ApprovalDecision } from './approval-presenter'
import type { ApprovalScheduler } from './approval-scheduler'
import type { MonotonicClock } from './monotonic-clock'

export interface ApprovalPresentationContext {
  signal: AbortSignal
  deadlineMonotonicMs: number
  remainingSeconds(): number
}

export async function presentWithApprovalDeadline(input: {
  clock: MonotonicClock
  scheduler: ApprovalScheduler
  deadlineMonotonicMs: number
  userSignal?: AbortSignal
  present: (context: ApprovalPresentationContext) => Promise<ApprovalDecision>
}): Promise<ApprovalDecision> {
  const controller = new AbortController()
  const abortFromUser = (): void => {
    if (input.userSignal?.aborted) {
      controller.abort()
    }
  }
  input.userSignal?.addEventListener('abort', abortFromUser)
  abortFromUser()

  const context: ApprovalPresentationContext = {
    signal: controller.signal,
    deadlineMonotonicMs: input.deadlineMonotonicMs,
    remainingSeconds: () =>
      Math.max(0, Math.ceil((input.deadlineMonotonicMs - input.clock.now()) / 1000)),
  }

  let presenterDecision = 'deny' as ApprovalDecision
  let presenterSettled = false
  let gateClosed = false

  const presenterPromise = input.present(context).then(
    decision => {
      if (!gateClosed) {
        presenterDecision = decision
        presenterSettled = true
      }
    },
    () => {
      if (!gateClosed) {
        presenterDecision = 'deny'
        presenterSettled = true
      }
    },
  )

  const deadlineDelay = Math.max(0, input.deadlineMonotonicMs - input.clock.now())
  const deadlinePromise = new Promise<'deadline'>(resolve => {
    if (deadlineDelay === 0) {
      resolve('deadline')
      return
    }
    const cancel = input.scheduler.schedule(deadlineDelay, () => resolve('deadline'))
    controller.signal.addEventListener('abort', cancel, { once: true })
  })

  const abortPromise = new Promise<'aborted'>(resolve => {
    if (controller.signal.aborted) {
      resolve('aborted')
      return
    }
    controller.signal.addEventListener('abort', () => resolve('aborted'), { once: true })
  })

  const raceOutcome = await Promise.race([
    presenterPromise.then(() => 'presenter' as const),
    deadlinePromise.then(() => 'deadline' as const),
    abortPromise.then(() => 'aborted' as const),
  ])

  const approved =
    raceOutcome === 'presenter' &&
    presenterSettled &&
    presenterDecision === 'allow' &&
    input.clock.now() < input.deadlineMonotonicMs &&
    !controller.signal.aborted &&
    !input.userSignal?.aborted

  gateClosed = true
  controller.abort()
  input.userSignal?.removeEventListener('abort', abortFromUser)

  return approved ? 'allow' : 'deny'
}
