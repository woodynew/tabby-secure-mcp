import type { ConfigService } from 'tabby-core'

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
  const secureMcp = (store as Record<string, unknown>).secureMcp
  if (!secureMcp || typeof secureMcp !== 'object') {
    return []
  }
  const ids = (secureMcp as Record<string, unknown>).authorizedSshProfileIds
  if (!Array.isArray(ids)) {
    return []
  }
  return dedupeAuthorizedSshProfileIds(ids)
}

export async function persistAuthorizedSshProfileIds(
  config: Pick<ConfigService, 'store' | 'save'>,
  ids: readonly string[],
): Promise<string[]> {
  const deduped = dedupeAuthorizedSshProfileIds(ids)
  if (!config.store || typeof config.store !== 'object') {
    config.store = {}
  }
  const store = config.store as Record<string, unknown>
  const secureMcp =
    store.secureMcp && typeof store.secureMcp === 'object'
      ? (store.secureMcp as Record<string, unknown>)
      : {}
  secureMcp.authorizedSshProfileIds = deduped
  store.secureMcp = secureMcp
  await config.save()
  return deduped
}
