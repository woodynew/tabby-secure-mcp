import { Component, HostListener, Inject, Input } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'

@Component({
  selector: 'secure-mcp-pairing-approval-modal',
  template: `
    <div class="modal-header">
      <h4 class="modal-title">Approve MCP client connection</h4>
      <button type="button" class="btn-close" aria-label="Close" (click)="reject('dismiss')"></button>
    </div>
    <div class="modal-body">
      <p>A local MCP client is requesting access. Its declared name is not verified program identity.</p>
      <dl>
        <dt>Credential name</dt>
        <dd>{{ clientIdentity }}</dd>
        <dt>Declared client name</dt>
        <dd>{{ companionLabel }}</dd>
      </dl>
      <label *ngIf="allowDuration" class="d-block">
        Remember this client
        <select [value]="duration" (change)="duration = $any($event.target).value">
          <option value="session">This session only (up to 24 hours)</option>
          <option value="24h">Remember for 24 hours</option>
          <option value="permanent">Permanent — until revoked</option>
        </select>
      </label>
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
  @Input() allowDuration = false
  duration: 'session' | '24h' | 'permanent' = 'session'

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
    this.activeModal.close(this.allowDuration ? this.duration : 'allow')
  }

  reject(_reason: string): void {
    this.activeModal.dismiss('deny')
  }
}
