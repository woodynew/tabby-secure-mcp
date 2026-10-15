import { unlink } from 'node:fs/promises'

import type { PluginGateway } from '../gateway/plugin-gateway.js'
import { writeRuntimeDescriptor, type RuntimeDescriptor, type RuntimePaths } from './paths.js'

export interface RuntimeArtifactOwnership {
  ownsEndpoint: boolean
  ownsDescriptor: boolean
}

export interface BindCompanionRuntimeOptions {
  platform?: NodeJS.Platform
  writeDescriptor?: typeof writeRuntimeDescriptor
}

export async function bindCompanionRuntimeArtifacts(
  gateway: PluginGateway,
  paths: RuntimePaths,
  descriptor: RuntimeDescriptor,
  options: BindCompanionRuntimeOptions = {},
): Promise<RuntimeArtifactOwnership> {
  const platform = options.platform ?? process.platform
  const writeDescriptor = options.writeDescriptor ?? writeRuntimeDescriptor
  let ownsEndpoint = false
  let ownsDescriptor = false
  await gateway.listen()
  ownsEndpoint = true
  try {
    await writeDescriptor(paths, descriptor, { platform })
    ownsDescriptor = true
  } catch (error) {
    await unlink(paths.endpoint).catch(() => undefined)
    throw error
  }
  return { ownsEndpoint, ownsDescriptor }
}
