import { homedir as nodeHomedir } from 'node:os'
import path from 'node:path'

export interface AuditPathDependencies {
  platform?: NodeJS.Platform
  env?: Readonly<Record<string, string | undefined>>
  homedir?: () => string
}

export function resolveAuditLogPath(dependencies: AuditPathDependencies = {}): string {
  const platform = dependencies.platform ?? process.platform
  const env = dependencies.env ?? process.env
  const getHome = dependencies.homedir ?? nodeHomedir

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? path.win32.join(getHome(), 'AppData', 'Local')
    return path.win32.join(localAppData, 'tabby-secure-mcp', 'audit.jsonl')
  }

  const configHome =
    env.XDG_CONFIG_HOME ?? path.posix.join(getHome(), '.config')
  return path.posix.join(configHome, 'tabby-secure-mcp', 'audit.jsonl')
}
