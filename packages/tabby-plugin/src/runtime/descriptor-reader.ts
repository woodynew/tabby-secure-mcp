import { Buffer } from 'node:buffer'

import { MAX_DESCRIPTOR_BYTES, parseRuntimeDescriptor, type RuntimeDescriptor } from './descriptor'
import { isAllowedIpcEndpoint } from './endpoint-policy'
import { defaultProcessLivenessProbe, type ProcessLivenessProbe } from './process-liveness'

export type DescriptorReadErrorCode =
  | 'missing'
  | 'symlink'
  | 'oversize'
  | 'malformed'
  | 'invalid'
  | 'expired'
  | 'endpoint_forbidden'
  | 'stale_pid'

export type DescriptorReadResult =
  | { ok: true; descriptor: RuntimeDescriptor }
  | { ok: false; code: DescriptorReadErrorCode }

export interface DescriptorFileStat {
  isSymbolicLink(): boolean
  size: number
}

export interface DescriptorFileSystem {
  readFile(path: string): Promise<string>
  stat(path: string): Promise<DescriptorFileStat>
}

export async function readRuntimeDescriptor(
  descriptorPath: string,
  fs: DescriptorFileSystem,
  options: {
    nowMs?: number
    platform?: NodeJS.Platform
    isProcessAlive?: ProcessLivenessProbe
  } = {},
): Promise<DescriptorReadResult> {
  const platform = options.platform ?? process.platform
  const nowMs = options.nowMs ?? Date.now()
  const isProcessAlive = options.isProcessAlive ?? defaultProcessLivenessProbe

  let stat: DescriptorFileStat
  try {
    stat = await fs.stat(descriptorPath)
  } catch {
    return { ok: false, code: 'missing' }
  }

  if (stat.isSymbolicLink()) {
    return { ok: false, code: 'symlink' }
  }

  if (stat.size > MAX_DESCRIPTOR_BYTES) {
    return { ok: false, code: 'oversize' }
  }

  let raw: string
  try {
    raw = await fs.readFile(descriptorPath)
  } catch {
    return { ok: false, code: 'missing' }
  }

  if (Buffer.byteLength(raw, 'utf8') > MAX_DESCRIPTOR_BYTES) {
    return { ok: false, code: 'oversize' }
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch {
    return { ok: false, code: 'malformed' }
  }

  const descriptor = parseRuntimeDescriptor(parsedJson)
  if (!descriptor) {
    return { ok: false, code: 'invalid' }
  }
  if (descriptor.expires_at <= nowMs) {
    return { ok: false, code: 'expired' }
  }

  if (!isAllowedIpcEndpoint(descriptor.endpoint, platform)) {
    return { ok: false, code: 'endpoint_forbidden' }
  }

  if (!isProcessAlive(descriptor.pid)) {
    return { ok: false, code: 'stale_pid' }
  }

  return { ok: true, descriptor }
}
