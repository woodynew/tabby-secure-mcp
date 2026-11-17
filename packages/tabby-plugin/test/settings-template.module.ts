import { NgModule, Pipe } from '@angular/core'
import { CommonModule } from '@angular/common'
import { SecureMcpSettingsComponent } from '../src/settings/secure-mcp-settings.component'
import { OpenApprovalModalComponent } from '../src/approval/open-approval-modal.component'
import { PairingApprovalModalComponent } from '../src/approval/pairing-approval-modal.component'

// Tabby owns the actual translation pipe; this fixture only supplies its template signature.
@Pipe({ name: 'translate' })
export class TemplateCheckTranslationPipe {
  transform(value: unknown, _parameters?: unknown): string { return String(value) }
}

@NgModule({
  imports: [CommonModule],
  declarations: [SecureMcpSettingsComponent, OpenApprovalModalComponent, PairingApprovalModalComponent, TemplateCheckTranslationPipe],
})
export class SettingsTemplateCheckModule {}
