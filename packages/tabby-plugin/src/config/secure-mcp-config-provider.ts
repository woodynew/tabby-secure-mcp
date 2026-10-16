import { ConfigProvider } from 'tabby-core'

import { secureMcpConfigDefaults } from './secure-mcp-config'

export class SecureMcpConfigProvider extends ConfigProvider {
  defaults = secureMcpConfigDefaults
  platformDefaults = {}
}
