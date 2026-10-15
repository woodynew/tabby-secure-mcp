import { Component, HostListener, Inject, Input } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'

@Component({
  selector: 'secure-mcp-open-approval-modal',
  template: `
    <div class="modal-header">
      <h4 class="modal-title">Approve SSH profile open</h4>
      <button type="button" class="btn-close" aria-label="Close" (click)="reject('dismiss')"></button>
    </div>
    <div class="modal-body">
      <dl>
        <dt>Client</dt>
        <dd>{{ clientIdentity }}</dd>
        <dt>Tool</dt>
        <dd>{{ toolName }}</dd>
        <dt>Target</dt>
        <dd>{{ targetDisplayName }}</dd>
        <dt>Operation</dt>
        <dd><pre class="mb-0">{{ operationDisplay }}</pre></dd>
      </dl>
      <p>Time remaining: {{ remainingSeconds }}s</p>
    </div>
    <div class="modal-footer">
      <button type="button" class="btn btn-outline-danger" ngbAutofocus (click)="reject('reject')">Reject</button>
      <button type="button" class="btn btn-primary" (click)="allow()">Allow</button>
    </div>
  `,
})
export class OpenApprovalModalComponent {
  @Input() clientIdentity = ''
  @Input() toolName = ''
  @Input() targetDisplayName = ''
  @Input() operationDisplay = ''
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
