import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { resolvePluginDescriptorPaths } from '../src/runtime/runtime-paths'

describe('resolvePluginDescriptorPaths', () => {
  it('matches companion descriptor layout on Linux', () => {
    const paths = resolvePluginDescriptorPaths({
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '/run/user/1000' },
      homedir: () => '/home/user',
      tmpdir: () => '/tmp',
    })
    expect(paths).toEqual({
      runtimeDirectory: '/run/user/1000/tabby-secure-mcp',
      descriptorPath: '/run/user/1000/tabby-secure-mcp/descriptor.json',
    })
  })

  it('matches companion descriptor layout on macOS', () => {
    const paths = resolvePluginDescriptorPaths({
      platform: 'darwin',
      env: {},
      homedir: () => '/Users/user',
      tmpdir: () => '/var/folders/T/mp',
    })
    expect(paths.descriptorPath).toBe(
      path.posix.join('/var/folders/T/mp', 'tabby-secure-mcp', 'descriptor.json'),
    )
  })

  it('matches companion descriptor layout on Windows', () => {
    const paths = resolvePluginDescriptorPaths({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\user\\AppData\\Local' },
      homedir: () => 'C:\\Users\\user',
      tmpdir: () => 'C:\\Temp',
    })
    expect(paths).toEqual({
      runtimeDirectory: 'C:\\Users\\user\\AppData\\Local\\tabby-secure-mcp',
      descriptorPath: 'C:\\Users\\user\\AppData\\Local\\tabby-secure-mcp\\descriptor.json',
    })
  })
})
