import { describe, expect, it, vi } from 'vitest'
import { Subject } from 'rxjs'
import { McpOwnedTabs } from '../src/runtime/mcp-owned-tabs'

const client = { id: 'a', generation: 1, name: 'Same name' }

describe('MCP-owned SSH tabs', () => {
  it('quarantines a tab taken over through frontend input while preserving explicit cleanup', async () => {
    const tabs = new McpOwnedTabs()
    const input$ = new Subject<void>()
    const tab = { destroy: vi.fn(), session: { open: true }, input$ }
    const target = { profileId: 'p', profileDigest: 'd' }
    const ref = tabs.track(client, tab, target)!
    expect(tabs.reusable(ref, client)).toBe(true)
    input$.next()
    expect(tabs.reusable(ref, client)).toBe(false)
    expect(tabs.acquire(client, target, ref)).toEqual({ ok: false, code: 'target_unavailable' })
    expect(tabs.acquire(client, target)).toEqual({ ok: true })
    expect(tabs.track(client, tab, target, true)).toBe(ref)
    expect(tabs.reusable(ref, client)).toBe(false)
    expect(await tabs.close(ref, client, () => true)).toEqual({ ok: true, status: 'closed' })
    expect(input$.observed).toBe(false)
  })

  it('attaches frontend input monitoring after frontend readiness and invalidates an active lease', () => {
    const tabs = new McpOwnedTabs()
    const input$ = new Subject<void>(), frontendReady$ = new Subject<void>()
    let ready = false
    const tab = { destroy: vi.fn(), session: { open: true }, frontendReady$, get input$() { if (!ready) throw new Error('Frontend not ready'); return input$ } }
    const target = { profileId: 'p', profileDigest: 'd' }
    const ref = tabs.track(client, tab, target)!
    ready = true
    frontendReady$.next()
    const selected = tabs.acquire(client, target, ref)
    if (!selected.ok || !selected.lease) throw new Error('Expected lease')
    input$.next()
    expect(selected.lease.isCurrent()).toBe(false)
    selected.lease.release(true)
    expect(tabs.reusable(ref, client)).toBe(false)
    tabs.clear()
    expect(input$.observed).toBe(false)
    expect(frontendReady$.observed).toBe(false)
  })

  it('leases the same target exclusively and keeps its public reference stable', async () => {
    const tabs = new McpOwnedTabs()
    const tab = { destroy: vi.fn(), session: { open: true }, sessionChanged$: new Subject<void>() }
    const target = { profileId: 'ssh-1', profileDigest: 'digest-1' }
    const ref = tabs.track(client, tab, target)!
    const selected = tabs.acquire(client, target, ref)
    expect(selected.ok).toBe(true)
    if (!selected.ok || !selected.lease) throw new Error('Expected a reusable tab')
    expect(selected.lease.tab).toBe(tab)
    expect(tabs.acquire(client, target, ref)).toEqual({ ok: false, code: 'busy' })
    expect(await tabs.close(ref, client, () => true)).toEqual({ ok: false, code: 'busy' })
    selected.lease.release(true)
    expect(tabs.track(client, tab, target)).toBe(ref)
    expect(tabs.acquire({ ...client, id: 'other' }, target, ref)).toEqual({ ok: false, code: 'target_unavailable' })
    expect(tabs.acquire(client, { ...target, profileDigest: 'changed' }, ref)).toEqual({ ok: false, code: 'target_unavailable' })
    expect(tabs.acquire(client, { ...target, profileId: 'different' }, ref)).toEqual({ ok: false, code: 'target_unavailable' })
  })

  it('quarantines changed transports and commands without confirmed completion while keeping cleanup available', async () => {
    const tabs = new McpOwnedTabs()
    const target = { profileId: 'ssh-1', profileDigest: 'digest-1' }
    const tab = { destroy: vi.fn(), session: { open: true }, sessionChanged$: new Subject<void>() }
    const ref = tabs.track(client, tab, target)!
    const selected = tabs.acquire(client, target, ref)
    if (!selected.ok || !selected.lease) throw new Error('Expected a reusable tab')
    selected.lease.release(false)
    expect(tabs.acquire(client, target, ref)).toEqual({ ok: false, code: 'target_unavailable' })
    expect(tabs.acquire(client, target)).toEqual({ ok: true })
    expect(await tabs.close(ref, client, () => true)).toEqual({ ok: true, status: 'closed' })
    const changed = tabs.track(client, tab, target)!
    const borrowed = tabs.acquire(client, target, changed)
    if (!borrowed.ok || !borrowed.lease) throw new Error('Expected a reusable tab')
    tab.session = { open: true }
    tab.sessionChanged$.next()
    expect(borrowed.lease.isCurrent()).toBe(false)
    borrowed.lease.release(true)
    expect(tabs.acquire(client, target, changed)).toEqual({ ok: false, code: 'target_unavailable' })
  })

  it('closes only the exact owned tab, never another client or generation', async () => {
    const tabs = new McpOwnedTabs()
    const tab = { destroy: vi.fn() }
    const ref = tabs.track(client, tab)!
    expect(ref).toMatch(/^[A-Za-z0-9_-]{32}$/)
    for (const owner of [{ ...client, id: 'b' }, { ...client, generation: 2 }]) {
      expect(await tabs.close(ref, owner, () => true)).toEqual({ ok: false, code: 'target_unavailable' })
    }
    expect(tab.destroy).not.toHaveBeenCalled()
    expect(await tabs.close('manual-tab-id', client, () => true)).toEqual({ ok: false, code: 'target_unavailable' })
    expect(await tabs.close(ref, client, () => true)).toEqual({ ok: true, status: 'closed' })
    expect(tab.destroy).toHaveBeenCalledOnce()
    expect(await tabs.close(ref, client, () => true)).toEqual({ ok: false, code: 'target_unavailable' })
  })

  it('refuses cancelled closes and concurrent double-close', async () => {
    const tabs = new McpOwnedTabs()
    let finish!: () => void
    const tab = { destroy: vi.fn(() => new Promise<void>(resolve => { finish = resolve })) }
    const ref = tabs.track(client, tab)!
    expect(await tabs.close(ref, client, () => false)).toEqual({ ok: false, code: 'cancelled' })
    expect(tab.destroy).not.toHaveBeenCalled()
    const closing = tabs.close(ref, client, () => true)
    expect(await tabs.close(ref, client, () => true)).toEqual({ ok: false, code: 'busy' })
    finish()
    expect(await closing).toEqual({ ok: true, status: 'closed' })
    expect(tab.destroy).toHaveBeenCalledOnce()
  })

  it('forgets manually destroyed tabs and service-stop handles without closing anything else', async () => {
    const tabs = new McpOwnedTabs()
    const destroyed$ = new Subject<void>()
    const tab = { destroy: vi.fn(), destroyed$ }
    const ref = tabs.track(client, tab)!
    destroyed$.next()
    expect(tabs.owns(ref, client)).toBe(false)
    expect(destroyed$.observed).toBe(false)
    const retained = { destroy: vi.fn() }
    const next = tabs.track(client, retained)!
    tabs.clear()
    expect(tabs.owns(next, client)).toBe(false)
    expect(tab.destroy).not.toHaveBeenCalled()
    expect(retained.destroy).not.toHaveBeenCalled()
  })

  it('reports uncertain close failures and keeps the same object available for retry', async () => {
    const tabs = new McpOwnedTabs()
    const tab = { destroy: vi.fn().mockRejectedValueOnce(new Error('disposed view')).mockResolvedValueOnce(undefined) }
    const ref = tabs.track(client, tab)!
    expect(await tabs.close(ref, client, () => true)).toEqual({ ok: false, code: 'outcome_unknown' })
    expect(await tabs.close(ref, client, () => true)).toEqual({ ok: true, status: 'closed' })
  })

  it('does not publish a handle for a tab already destroyed before registration', () => {
    const tabs = new McpOwnedTabs()
    const destroyed$ = new Subject<void>()
    destroyed$.complete()
    const tab = { destroy: vi.fn(), destroyed$ }
    expect(tabs.track(client, tab)).toBeUndefined()
    expect(tab.destroy).not.toHaveBeenCalled()
  })

  it('rejects a transport changed or disconnected between execution and publishing its result', () => {
    const tabs = new McpOwnedTabs()
    const session = { open: true }
    const target = { profileId: 'p', profileDigest: 'd', session, wasOpen: true }
    const replaced = { destroy: vi.fn(), session: { open: true } }
    const ref = tabs.track(client, replaced, target)!
    expect(tabs.reusable(ref, client)).toBe(false)
    expect(tabs.acquire(client, target, ref)).toEqual({ ok: false, code: 'target_unavailable' })
    session.open = false
    const disconnected = { destroy: vi.fn(), session }
    const closed = tabs.track(client, disconnected, target)!
    expect(tabs.reusable(closed, client)).toBe(false)
    expect(tabs.owns(closed, client)).toBe(true)
  })
})
