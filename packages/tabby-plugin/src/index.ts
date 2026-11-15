import { CommonModule } from '@angular/common'
import { Inject, NgModule } from '@angular/core'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import TabbyCoreModule, { BOOTSTRAP_DATA, BootstrapData, ConfigProvider, ConfigService, ProfilesService } from 'tabby-core'
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
import { readCommandSessionClosePolicy } from './config/secure-mcp-config'
import { normalizeWindowBootstrap } from './runtime/bootstrap-data'
import { PluginRuntimeLifecycle } from './runtime/plugin-runtime-lifecycle'
import { PluginRuntimeService } from './runtime/plugin-runtime-service'
import { RuntimeLeaseState } from './runtime/runtime-lease-state'
import { AuthorizedProfilesService } from './services/authorized-profiles.service'
import { SecureMcpSettingsComponent } from './settings/secure-mcp-settings.component'
import { SecureMcpSettingsTabProvider } from './settings/secure-mcp-settings-tab.provider'
import { SecureMcpTranslations } from './i18n/secure-mcp-translations'

@NgModule({
  imports: [TabbyCoreModule, CommonModule, NgbModule],
  declarations: [
    SecureMcpSettingsComponent,
    PairingApprovalModalComponent,
    OpenApprovalModalComponent,
  ],
  providers: [
    SecureMcpTranslations,
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
        config: ConfigService,
      ) =>
        new ApprovalGatekeeper(
          authorizedProfiles,
          profilesService,
          presenter,
          new SystemMonotonicClock(),
          () => leaseState.getLeaseEpoch(),
          new SystemApprovalScheduler(),
          memory,
          () => readCommandSessionClosePolicy(config.store),
        ),
      deps: [
        AuthorizedProfilesService,
        ProfilesService,
        NgBootstrapApprovalPresenter,
        RuntimeLeaseState,
        PermanentAuthorizationStore,
        ConfigService,
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
  constructor(
    @Inject(SecureMcpTranslations) _translations: SecureMcpTranslations,
    @Inject(PluginRuntimeLifecycle) _runtimeLifecycle: PluginRuntimeLifecycle,
  ) {}
}
