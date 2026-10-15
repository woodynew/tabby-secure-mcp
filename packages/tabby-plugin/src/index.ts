import { CommonModule } from '@angular/common'
import { NgModule } from '@angular/core'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import { ConfigProvider, ProfilesService } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

import { ApprovalGatekeeper, type LeaseEpochSource } from './approval/approval-gatekeeper'
import { SystemMonotonicClock } from './approval/monotonic-clock'
import { NgBootstrapApprovalPresenter } from './approval/ng-bootstrap-approval-presenter'
import { OpenApprovalModalComponent } from './approval/open-approval-modal.component'
import { PairingApprovalModalComponent } from './approval/pairing-approval-modal.component'
import { SecureMcpConfigProvider } from './config/secure-mcp-config-provider'
import { AuthorizedProfilesService } from './services/authorized-profiles.service'
import { SecureMcpSettingsComponent } from './settings/secure-mcp-settings.component'
import { SecureMcpSettingsTabProvider } from './settings/secure-mcp-settings-tab.provider'

@NgModule({
  imports: [CommonModule, NgbModule],
  declarations: [
    SecureMcpSettingsComponent,
    PairingApprovalModalComponent,
    OpenApprovalModalComponent,
  ],
  providers: [
    AuthorizedProfilesService,
    NgBootstrapApprovalPresenter,
    {
      provide: ApprovalGatekeeper,
      useFactory: (
        authorizedProfiles: AuthorizedProfilesService,
        profilesService: ProfilesService,
        presenter: NgBootstrapApprovalPresenter,
      ) =>
        new ApprovalGatekeeper(
          authorizedProfiles,
          profilesService,
          presenter,
          new SystemMonotonicClock(),
          (() => null) as LeaseEpochSource,
        ),
      deps: [AuthorizedProfilesService, ProfilesService, NgBootstrapApprovalPresenter],
    },
    { provide: ConfigProvider, useClass: SecureMcpConfigProvider, multi: true },
    { provide: SettingsTabProvider, useClass: SecureMcpSettingsTabProvider, multi: true },
  ],
})
export default class TabbySecureMcpPluginModule {}
