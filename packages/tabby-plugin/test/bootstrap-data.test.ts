import { describe, expect, it } from 'vitest'

import { normalizeWindowBootstrap } from '../src/runtime/bootstrap-data'

describe('normalizeWindowBootstrap', () => {
  it('fails closed to non-main when bootstrap is missing or invalid', () => {
    expect(normalizeWindowBootstrap(undefined)).toEqual({ isMainWindow: false, windowId: '0' })
    expect(normalizeWindowBootstrap(null)).toEqual({ isMainWindow: false, windowId: '0' })
    expect(
      normalizeWindowBootstrap({
        config: {},
        executable: '',
        isMainWindow: true,
        windowID: 'bad' as unknown as number,
        installedPlugins: [],
        userPluginsPath: '',
      }),
    ).toEqual({ isMainWindow: false, windowId: '0' })
  })

  it('normalizes numeric windowID and preserves main flag only when true', () => {
    expect(
      normalizeWindowBootstrap({
        config: {},
        executable: '',
        isMainWindow: true,
        windowID: 42.9,
        installedPlugins: [],
        userPluginsPath: '',
      }),
    ).toEqual({ isMainWindow: true, windowId: '42' })

    expect(
      normalizeWindowBootstrap({
        config: {},
        executable: '',
        isMainWindow: false,
        windowID: 3,
        installedPlugins: [],
        userPluginsPath: '',
      }),
    ).toEqual({ isMainWindow: false, windowId: '3' })
  })
})
