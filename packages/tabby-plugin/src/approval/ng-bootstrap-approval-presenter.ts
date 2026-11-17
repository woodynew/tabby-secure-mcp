import { Inject, Injectable, NgZone, Optional } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { HostWindowService } from 'tabby-core'

import {
  type ApprovalDecision,
  type ApprovalPresentationContext,
  type ApprovalPresenter,
  type OpenApprovalViewModel,
  type PairingApprovalViewModel,
  type CommandApprovalViewModel,
  type CommandApprovalDecision,
} from './approval-presenter'
import { OpenApprovalModalComponent } from './open-approval-modal.component'
import type { ApprovalDuration } from '@tabby-secure-mcp/companion'
import { PairingApprovalModalComponent } from './pairing-approval-modal.component'

@Injectable()
export class NgBootstrapApprovalPresenter implements ApprovalPresenter {
  constructor(
    @Inject(NgbModal) private readonly modalService: NgbModal,
    @Optional() @Inject(NgZone) private readonly zone?: NgZone,
    @Optional() @Inject(HostWindowService) private readonly hostWindow?: HostWindowService,
  ) {}

  private inZone<T>(work: () => T): T { return this.zone ? this.zone.run(work) : work() }

  async presentPairing(
    viewModel: PairingApprovalViewModel,
    context: ApprovalPresentationContext,
  ): Promise<ApprovalDecision> {
    return await this.presentModal(PairingApprovalModalComponent, viewModel, context) === 'allow' ? 'allow' : 'deny'
  }

  async presentClient(viewModel: PairingApprovalViewModel, context: ApprovalPresentationContext): Promise<ApprovalDuration | null> {
    const result = await this.presentModal(PairingApprovalModalComponent, { ...viewModel, allowDuration: true }, context)
    return result === 'session' || result === '24h' || result === 'permanent' ? result : null
  }

  async presentOpen(
    viewModel: OpenApprovalViewModel,
    context: ApprovalPresentationContext,
  ): Promise<ApprovalDecision> {
    return await this.presentModal(OpenApprovalModalComponent, viewModel, context) === 'allow' ? 'allow' : 'deny'
  }

  async presentCommand(viewModel: CommandApprovalViewModel, context: ApprovalPresentationContext): Promise<CommandApprovalDecision> {
    const result = await this.presentModal(OpenApprovalModalComponent, { ...viewModel, commandMode: true }, context)
    if (result === 'remember') return viewModel.allowRemember ? 'remember' : 'deny'
    return result === 'allow' ? 'allow' : 'deny'
  }

  private async presentModal(
    component: typeof PairingApprovalModalComponent | typeof OpenApprovalModalComponent,
    viewModel: PairingApprovalViewModel | OpenApprovalViewModel | (CommandApprovalViewModel & { commandMode: boolean }),
    context: ApprovalPresentationContext,
  ): Promise<CommandApprovalDecision | ApprovalDuration> {
    if (context.signal.aborted || performance.now() >= context.deadlineMonotonicMs) {
      return 'deny'
    }

    const modalRef = this.inZone(() => {
      try { this.hostWindow?.bringToFront() } catch { /* Attention is best effort; approval still requires a decision. */ }
      const ref = this.modalService.open(component, {
        backdrop: true,
        keyboard: false,
        centered: true,
      })
      Object.assign(ref.componentInstance, { ...viewModel, remainingSeconds: context.remainingSeconds() })
      return ref
    })

    const abortListener = (): void => {
      this.inZone(() => modalRef.dismiss('cancelled'))
    }
    context.signal.addEventListener('abort', abortListener, { once: true })

    const tick = this.inZone(() => window.setInterval(() => {
      if (context.signal.aborted) {
        modalRef.dismiss('cancelled')
        return
      }
      Object.assign(modalRef.componentInstance, {
        remainingSeconds: context.remainingSeconds(),
      })
    }, 250))

    try {
      const result = await modalRef.result
      if (context.signal.aborted || performance.now() >= context.deadlineMonotonicMs) return 'deny'
      return ['allow', 'remember', 'session', '24h', 'permanent'].includes(result) ? result : 'deny'
    } catch {
      return 'deny'
    } finally {
      context.signal.removeEventListener('abort', abortListener)
      window.clearInterval(tick)
    }
  }
}
