import type { ConfigService } from 'tabby-core'

import type { GrantedOperationTier } from '../authorization/operation-tier-policy'

export interface StoredPermanentAuthorization {
  profileId: string
  openSession: boolean
  operationTier: GrantedOperationTier
  profileDigest: string
  updatedAt: string
}

export type SecureMcpConfigStore = {
  secureMcp: {
    authorizedSshProfileIds: string[]
    permanentAuthorizations: StoredPermanentAuthorization[]
  }
}

export const secureMcpConfigDefaults = {
  secureMcp: {
    authorizedSshProfileIds: [] as string[],
    permanentAuthorizations: [] as StoredPermanentAuthorization[],
  },
}

export function dedupeAuthorizedSshProfileIds(ids: readonly unknown[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of ids) {
    if (typeof item !== 'string') {
      continue
    }
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) {
      continue
    }
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

export function readAuthorizedSshProfileIds(store: unknown): string[] {
  if (!store || typeof store !== 'object') {
    return []
  }
  const secureMcp = (store as { secureMcp?: { authorizedSshProfileIds?: unknown } }).secureMcp
  if (!secureMcp || typeof secureMcp !== 'object') {
    return []
  }
  const ids = secureMcp.authorizedSshProfileIds
  if (!Array.isArray(ids)) {
    return []
  }
  return dedupeAuthorizedSshProfileIds(ids)
}

export function writeAuthorizedSshProfileIdsToStore(
  store: SecureMcpConfigStore,
  ids: readonly string[],
): string[] {
  const deduped = dedupeAuthorizedSshProfileIds(ids)
  store.secureMcp.authorizedSshProfileIds = deduped
  return deduped
}

const TIER_VALUES = new Set(['none', 'readonly', 'readwrite', 'full'])
const DIGEST_PATTERN = /^[a-f0-9]{64}$/

export function readPermanentAuthorizations(store: unknown): StoredPermanentAuthorization[] {
  if (!store || typeof store !== 'object') {
    return []
  }
  const secureMcp = (store as { secureMcp?: { permanentAuthorizations?: unknown } }).secureMcp
  if (!secureMcp || typeof secureMcp !== 'object' || !Array.isArray(secureMcp.permanentAuthorizations)) {
    return []
  }
  const result: StoredPermanentAuthorization[] = []
  const seen = new Set<string>()
  for (const item of secureMcp.permanentAuthorizations) {
    if (!item || typeof item !== 'object') {
      continue
    }
    const record = item as Partial<StoredPermanentAuthorization>
    const profileId = typeof record.profileId === 'string' ? record.profileId.trim() : ''
    if (
      !profileId ||
      seen.has(profileId) ||
      typeof record.openSession !== 'boolean' ||
      typeof record.operationTier !== 'string' ||
      !TIER_VALUES.has(record.operationTier) ||
      typeof record.profileDigest !== 'string' ||
      !DIGEST_PATTERN.test(record.profileDigest) ||
      typeof record.updatedAt !== 'string' ||
      record.updatedAt.length === 0
    ) {
      continue
    }
    seen.add(profileId)
    result.push({
      profileId,
      openSession: record.openSession,
      operationTier: record.operationTier as GrantedOperationTier,
      profileDigest: record.profileDigest,
      updatedAt: record.updatedAt,
    })
  }
  return result
}

export function writePermanentAuthorizationsToStore(
  store: SecureMcpConfigStore,
  grants: readonly StoredPermanentAuthorization[],
): StoredPermanentAuthorization[] {
  const deduped = readPermanentAuthorizations({ secureMcp: { permanentAuthorizations: [...grants] } })
  store.secureMcp.permanentAuthorizations = deduped
  return deduped
}

export function effectivePermanentAuthorization(
  grant: StoredPermanentAuthorization | undefined,
  profileDigest: string,
): { openSession: boolean; operationTier: GrantedOperationTier } {
  if (!grant || grant.profileDigest !== profileDigest) {
    return { openSession: false, operationTier: 'none' }
  }
  return { openSession: grant.openSession, operationTier: grant.operationTier }
}

export async function persistAuthorizedSshProfileIds(
  config: Pick<ConfigService, 'store' | 'save'>,
  ids: readonly string[],
): Promise<string[]> {
  const store = config.store as SecureMcpConfigStore
  if (!store?.secureMcp) {
    throw new Error('secureMcp config section is unavailable')
  }
  const deduped = writeAuthorizedSshProfileIdsToStore(store, ids)
  const allowed = new Set(deduped)
  writePermanentAuthorizationsToStore(
    store,
    readPermanentAuthorizations(store).filter((grant) => allowed.has(grant.profileId)),
  )
  await config.save()
  return deduped
}

export async function persistPermanentAuthorizations(
  config: Pick<ConfigService, 'store' | 'save'>,
  grants: readonly StoredPermanentAuthorization[],
): Promise<StoredPermanentAuthorization[]> {
  const store = config.store as SecureMcpConfigStore
  if (!store?.secureMcp) {
    throw new Error('secureMcp config section is unavailable')
  }
  const allowed = new Set(readAuthorizedSshProfileIds(store))
  const saved = writePermanentAuthorizationsToStore(
    store,
    grants.filter((grant) => allowed.has(grant.profileId)),
  )
  await config.save()
  return saved
}
