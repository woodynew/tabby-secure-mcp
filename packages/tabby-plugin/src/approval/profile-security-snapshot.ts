import { createHmac } from 'node:crypto'
import type { PartialProfile, Profile } from 'tabby-core'

export const PROFILE_SECURITY_SNAPSHOT_VERSION = 1

export interface ProfileSecuritySnapshot {
  version: number
  digest: string
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(entry => canonicalize(entry))
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const canonical: Record<string, unknown> = {}
  for (const key of keys) {
    canonical[key] = canonicalize(record[key])
  }
  return canonical
}

function buildSecurityProjection(profile: PartialProfile<Profile>): unknown {
  return canonicalize({
    id: profile.id ?? '',
    provider: profile.type,
    type: profile.type,
    name: profile.name,
    options: profile.options ?? {},
  })
}

function digestProjection(projection: unknown, runKey: Uint8Array): string {
  const payload = JSON.stringify(projection)
  return createHmac('sha256', Buffer.from(runKey))
    .update(payload, 'utf8')
    .digest('hex')
}

export function buildProfileSecuritySnapshot(
  profile: PartialProfile<Profile>,
  runKey: Uint8Array,
): ProfileSecuritySnapshot {
  const projection = buildSecurityProjection(profile)
  return {
    version: PROFILE_SECURITY_SNAPSHOT_VERSION,
    digest: digestProjection(projection, runKey),
  }
}

export function profileSecuritySnapshotsEqual(
  left: ProfileSecuritySnapshot,
  right: ProfileSecuritySnapshot,
): boolean {
  return left.version === right.version && left.digest === right.digest
}
