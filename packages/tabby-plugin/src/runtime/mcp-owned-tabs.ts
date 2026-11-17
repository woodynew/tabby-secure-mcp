import { randomBytes } from 'node:crypto'
import type { ClientIdentity } from '@tabby-secure-mcp/companion'

export interface TabTarget { profileId: string; profileDigest: string; session?: { open?: boolean }; wasOpen?: boolean }
export interface TabLease { tab: unknown; isCurrent(): boolean; release(reusable: boolean): void }
export type TabAcquisition = { ok: true; lease?: TabLease } | { ok: false; code: 'target_unavailable' | 'busy' }
export interface RetainedTabMetadata extends TabTarget { reusable: boolean; reused: boolean }
interface TabEvents { subscribe(observer: { next?(): void; complete?(): void }): { unsubscribe(): void } }
interface OwnedTab {
  owner: Pick<ClientIdentity, 'id' | 'generation'>
  tab: { destroy(): void | Promise<void>; session?: { open?: boolean } | null; destroyed$?: TabEvents; sessionChanged$?: TabEvents; input$?: TabEvents; frontendReady$?: TabEvents }
  target?: TabTarget
  session?: { open?: boolean }
  wasOpen: boolean
  invalidated: boolean
  reusable: boolean
  busy: boolean
  dispose(): void
}

export class McpOwnedTabs {
  private readonly tabs = new Map<string, OwnedTab>()

  track(client: ClientIdentity, value: unknown, target?: TabTarget, reusable = true): string | undefined {
    if (!value || typeof (value as { destroy?: unknown }).destroy !== 'function') return undefined
    for (const [ref, entry] of this.tabs) {
      if (entry.tab !== value) continue
      if (!this.owns(ref, client)) return undefined
      if (target && entry.target && !this.sameTarget(target, entry.target)) entry.invalidated = true
      if (!entry.target && target) entry.target = { ...target }
      entry.reusable = entry.reusable && reusable
      this.observeSession(entry)
      return ref
    }
    const tab = value as OwnedTab['tab']
    const ref = randomBytes(24).toString('base64url')
    const subscriptions: { unsubscribe(): void }[] = []
    const entry: OwnedTab = { owner: { id: client.id, generation: client.generation }, tab, target: target && { ...target },
      session: target?.session ?? tab.session ?? undefined, wasOpen: target?.wasOpen ?? !!(target?.session?.open || tab.session?.open), invalidated: false, reusable, busy: false,
      dispose: () => { for (const sub of subscriptions.splice(0)) sub.unsubscribe() } }
    this.observeSession(entry)
    this.tabs.set(ref, entry)
    try {
      const retain = (subscription?: { unsubscribe(): void }) => {
        if (!subscription) return
        if (this.tabs.has(ref)) subscriptions.push(subscription)
        else subscription.unsubscribe()
      }
      retain(tab.destroyed$?.subscribe({ next: () => this.forget(ref), complete: () => this.forget(ref) }))
      if (!this.tabs.has(ref)) return undefined
      retain(tab.sessionChanged$?.subscribe({ next: () => this.observeSession(entry), complete: () => { entry.invalidated = true } }))
      let monitoringInput = false
      const monitorInput = () => {
        if (monitoringInput || !this.tabs.has(ref)) return
        try {
          const input = tab.input$
          if (input) {
            retain(input.subscribe({ next: () => { entry.invalidated = true }, complete: () => { entry.invalidated = true } }))
            monitoringInput = true
          }
        } catch { /* Tabby's input$ getter becomes available after frontendReady$. */ }
      }
      monitorInput()
      if (!monitoringInput) retain(tab.frontendReady$?.subscribe({ next: monitorInput, complete: monitorInput }))
    } catch { this.forget(ref); return undefined }
    return ref
  }

  owns(ref: string, client: ClientIdentity): boolean {
    const entry = this.tabs.get(ref)
    return !!entry && entry.owner.id === client.id && entry.owner.generation === client.generation
  }

  reusable(ref: string, client: ClientIdentity): boolean {
    const entry = this.tabs.get(ref)
    if (!entry || !this.owns(ref, client)) return false
    this.observeSession(entry)
    return !!entry.target && entry.reusable && !entry.invalidated && !entry.busy
  }

  acquire(client: ClientIdentity, target: TabTarget, ref?: string): TabAcquisition {
    const candidates: Array<[string, OwnedTab | undefined]> = ref === undefined ? [...this.tabs.entries()].reverse() : [[ref, this.tabs.get(ref)]]
    let busy = false
    for (const [key, entry] of candidates) {
      if (!entry || !this.owns(key, client) || !entry.target || !this.sameTarget(entry.target, target)) continue
      this.observeSession(entry)
      if (!entry.reusable || entry.invalidated) continue
      if (entry.busy) { busy = true; continue }
      entry.busy = true
      let released = false
      return { ok: true, lease: {
        tab: entry.tab,
        isCurrent: () => {
          this.observeSession(entry)
          return !released && this.tabs.get(key) === entry && entry.reusable && !entry.invalidated
        },
        release: reusable => {
          if (released) return
          released = true
          this.observeSession(entry)
          entry.reusable = entry.reusable && reusable
          entry.busy = false
        },
      } }
    }
    return busy ? { ok: false, code: 'busy' } : ref === undefined ? { ok: true } : { ok: false, code: 'target_unavailable' }
  }

  private sameTarget(a: TabTarget, b: TabTarget): boolean { return a.profileId === b.profileId && a.profileDigest === b.profileDigest }

  private observeSession(entry: OwnedTab): void {
    const session = entry.tab.session
    if (!entry.session && session) entry.session = session
    else if (entry.session && session !== entry.session) entry.invalidated = true
    if (session?.open) entry.wasOpen = true
    else if (entry.wasOpen) entry.invalidated = true
  }

  async close(ref: string, client: ClientIdentity, current: () => boolean): Promise<
    { ok: true; status: 'closed' } | { ok: false; code: 'target_unavailable' | 'busy' | 'cancelled' | 'outcome_unknown' }
  > {
    if (!this.owns(ref, client)) return { ok: false, code: 'target_unavailable' }
    const entry = this.tabs.get(ref)!
    if (entry.busy) return { ok: false, code: 'busy' }
    if (!current()) return { ok: false, code: 'cancelled' }
    entry.busy = true
    try {
      await entry.tab.destroy()
      this.forget(ref)
      return { ok: true, status: 'closed' }
    } catch { return { ok: false, code: 'outcome_unknown' } }
    finally { entry.busy = false }
  }

  clear(): void { for (const ref of this.tabs.keys()) this.forget(ref) }

  private forget(ref: string): void {
    const entry = this.tabs.get(ref)
    this.tabs.delete(ref)
    try { entry?.dispose() } catch { /* A destroyed view must not block registry cleanup. */ }
  }
}
