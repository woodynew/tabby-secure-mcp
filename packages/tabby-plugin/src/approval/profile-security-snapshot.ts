import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { PartialProfile, Profile } from 'tabby-core'

export const PROFILE_SECURITY_SNAPSHOT_VERSION = 1

export interface ProfileSecuritySnapshot {
  version: number
  digest: string
}

export class ProfileSnapshotError extends Error {
  constructor() {
    super('profile snapshot unavailable')
    this.name = 'ProfileSnapshotError'
  }
}

function canonicalize(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'bigint') {
    throw new ProfileSnapshotError()
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new ProfileSnapshotError()
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ProfileSnapshotError()
    }
    return value
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (seen.has(value)) {
    throw new ProfileSnapshotError()
  }
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map(entry => canonicalize(entry, seen))
  }

  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const canonical: Record<string, unknown> = {}
  for (const key of keys) {
    canonical[key] = canonicalize(record[key], seen)
  }
  return canonical
}

function buildSecurityProjection(profile: PartialProfile<Profile>): unknown {
  const projection = canonicalize(
    {
      id: profile.id ?? '',
      provider: profile.type,
      type: profile.type,
      name: profile.name,
      options: profile.options ?? {},
    },
    new WeakSet(),
  )
  try {
    JSON.stringify(projection)
  } catch {
    throw new ProfileSnapshotError()
  }
  return projection
}

function digestProjection(projection: unknown, runKey: Uint8Array): string {
  const payload = JSON.stringify(projection)
  return createHmac('sha256', Buffer.from(runKey))
    .update(payload, 'utf8')
    .digest('hex')
}

export function stableProfileDigest(profile: PartialProfile<Profile>): string {
  return createHash('sha256').update(JSON.stringify(buildSecurityProjection(profile)), 'utf8').digest('hex')
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
  if (left.version !== right.version) {
    return false
  }
  try {
    const leftBytes = Buffer.from(left.digest, 'hex')
    const rightBytes = Buffer.from(right.digest, 'hex')
    if (leftBytes.length !== rightBytes.length) {
      return false
    }
    return timingSafeEqual(leftBytes, rightBytes)
  } catch {
    return false
  }
}
