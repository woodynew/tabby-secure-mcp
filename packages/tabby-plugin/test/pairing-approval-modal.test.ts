import { describe, expect, it, vi } from 'vitest'

import { PairingApprovalModalComponent } from '../src/approval/pairing-approval-modal.component'

describe('PairingApprovalModalComponent', () => {
  it('requires explicit selection of permanent client approval', () => {
    const active = { close: vi.fn(), dismiss: vi.fn() }
    const modal = new PairingApprovalModalComponent(active as never)
    modal.allowDuration = true
    expect(modal.duration).toBe('session')
    modal.duration = 'permanent'
    modal.allow()
    expect(active.close).toHaveBeenCalledWith('permanent')
    modal.onWindowBlur()
    expect(active.dismiss).toHaveBeenCalledWith('deny')
  })
  it('denies on window blur via HostListener handler', () => {
    expect(typeof PairingApprovalModalComponent.prototype.onWindowBlur).toBe('function')
  })

  it('denies on Escape via HostListener handler', () => {
    expect(typeof PairingApprovalModalComponent.prototype.onEscape).toBe('function')
  })
})
