import type { ConfigService } from 'tabby-core'

export type SecureMcpConfigStore = {
  secureMcp: {
    authorizedSshProfileIds: string[]
  }
}

export const secureMcpConfigDefaults = {
  secureMcp: {
    authorizedSshProfileIds: [] as string[],
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

export async function persistAuthorizedSshProfileIds(
  config: Pick<ConfigService, 'store' | 'save'>,
  ids: readonly string[],
): Promise<string[]> {
  const store = config.store as SecureMcpConfigStore
  if (!store?.secureMcp) {
    throw new Error('secureMcp config section is unavailable')
  }
  const deduped = writeAuthorizedSshProfileIdsToStore(store, ids)
  await config.save()
  return deduped
}
