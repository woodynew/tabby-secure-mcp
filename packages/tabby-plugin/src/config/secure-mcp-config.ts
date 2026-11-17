import type { ConfigService } from 'tabby-core'

import type { GrantedOperationTier } from '../authorization/operation-tier-policy'

export type CommandSessionClosePolicy = 'keep' | 'after-completion'

export interface StoredPermanentAuthorization {
  profileId: string
  openSession: boolean
  operationTier: GrantedOperationTier
  profileDigest: string
  updatedAt: string
}

export type SecureMcpConfigStore = {
  secureMcp: {
    http?: { enabled: boolean; port: number }
    authorizedSshProfileIds: string[]
    permanentAuthorizations: StoredPermanentAuthorization[]
    commandSessionClosePolicy: CommandSessionClosePolicy
  }
}

export const secureMcpConfigDefaults = {
  secureMcp: {
    http: { enabled: false, port: 50333 },
    authorizedSshProfileIds: [] as string[],
    permanentAuthorizations: [] as StoredPermanentAuthorization[],
    commandSessionClosePolicy: 'keep' as CommandSessionClosePolicy,
  },
}

export function readCommandSessionClosePolicy(store: unknown): CommandSessionClosePolicy {
  const policy = (store as { secureMcp?: { commandSessionClosePolicy?: unknown } } | null)
    ?.secureMcp?.commandSessionClosePolicy
  return policy === 'after-completion' ? policy : 'keep'
}

