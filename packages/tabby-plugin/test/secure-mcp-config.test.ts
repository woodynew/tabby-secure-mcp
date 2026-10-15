import { describe, expect, it, vi } from 'vitest'

import {
  dedupeAuthorizedSshProfileIds,
  readAuthorizedSshProfileIds,
  persistAuthorizedSshProfileIds,
  secureMcpConfigDefaults,
} from '../src/config/secure-mcp-config'

describe('secure MCP config helpers', () => {
  it('exposes ConfigProvider defaults with an empty whitelist', () => {
    expect(secureMcpConfigDefaults).toEqual({
      secureMcp: {
        authorizedSshProfileIds: [],
      },
    })
  })

  it('reads an empty whitelist from missing or malformed config', () => {
    expect(readAuthorizedSshProfileIds(undefined)).toEqual([])
    expect(readAuthorizedSshProfileIds(null)).toEqual([])
    expect(readAuthorizedSshProfileIds({})).toEqual([])
    expect(readAuthorizedSshProfileIds({ secureMcp: null })).toEqual([])
    expect(readAuthorizedSshProfileIds({ secureMcp: { authorizedSshProfileIds: 'nope' } })).toEqual([])
    expect(readAuthorizedSshProfileIds({ secureMcp: { authorizedSshProfileIds: [1, '', '  ', null] } })).toEqual([])
  })

  it('deduplicates and trims persisted profile ids', () => {
    expect(dedupeAuthorizedSshProfileIds(['a', ' a ', 'b', 'a', 'b'])).toEqual(['a', 'b'])
  })

  it('persists a deduped whitelist via ConfigService.store then save()', async () => {
    const config = {
      store: { secureMcp: { authorizedSshProfileIds: ['old'] } },
      save: vi.fn(async () => undefined),
    }

    const saved = await persistAuthorizedSshProfileIds(config, ['x', 'x', ' y '])

    expect(saved).toEqual(['x', 'y'])
    expect(config.store.secureMcp.authorizedSshProfileIds).toEqual(['x', 'y'])
    expect(config.save).toHaveBeenCalledOnce()
  })
})
