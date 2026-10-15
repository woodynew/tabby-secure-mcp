import { CommonModule } from '@angular/common'
import { NgModule } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { ConfigProvider } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

import { SecureMcpConfigProvider } from './config/secure-mcp-config-provider'
import { AuthorizedProfilesService } from './services/authorized-profiles.service'
import { SecureMcpSettingsComponent } from './settings/secure-mcp-settings.component'
import { SecureMcpSettingsTabProvider } from './settings/secure-mcp-settings-tab.provider'

@NgModule({
  imports: [CommonModule, FormsModule],
  declarations: [SecureMcpSettingsComponent],
  providers: [
    AuthorizedProfilesService,
    { provide: ConfigProvider, useClass: SecureMcpConfigProvider, multi: true },
    { provide: SettingsTabProvider, useClass: SecureMcpSettingsTabProvider, multi: true },
  ],
})
export default class TabbySecureMcpPluginModule {}
