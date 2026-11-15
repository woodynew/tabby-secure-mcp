import { describe, expect, it, vi } from 'vitest'
import { NgBootstrapApprovalPresenter } from '../src/approval/ng-bootstrap-approval-presenter'

it.each(['aborted', 'expired'])('does not interrupt the user for an already %s approval', async state => {
  const modal = { open: vi.fn() }, host = { bringToFront: vi.fn() }, abort = new AbortController()
  if (state === 'aborted') abort.abort()
  const presenter = new NgBootstrapApprovalPresenter(modal as never, undefined, host as never)
  expect(await presenter.presentClient({ clientIdentity: 'Agent', companionLabel: '', remainingSeconds: 0 }, {
    signal: abort.signal, deadlineMonotonicMs: state === 'expired' ? performance.now() - 1 : performance.now() + 60_000, remainingSeconds: () => 0,
  })).toBeNull()
  expect(modal.open).not.toHaveBeenCalled()
  expect(host.bringToFront).not.toHaveBeenCalled()
})

it('keeps approval usable when the host cannot bring its window forward', async () => {
  const modal = { open: () => ({ componentInstance: {}, result: Promise.resolve('deny'), dismiss() {} }) }
  const host = { bringToFront: () => { throw new Error('window unavailable') } }
  vi.stubGlobal('window', { setInterval: () => 1, clearInterval() {} })
  try {
    const presenter = new NgBootstrapApprovalPresenter(modal as never, undefined, host as never)
    expect(await presenter.presentClient({ clientIdentity: 'Agent', companionLabel: '', remainingSeconds: 60 }, {
      signal: new AbortController().signal, deadlineMonotonicMs: performance.now() + 60_000, remainingSeconds: () => 60,
    })).toBeNull()
  } finally { vi.unstubAllGlobals() }
})

it('brings Tabby forward before showing approval without treating focus as consent', async () => {
  const events: string[] = []
  const modal = { open: () => { events.push('modal'); return { componentInstance: {}, result: Promise.resolve('deny'), dismiss() {} } } }
  const host = { bringToFront: () => { events.push('front') } }
  vi.stubGlobal('window', { setInterval: () => 1, clearInterval() {} })
  try {
    const presenter = new NgBootstrapApprovalPresenter(modal as never, undefined, host as never)
    expect(await presenter.presentClient({ clientIdentity: 'Agent', companionLabel: '', remainingSeconds: 60 }, {
      signal: new AbortController().signal, deadlineMonotonicMs: performance.now() + 60_000, remainingSeconds: () => 60,
    })).toBeNull()
    expect(events).toEqual(['front', 'modal'])
  } finally { vi.unstubAllGlobals() }
})

it('opens and populates a named client approval inside Angular before any decision', async () => {
  let insideZone = false
  const assigned: Record<string, unknown> = {}
  const componentInstance = new Proxy(assigned, { set(target, key: string, value) { expect(insideZone).toBe(true); target[key] = value; return true } })
  const modal = { open: vi.fn(() => { expect(insideZone).toBe(true); return { componentInstance, result: Promise.resolve('permanent'), dismiss: vi.fn() } }) }
  const zone = { run<T>(work: () => T): T { insideZone = true; try { return work() } finally { insideZone = false } } }
  vi.stubGlobal('window', { setInterval: () => 1, clearInterval() {} })
  try {
    const presenter = new NgBootstrapApprovalPresenter(modal as never, zone as never)
    expect(await presenter.presentClient({ clientIdentity: 'Named connection', companionLabel: 'Self declared agent', remainingSeconds: 30 }, {
      signal: new AbortController().signal, deadlineMonotonicMs: performance.now() + 30000, remainingSeconds: () => 30,
    })).toBe('permanent')
    expect(assigned).toMatchObject({ clientIdentity: 'Named connection', allowDuration: true })
  } finally { vi.unstubAllGlobals() }
})
