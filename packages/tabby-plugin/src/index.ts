import { CommonModule } from '@angular/common'
import { Inject, NgModule, NgZone } from '@angular/core'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import { BOOTSTRAP_DATA, BootstrapData, ConfigProvider, ConfigService, ProfilesService, type BaseTabComponent } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

import { AuditService } from './audit/audit-service'
import { ApprovalGatekeeper } from './approval/approval-gatekeeper'
import { SystemApprovalScheduler } from './approval/approval-scheduler'
import { SystemMonotonicClock } from './approval/monotonic-clock'
import { PermanentAuthorizationStore } from './authorization/permanent-authorization-store'
import { NgBootstrapApprovalPresenter } from './approval/ng-bootstrap-approval-presenter'
import { OpenApprovalModalComponent } from './approval/open-approval-modal.component'
import { PairingApprovalModalComponent } from './approval/pairing-approval-modal.component'
import { SecureMcpConfigProvider } from './config/secure-mcp-config-provider'
import { normalizeWindowBootstrap } from './runtime/bootstrap-data'
import { PluginRuntimeLifecycle } from './runtime/plugin-runtime-lifecycle'
import { PluginHttpRuntime } from './runtime/plugin-http-runtime'
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
    PermanentAuthorizationStore,
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
        memory: PermanentAuthorizationStore,
        audit: AuditService,
      ) =>
        new ApprovalGatekeeper(
          authorizedProfiles,
          profilesService,
          presenter,
          new SystemMonotonicClock(),
          () => leaseState.getLeaseEpoch(),
          new SystemApprovalScheduler(),
          memory,
          { audit, closeTab: async tab => { (tab as BaseTabComponent).destroy() } },
        ),
      deps: [
        AuthorizedProfilesService,
        ProfilesService,
        NgBootstrapApprovalPresenter,
        RuntimeLeaseState,
        PermanentAuthorizationStore,
        AuditService,
      ],
    },
    {
      provide: PluginHttpRuntime,
      useFactory: (
        bootstrapData: BootstrapData,
        leaseState: RuntimeLeaseState,
        gatekeeper: ApprovalGatekeeper,
        authorizedProfiles: AuthorizedProfilesService,
        audit: AuditService,
        config: ConfigService,
        presenter: NgBootstrapApprovalPresenter,
        zone: NgZone,
      ) =>
        new PluginHttpRuntime(
          config,
          () => normalizeWindowBootstrap(bootstrapData),
          leaseState,
          gatekeeper,
          authorizedProfiles,
          audit,
          presenter,
          { notify: work => zone.run(work) },
        ),
      deps: [BOOTSTRAP_DATA, RuntimeLeaseState, ApprovalGatekeeper, AuthorizedProfilesService, AuditService, ConfigService, NgBootstrapApprovalPresenter, NgZone],
    },
    PluginRuntimeLifecycle,
    { provide: ConfigProvider, useClass: SecureMcpConfigProvider, multi: true },
    { provide: SettingsTabProvider, useClass: SecureMcpSettingsTabProvider, multi: true },
  ],
})
export default class TabbySecureMcpPluginModule {
  constructor(@Inject(PluginRuntimeLifecycle) _runtimeLifecycle: PluginRuntimeLifecycle) {}
}
