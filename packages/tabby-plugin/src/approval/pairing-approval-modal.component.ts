import { Component, HostListener, Input } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'

@Component({
  selector: 'secure-mcp-pairing-approval-modal',
  template: `
    <div class="modal-header">
      <h4 class="modal-title">Approve companion pairing</h4>
      <button type="button" class="btn-close" aria-label="Close" (click)="reject('dismiss')"></button>
    </div>
    <div class="modal-body">
      <p>A local companion is requesting pairing approval.</p>
      <dl>
        <dt>Client</dt>
        <dd>{{ clientIdentity }}</dd>
        <dt>Companion</dt>
        <dd>{{ companionLabel }}</dd>
      </dl>
      <p>Time remaining: {{ remainingSeconds }}s</p>
    </div>
    <div class="modal-footer">
      <button type="button" class="btn btn-outline-danger" ngbAutofocus (click)="reject('reject')">Reject</button>
      <button type="button" class="btn btn-primary" (click)="allow()">Allow</button>
    </div>
  `,
})
export class PairingApprovalModalComponent {
  @Input() clientIdentity = ''
  @Input() companionLabel = ''
  @Input() remainingSeconds = 0

  constructor(private readonly activeModal: NgbActiveModal) {}

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