export async function persistCommandSessionClosePolicy(
  config: Pick<ConfigService, 'store' | 'save'>,
  policy: CommandSessionClosePolicy,
): Promise<CommandSessionClosePolicy> {
  const store = config.store as SecureMcpConfigStore
  if (!store?.secureMcp) {
    throw new Error('secureMcp config section is unavailable')
  }
  const previous = readCommandSessionClosePolicy(store)
  try {
    store.secureMcp.commandSessionClosePolicy = policy
    await config.save()
    if (readCommandSessionClosePolicy(store) !== policy) {
      throw new Error('command session close policy did not persist')
    }
    return policy
  } catch (error) {
    store.secureMcp.commandSessionClosePolicy = previous
    throw error
  }
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

function parseAuthorizedSshProfileIds(store: unknown): string[] {
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

const TIER_VALUES = new Set(['none', 'ask', 'auto_edit', 'full', 'readonly', 'readwrite'])
const DIGEST_PATTERN = /^[a-f0-9]{64}$/

function parsePermanentAuthorizations(store: unknown): StoredPermanentAuthorization[] {
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
      const record = item as Partial<Omit<StoredPermanentAuthorization, 'operationTier'>> & { operationTier?: unknown }
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
        operationTier: (record.operationTier === 'readonly' || record.operationTier === 'readwrite'
          ? 'ask' : record.operationTier) as GrantedOperationTier,
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

interface ConfigSnapshot { ids: string[]; grants: StoredPermanentAuthorization[] }
interface ConfigTransaction {
  chain: Promise<void>
  revision: number
  pending: number
  visible?: ConfigSnapshot
  denied: Map<string, number>
  whitelistDenied: Map<string, number>
  store?: object
}
const transactions = new WeakMap<object, ConfigTransaction>()
const configTransactions = new WeakMap<object, ConfigTransaction>()

function bindConfig(config: Pick<ConfigService, 'store' | 'save'>): ConfigTransaction {
  const store = config.store as object
  let state = configTransactions.get(config)
  if (!state) {
    state = transaction(store)
    configTransactions.set(config, state)
  }
  if (state.store !== store) {
    state.store = store
    state.revision++
    state.visible = state.pending ? snapshot(store) : undefined
    transactions.set(store, state)
  }
  return state
}

function transaction(store: object): ConfigTransaction {
  let state = transactions.get(store)
  if (!state) {
    state = { chain: Promise.resolve(), revision: 0, pending: 0, denied: new Map(), whitelistDenied: new Map() }
    transactions.set(store, state)
  }
  return state
}

function snapshot(store: unknown): ConfigSnapshot {
  return { ids: parseAuthorizedSshProfileIds(store), grants: parsePermanentAuthorizations(store) }
}

export function readAuthorizedSshProfileIds(store: unknown, config?: Pick<ConfigService, 'store' | 'save'>): string[] {
  if (config) bindConfig(config)
  const state = store && typeof store === 'object' ? transactions.get(store) : undefined
  return (state?.visible?.ids ?? parseAuthorizedSshProfileIds(store))
    .filter(id => !state?.whitelistDenied.has(id) && (!state?.pending || parseAuthorizedSshProfileIds(store).includes(id)))
}

export function readPermanentAuthorizations(store: unknown, config?: Pick<ConfigService, 'store' | 'save'>): StoredPermanentAuthorization[] {
  if (config) bindConfig(config)
  const state = store && typeof store === 'object' ? transactions.get(store) : undefined
  if (state?.pending) {
    return []
  }
  return parsePermanentAuthorizations(store).filter(grant => !state?.denied.has(grant.profileId))
}

export function storedPermanentAuthorizations(store: object, config?: Pick<ConfigService, 'store' | 'save'>): StoredPermanentAuthorization[] {
  if (config) bindConfig(config)
  return transactions.get(store)?.visible?.grants ?? parsePermanentAuthorizations(store)
}

export function authorizationRevision(store: object, config?: Pick<ConfigService, 'store' | 'save'>): number {
  if (config) bindConfig(config)
  return transaction(store).revision
}

export function hasUnpersistedRevocations(config: Pick<ConfigService, 'store' | 'save'>): boolean {
  const state = bindConfig(config)
  const current = snapshot(config.store)
  return current.ids.some(id => state.whitelistDenied.has(id)) || current.grants.some(grant => state.denied.has(grant.profileId))
}

export function updateSecureMcpConfig(
  config: Pick<ConfigService, 'store' | 'save'>,
  update: (current: ConfigSnapshot) => ConfigSnapshot,
  affectedIds: readonly string[],
  revokedIds: readonly string[] = [],
  whitelistRevokedIds: readonly string[] = [],
  whitelistAffectedIds: readonly string[] = [],
): Promise<ConfigSnapshot> {
  const store = config.store as SecureMcpConfigStore
  if (!store?.secureMcp) {
    return Promise.reject(new Error('secureMcp config section is unavailable'))
  }
  const state = bindConfig(config)
  const revision = ++state.revision
  if (state.pending++ === 0) {
    state.visible = snapshot(store)
  }
  for (const id of revokedIds) state.denied.set(id, revision)
  for (const id of whitelistRevokedIds) state.whitelistDenied.set(id, revision)
  const task = state.chain.then(async () => {
    const previous = snapshot(store)
    try {
      if (config.store !== store) throw new Error('configuration changed during permission update')
      const next = update(previous)
      const ids = writeAuthorizedSshProfileIdsToStore(store, next.ids.filter(id => !state.whitelistDenied.has(id) || (whitelistAffectedIds.includes(id) && state.whitelistDenied.get(id)! <= revision)))
      const allowed = new Set(ids)
      writePermanentAuthorizationsToStore(store, next.grants.filter(grant => allowed.has(grant.profileId) && (!state.denied.has(grant.profileId) || (affectedIds.includes(grant.profileId) && state.denied.get(grant.profileId)! <= revision))))
      await config.save()
      if (config.store !== store) throw new Error('configuration changed during permission update')
      state.visible = snapshot(store)
      for (const id of affectedIds) {
        if ((state.denied.get(id) ?? Infinity) <= revision) state.denied.delete(id)
      }
      for (const id of whitelistAffectedIds) {
        if ((state.whitelistDenied.get(id) ?? Infinity) <= revision) state.whitelistDenied.delete(id)
      }
      return snapshot(store)
    } catch (error) {
      writeAuthorizedSshProfileIdsToStore(store, previous.ids)
      writePermanentAuthorizationsToStore(store, previous.grants)
      throw error
    } finally {
      state.revision++
      if (--state.pending === 0) state.visible = undefined
    }
  })
  state.chain = task.then(() => undefined, () => undefined)
  return task
}

export async function persistAuthorizedSshProfileIds(config: Pick<ConfigService, 'store' | 'save'>, ids: readonly string[]): Promise<string[]> {
  const previous = readAuthorizedSshProfileIds(config.store, config)
  const next = dedupeAuthorizedSshProfileIds(ids)
  const revoked = previous.filter(id => !next.includes(id))
  const added = next.filter(id => !previous.includes(id))
  return (await updateSecureMcpConfig(config, current => ({ ids: next, grants: current.grants.filter(grant => !added.includes(grant.profileId)) }), [], revoked, revoked, [...revoked, ...added])).ids
}

export async function persistPermanentAuthorizations(config: Pick<ConfigService, 'store' | 'save'>, grants: readonly StoredPermanentAuthorization[]): Promise<StoredPermanentAuthorization[]> {
  const previous = readPermanentAuthorizations(config.store, config)
  const revoked = previous.filter(old => {
    const next = grants.find(grant => grant.profileId === old.profileId)
    return !next || (old.openSession && !next.openSession) || next.operationTier !== old.operationTier
  }).map(grant => grant.profileId)
  return (await updateSecureMcpConfig(config, current => ({ ids: current.ids, grants: [...grants] }), [...previous, ...grants].map(grant => grant.profileId), revoked)).grants
}
