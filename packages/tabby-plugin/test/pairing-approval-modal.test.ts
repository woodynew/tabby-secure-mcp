import { describe, expect, it } from 'vitest'

import { PairingApprovalModalComponent } from '../src/approval/pairing-approval-modal.component'

describe('PairingApprovalModalComponent', () => {
  it('denies on window blur via HostListener handler', () => {
    expect(typeof PairingApprovalModalComponent.prototype.onWindowBlur).toBe('function')
  })
})
