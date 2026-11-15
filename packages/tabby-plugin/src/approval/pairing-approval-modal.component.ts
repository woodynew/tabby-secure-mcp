import { Component, HostListener, Inject, Input } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'

@Component({
  selector: 'secure-mcp-pairing-approval-modal',
  template: `
    <div class="modal-header">
      <h4 class="modal-title">{{ 'secureMcp.approvePairing' | translate }}</h4>
      <button type="button" class="btn-close" [attr.aria-label]="'secureMcp.close' | translate" (click)="reject('dismiss')"></button>
    </div>
    <div class="modal-body">
      <p>{{ 'secureMcp.pairingRequested' | translate }}</p>
      <dl>
        <dt>{{ 'secureMcp.client' | translate }}</dt>
        <dd>{{ clientIdentity }}</dd>
        <dt>{{ 'secureMcp.companion' | translate }}</dt>
        <dd>{{ companionLabel }}</dd>
      </dl>
      <p>{{ 'secureMcp.timeRemaining' | translate:{ seconds: remainingSeconds } }}</p>
    </div>
    <div class="modal-footer">
      <button type="button" class="btn btn-outline-danger" ngbAutofocus (click)="reject('reject')">{{ 'secureMcp.reject' | translate }}</button>
      <button type="button" class="btn btn-primary" (click)="allow()">{{ 'secureMcp.allow' | translate }}</button>
    </div>
  `,
})
export class PairingApprovalModalComponent {
  @Input() clientIdentity = ''
  @Input() companionLabel = ''
  @Input() remainingSeconds = 0

  constructor(@Inject(NgbActiveModal) private readonly activeModal: NgbActiveModal) {}

  @HostListener('window:blur')
  onWindowBlur(): void {
    this.reject('blur')
  }

  @HostListener('document:keydown.escape', ['$event'])
  onEscape(event: KeyboardEvent): void {
    event.preventDefault()
    this.reject('escape')
  }

  allow(): void {
    this.activeModal.close('allow')
  }

  reject(_reason: string): void {
    this.activeModal.dismiss('deny')
  }
}
