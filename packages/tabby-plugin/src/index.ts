import { CommonModule } from '@angular/common'
import { NgModule } from '@angular/core'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import { BOOTSTRAP_DATA, BootstrapData, ConfigProvider, ProfilesService } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

import { AuditService } from './audit/audit-service'
import { ApprovalGatekeeper } from './approval/approval-gatekeeper'
import { SystemMonotonicClock } from './approval/monotonic-clock'
import { NgBootstrapApprovalPresenter } from './approval/ng-bootstrap-approval-presenter'
import { OpenApprovalModalComponent } from './approval/open-approval-modal.component'
import { PairingApprovalModalComponent } from './approval/pairing-approval-modal.component'
import { SecureMcpConfigProvider } from './config/secure-mcp-config-provider'
import { normalizeWindowBootstrap } from './runtime/bootstrap-data'
import { PluginRuntimeLifecycle } from './runtime/plugin-runtime-lifecycle'
import { PluginRuntimeService } from './runtime/plugin-runtime-service'
import { RuntimeLeaseState } from './runtime/runtime-lease-state'
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
    RuntimeLeaseState,
    AuditService,
    NgBootstrapApprovalPresenter,
    {
      provide: ApprovalGatekeeper,
      useFactory: (
        authorizedProfiles: AuthorizedProfilesService,
        profilesService: ProfilesService,
        presenter: NgBootstrapApprovalPresenter,
        leaseState: RuntimeLeaseState,
      ) =>
        new ApprovalGatekeeper(
          authorizedProfiles,
          profilesService,
          presenter,
          new SystemMonotonicClock(),
          () => leaseState.getLeaseEpoch(),
        ),
      deps: [
        AuthorizedProfilesService,
        ProfilesService,
        NgBootstrapApprovalPresenter,
        RuntimeLeaseState,
      ],
    },
    {
      provide: PluginRuntimeService,
      useFactory: (
        bootstrapData: BootstrapData,
        leaseState: RuntimeLeaseState,
        gatekeeper: ApprovalGatekeeper,
        authorizedProfiles: AuthorizedProfilesService,
        audit: AuditService,
      ) =>
        new PluginRuntimeService(
          () => normalizeWindowBootstrap(bootstrapData),
          leaseState,
          gatekeeper,
          authorizedProfiles,
          audit,
        ),
      deps: [BOOTSTRAP_DATA, RuntimeLeaseState, ApprovalGatekeeper, AuthorizedProfilesService, AuditService],
    },
    PluginRuntimeLifecycle,
    { provide: ConfigProvider, useClass: SecureMcpConfigProvider, multi: true },
    { provide: SettingsTabProvider, useClass: SecureMcpSettingsTabProvider, multi: true },
  ],
})
export default class TabbySecureMcpPluginModule {
  constructor(_runtimeLifecycle: PluginRuntimeLifecycle) {}
}
