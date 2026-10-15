import { Inject, Injectable } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'

import {
  type ApprovalDecision,
  type ApprovalPresentationContext,
  type ApprovalPresenter,
  type OpenApprovalViewModel,
  type PairingApprovalViewModel,
} from './approval-presenter'
import { OpenApprovalModalComponent } from './open-approval-modal.component'
import { PairingApprovalModalComponent } from './pairing-approval-modal.component'

@Injectable()
export class NgBootstrapApprovalPresenter implements ApprovalPresenter {
  constructor(@Inject(NgbModal) private readonly modalService: NgbModal) {}

  async presentPairing(
    viewModel: PairingApprovalViewModel,
    context: ApprovalPresentationContext,
  ): Promise<ApprovalDecision> {
    return this.presentModal(PairingApprovalModalComponent, viewModel, context)
  }

  async presentOpen(
    viewModel: OpenApprovalViewModel,
    context: ApprovalPresentationContext,
  ): Promise<ApprovalDecision> {
    return this.presentModal(OpenApprovalModalComponent, viewModel, context)
  }

  private async presentModal(
    component: typeof PairingApprovalModalComponent | typeof OpenApprovalModalComponent,
    viewModel: PairingApprovalViewModel | OpenApprovalViewModel,
    context: ApprovalPresentationContext,
  ): Promise<ApprovalDecision> {
    if (context.signal.aborted) {
      return 'deny'
    }

    const modalRef = this.modalService.open(component, {
      backdrop: true,
      keyboard: false,
      centered: true,
    })

    Object.assign(modalRef.componentInstance, {
      ...viewModel,
      remainingSeconds: context.remainingSeconds(),
    })

    const abortListener = (): void => {
      modalRef.dismiss('cancelled')
    }
    context.signal.addEventListener('abort', abortListener, { once: true })

    const tick = window.setInterval(() => {
      if (context.signal.aborted) {
        modalRef.dismiss('cancelled')
        return
      }
      Object.assign(modalRef.componentInstance, {
        remainingSeconds: context.remainingSeconds(),
      })
    }, 250)

    try {
      const result = await modalRef.result
      return result === 'allow' ? 'allow' : 'deny'
    } catch {
      return 'deny'
    } finally {
      context.signal.removeEventListener('abort', abortListener)
      window.clearInterval(tick)
    }
  }
}
