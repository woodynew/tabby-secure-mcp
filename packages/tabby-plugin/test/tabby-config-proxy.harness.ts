import deepEqual from 'deep-equal'

import {
  secureMcpConfigDefaults,
  type StoredPermanentAuthorization,
} from '../src/config/secure-mcp-config'

/**
 * Minimal structural ConfigProxy for secureMcp, matching Tabby tabby-core ConfigService.store.
 */
export function createTabbyConfigProxyHarness(initialStore: Record<string, unknown> = { version: 8 }) {
  const defaults = secureMcpConfigDefaults
  const _store = { ...initialStore }

  const store: {
    secureMcp: {
      authorizedSshProfileIds: string[]
      permanentAuthorizations: StoredPermanentAuthorization[]
    }
  } = {} as {
    secureMcp: {
      authorizedSshProfileIds: string[]
      permanentAuthorizations: StoredPermanentAuthorization[]
    }
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
        get permanentAuthorizations(): StoredPermanentAuthorization[] {
          if (real.permanentAuthorizations !== undefined) {
            return real.permanentAuthorizations as StoredPermanentAuthorization[]
          }
          return [...defaults.secureMcp.permanentAuthorizations]
        },
        set permanentAuthorizations(value: StoredPermanentAuthorization[]) {
          if (deepEqual(value, defaults.secureMcp.permanentAuthorizations)) {
            delete real.permanentAuthorizations
          } else {
            real.permanentAuthorizations = value
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
