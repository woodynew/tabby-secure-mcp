import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { homedir as nodeHomedir, tmpdir as nodeTmpdir } from 'node:os'
import path from 'node:path'

import {
  assertValidRuntimeDescriptor,
  type RuntimeDescriptor,
} from './descriptor.js'

export interface RuntimePathDependencies {
  platform?: NodeJS.Platform
  env?: Readonly<Record<string, string | undefined>>
  homedir?: () => string
  tmpdir?: () => string
  randomBytes?: (size: number) => Uint8Array
}

export interface RuntimePaths {
  runtimeDirectory: string
  endpoint: string
  descriptorPath: string
  lockPath: string
}

export type { RuntimeDescriptor } from './descriptor.js'

export interface WriteRuntimeDescriptorOptions {
  platform?: NodeJS.Platform
}

export function createRuntimePaths(
  dependencies: RuntimePathDependencies = {},
): RuntimePaths {
  const platform = dependencies.platform ?? process.platform
  const env = dependencies.env ?? process.env
  const getHome = dependencies.homedir ?? nodeHomedir
  const getTmp = dependencies.tmpdir ?? nodeTmpdir
  const getRandomBytes = dependencies.randomBytes ?? nodeRandomBytes

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? path.win32.join(getHome(), 'AppData', 'Local')
    const runtimeDirectory = path.win32.join(localAppData, 'tabby-secure-mcp')
    const suffix = Buffer.from(getRandomBytes(8)).toString('hex')
    return {
      runtimeDirectory,
      endpoint: `\\\\.\\pipe\\tabby-secure-mcp-${suffix}`,
      descriptorPath: path.win32.join(runtimeDirectory, 'descriptor.json'),
      lockPath: path.win32.join(runtimeDirectory, 'companion.lock'),
    }
  }

  const runtimeBase =
    platform === 'linux' && env.XDG_RUNTIME_DIR ? env.XDG_RUNTIME_DIR : getTmp()
  const runtimeDirectory = path.posix.join(runtimeBase, 'tabby-secure-mcp')
  return {
    runtimeDirectory,
    endpoint: path.posix.join(runtimeDirectory, 'companion.sock'),
    descriptorPath: path.posix.join(runtimeDirectory, 'descriptor.json'),
    lockPath: path.posix.join(runtimeDirectory, 'companion.lock'),
  }
}

export async function writeRuntimeDescriptor(
  paths: RuntimePaths,
  descriptor: RuntimeDescriptor,
  options: WriteRuntimeDescriptorOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform
  assertValidRuntimeDescriptor(descriptor, paths.endpoint)
  await mkdir(paths.runtimeDirectory, { recursive: true, mode: 0o700 })
  if (platform !== 'win32') {
    await chmod(paths.runtimeDirectory, 0o700)
  }
  await writeFile(paths.descriptorPath, `${JSON.stringify(descriptor)}\n`, {
    encoding: 'utf8',
    flag: 'w',
    mode: 0o600,
  })
  if (platform !== 'win32') {
    await chmod(paths.descriptorPath, 0o600)
  }
}
