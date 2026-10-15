import { homedir as nodeHomedir, tmpdir as nodeTmpdir } from 'node:os'
import path from 'node:path'

export interface RuntimePathDependencies {
  platform?: NodeJS.Platform
  env?: Readonly<Record<string, string | undefined>>
  homedir?: () => string
  tmpdir?: () => string
}

export interface PluginDescriptorPaths {
  runtimeDirectory: string
  descriptorPath: string
}

export function resolvePluginDescriptorPaths(
  dependencies: RuntimePathDependencies = {},
): PluginDescriptorPaths {
  const platform = dependencies.platform ?? process.platform
  const env = dependencies.env ?? process.env
  const getHome = dependencies.homedir ?? nodeHomedir
  const getTmp = dependencies.tmpdir ?? nodeTmpdir

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? path.win32.join(getHome(), 'AppData', 'Local')
    const runtimeDirectory = path.win32.join(localAppData, 'tabby-secure-mcp')
    return {
      runtimeDirectory,
      descriptorPath: path.win32.join(runtimeDirectory, 'descriptor.json'),
    }
  }

  const runtimeBase =
    platform === 'linux' && env.XDG_RUNTIME_DIR ? env.XDG_RUNTIME_DIR : getTmp()
  const runtimeDirectory = path.posix.join(runtimeBase, 'tabby-secure-mcp')
  return {
    runtimeDirectory,
    descriptorPath: path.posix.join(runtimeDirectory, 'descriptor.json'),
  }
}
