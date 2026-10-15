import type { ErrorCode } from '@tabby-secure-mcp/ipc-contract'

export interface RegisteredWindow {
  windowInstanceId: string
  isMainWindow: boolean
}

export interface LeaseGrant {
  windowInstanceId: string
  leaseEpoch: number
}

export interface PendingRequest {
  requestId: string
  windowInstanceId: string
  leaseEpoch: number
  onCancel: (reason: ErrorCode) => void
}

export class LeaseManager {
  #windows = new Map<string, RegisteredWindow & { connected: boolean }>()
  #holder?: LeaseGrant
  #epoch = 0
  #pending = new Map<string, PendingRequest>()

  get holder(): LeaseGrant | undefined {
    return this.#holder
  }

  get epoch(): number {
    return this.#epoch
  }

  get standbyWindowIds(): string[] {
    const holderId = this.#holder?.windowInstanceId
    return [...this.#windows.values()]
      .filter((window) => window.connected && window.windowInstanceId !== holderId)
      .map((window) => window.windowInstanceId)
  }

  registerWindow(window: RegisteredWindow): void {
    this.#windows.set(window.windowInstanceId, { ...window, connected: true })
  }

  getPreferredPairingCandidate(): RegisteredWindow | undefined {
    const candidates = [...this.#windows.values()].filter((window) => window.connected)
    if (candidates.length === 0) {
      return undefined
    }
    return candidates.find((window) => window.isMainWindow) ?? candidates[0]
  }

  pairAndGrant(windowInstanceId: string): LeaseGrant {
    if (this.#holder) {
      throw new Error('a lease holder is already paired')
    }
    const window = this.#windows.get(windowInstanceId)
    if (!window?.connected) {
      throw new Error(`window ${windowInstanceId} is not available for pairing`)
    }
    this.#epoch += 1
    const grant = { windowInstanceId, leaseEpoch: this.#epoch }
    this.#holder = grant
    return grant
  }

  trackPending(request: PendingRequest): void {
    if (!this.#holder) {
      throw new Error('no active lease holder')
    }
    if (request.windowInstanceId !== this.#holder.windowInstanceId) {
      throw new Error('only the lease holder may track pending work')
    }
    if (request.leaseEpoch !== this.#holder.leaseEpoch) {
      throw new Error('lease epoch is stale')
    }
    this.#pending.set(request.requestId, request)
  }

  disconnectWindow(windowInstanceId: string): LeaseGrant {
    const window = this.#windows.get(windowInstanceId)
    if (!window) {
      throw new Error(`unknown window ${windowInstanceId}`)
    }
    window.connected = false

    const wasHolder = this.#holder?.windowInstanceId === windowInstanceId
    if (wasHolder) {
      for (const pending of this.#pending.values()) {
        if (pending.windowInstanceId === windowInstanceId) {
          pending.onCancel('cancelled')
        }
      }
      this.#pending.clear()
      this.#holder = undefined
      this.#epoch += 1
    }

    return { windowInstanceId, leaseEpoch: this.#epoch }
  }
}
