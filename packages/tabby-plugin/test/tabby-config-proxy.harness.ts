import deepEqual from 'deep-equal'

import { secureMcpConfigDefaults } from '../src/config/secure-mcp-config'

/**
 * Minimal structural ConfigProxy for secureMcp, matching Tabby tabby-core ConfigService.store.
 */
export function createTabbyConfigProxyHarness(initialStore: Record<string, unknown> = { version: 8 }) {
  const defaults = secureMcpConfigDefaults
  const _store = { ...initialStore }

  const store: { secureMcp: { authorizedSshProfileIds: string[] } } = {} as {
    secureMcp: { authorizedSshProfileIds: string[] }
  }

  Object.defineProperty(store, 'secureMcp', {
    enumerable: true,
    configurable: false,
    get() {
      const real = (_store.secureMcp ?? {}) as Record<string, unknown>
      if (!_store.secureMcp) {
        _store.secureMcp = real
      }
      return {
        get authorizedSshProfileIds(): string[] {
          if (real.authorizedSshProfileIds !== undefined) {
            return real.authorizedSshProfileIds as string[]
          }
          return [...defaults.secureMcp.authorizedSshProfileIds]
        },
        set authorizedSshProfileIds(value: string[]) {
          if (deepEqual(value, defaults.secureMcp.authorizedSshProfileIds)) {
            delete real.authorizedSshProfileIds
          } else {
            real.authorizedSshProfileIds = value
          }
        },
      }
    },
  })

  return {
    store,
    _store,
    snapshotPersisted(): Record<string, unknown> {
      return JSON.parse(JSON.stringify(_store)) as Record<string, unknown>
    },
  }
}
