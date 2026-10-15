import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'

import { SecureMcpSettingsComponent } from './secure-mcp-settings.component'
import { secureMcpSettingsTabMetadata } from './secure-mcp-settings.metadata'

@Injectable()
export class SecureMcpSettingsTabProvider extends SettingsTabProvider {
  id = secureMcpSettingsTabMetadata.id
  title = secureMcpSettingsTabMetadata.title
  icon = secureMcpSettingsTabMetadata.icon

  getComponentType() {
    return SecureMcpSettingsComponent
  }
}
