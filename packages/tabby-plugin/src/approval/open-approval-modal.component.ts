import { Component, HostListener, Inject, Input } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'

@Component({
  selector: 'secure-mcp-open-approval-modal',
  template: `
    <div class="modal-header">
      <h4 class="modal-title">{{ (commandMode ? 'secureMcp.approveCommand' : 'secureMcp.approveOpen') | translate }}</h4>
      <button type="button" class="btn-close" [attr.aria-label]="'secureMcp.close' | translate" (click)="reject('dismiss')"></button>
    </div>
    <div class="modal-body">
      <dl>
        <dt>{{ 'secureMcp.client' | translate }}</dt>
        <dd>{{ clientIdentity }}</dd>
        <dt>{{ 'secureMcp.tool' | translate }}</dt>
        <dd>{{ toolName }}</dd>
        <dt>{{ 'secureMcp.target' | translate }}</dt>
        <dd>{{ targetDisplayName }}</dd>
        <dt>{{ 'secureMcp.operation' | translate }}</dt>
        <dd><pre class="mb-0">{{ operationDisplay }}</pre></dd>
      </dl>
      <div *ngIf="commandMode">
        <p>{{ 'secureMcp.commandRisk' | translate }}: {{ (risk === 'low' ? 'secureMcp.riskLow' : risk === 'high' ? 'secureMcp.riskHigh' : 'secureMcp.riskUnknown') | translate }}</p>
        <p>{{ 'secureMcp.commandRiskReason' | translate }}: {{ riskReasonKey | translate }}</p>
        <p *ngIf="allowRemember">
          {{ 'secureMcp.approvalScope' | translate }}: <code>{{ ruleText }}</code>
          {{ (ruleKind === 'family' ? 'secureMcp.commandApprovalFamilyScope' : 'secureMcp.commandApprovalExactScope') | translate }}
          <code *ngIf="ruleKind === 'exact'">{{ ruleFingerprint }}</code>
        </p>
        <p *ngIf="approveConnection">{{ 'secureMcp.alsoApproveConnection' | translate }}</p>
      </div>
      <p *ngIf="commandMode && allowRemember" class="text-muted">{{ 'secureMcp.commandRememberLocalHelp' | translate }}</p>
      <p>{{ 'secureMcp.timeRemaining' | translate:{ seconds: remainingSeconds } }}</p>
      <p *ngIf="!commandMode">{{ 'secureMcp.rememberOpen' | translate }}</p>
    </div>
    <div class="modal-footer">
      <button type="button" class="btn btn-outline-danger" ngbAutofocus (click)="reject('reject')">{{ 'secureMcp.reject' | translate }}</button>
      <button type="button" class="btn btn-primary" (click)="allow()">{{ (commandMode ? 'secureMcp.allowOnce' : 'secureMcp.allowConnection') | translate }}</button>
      <button *ngIf="commandMode && allowRemember" type="button" class="btn btn-outline-primary" (click)="remember()">{{ 'secureMcp.allowAndRemember' | translate }}</button>
    </div>
  `,
})
export class OpenApprovalModalComponent {
  @Input() clientIdentity = ''
  @Input() toolName = ''
  @Input() targetDisplayName = ''
  @Input() operationDisplay = ''
  @Input() remainingSeconds = 0
  @Input() commandMode = false
  @Input() risk = 'unknown'
  @Input() riskReasonKey = 'secureMcp.commandReason_unknown'
  @Input() ruleKind: 'family' | 'exact' = 'exact'
  @Input() ruleText = ''
  @Input() ruleFingerprint = ''
  @Input() allowRemember = false
  @Input() approveConnection = false

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

  remember(): void {
    if (this.commandMode && this.allowRemember) this.activeModal.close('remember')
  }

  reject(_reason: string): void {
    this.activeModal.dismiss('deny')
  }
}
