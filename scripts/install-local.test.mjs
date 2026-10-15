import { mkdtemp, mkdir, writeFile, symlink, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  PLUGIN_PACKAGE_NAME,
  COMPANION_PACKAGE_NAME,
  EXPECTED_VERSION,
  assertSafeAbsolutePluginsDir,
  cleanStaleRuntimeArtifacts,
  companionBinPath,
  parseCliArgs,
  parseDescriptorBounded,
  resolveDefaultPluginsDir,
  resolveRuntimePaths,
  assessRuntimeDescriptorState,
  verifyInstalledLayout,
} from './install-local-core.mjs'

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

describe('resolveDefaultPluginsDir', () => {
  it('uses Linux Tabby config plugins path', () => {
    expect(
      resolveDefaultPluginsDir({
        platform: 'linux',
        homedir: () => '/home/user',
      }),
    ).toBe(path.join('/home/user', '.config', 'tabby', 'plugins'))
  })

  it('uses macOS Application Support plugins path', () => {
    expect(
      resolveDefaultPluginsDir({
        platform: 'darwin',
        homedir: () => '/Users/user',
      }),
    ).toBe(path.join('/Users/user', 'Library', 'Application Support', 'tabby', 'plugins'))
  })

  it('uses Windows APPDATA tabby plugins with Roaming fallback', () => {
    expect(
      resolveDefaultPluginsDir({
        platform: 'win32',
        env: { APPDATA: 'C:\\Users\\user\\AppData\\Roaming' },
        homedir: () => 'C:\\Users\\user',
      }),
    ).toBe('C:\\Users\\user\\AppData\\Roaming\\tabby\\plugins')
  })
})

describe('assertSafeAbsolutePluginsDir', () => {
  it('rejects relative paths', () => {
    expect(() => assertSafeAbsolutePluginsDir('relative/plugins')).toThrow(/absolute/i)
  })

  it('accepts normalized absolute paths', () => {
    const dir = path.resolve('/tmp/tabby-plugins-test')
    expect(assertSafeAbsolutePluginsDir(dir)).toBe(path.resolve(dir))
  })

  it('rejects filesystem root', () => {
    expect(() => assertSafeAbsolutePluginsDir(path.parse(repoRoot).root)).toThrow(/unsafe/i)
  })
})

describe('parseCliArgs', () => {
  it('parses plugins-dir and skip-build', () => {
    const abs = path.resolve('/tmp/plugins')
    expect(parseCliArgs(['--plugins-dir', abs, '--skip-build'])).toEqual({
      pluginsDir: abs,
      skipBuild: true,
    })
  })

  it('rejects unknown flags', () => {
    expect(() => parseCliArgs(['--force'])).toThrow(/unknown/i)
  })
})

describe('parseDescriptorBounded', () => {
  it('accepts a minimal valid descriptor shape', () => {
    const nonce = Buffer.alloc(32, 1).toString('base64url')
    const result = parseDescriptorBounded(
      JSON.stringify({
        protocol_version: 1,
        endpoint: '/tmp/tabby-secure-mcp/companion.sock',
        pid: 42,
        expires_at: Date.now() + 60_000,
        pairing_nonce: nonce,
      }),
    )
    expect(result.ok).toBe(true)
    expect(result.descriptor.pid).toBe(42)
  })

  it('rejects oversize payloads', () => {
    const result = parseDescriptorBounded('x'.repeat(5000))
    expect(result.ok).toBe(false)
  })
})

describe('assessRuntimeDescriptorState and cleanup', () => {
  let runtimeDir

  afterEach(async () => {
    if (runtimeDir) {
      await import('node:fs/promises').then(({ rm }) =>
        rm(runtimeDir, { recursive: true, force: true }).catch(() => undefined),
      )
      runtimeDir = undefined
    }
  })

  it('fails when descriptor PID is alive', async () => {
    runtimeDir = await mkdtemp(path.join(tmpdir(), 'tabby-runtime-live-'))
    const paths = {
      runtimeDirectory: runtimeDir,
      descriptorPath: path.join(runtimeDir, 'descriptor.json'),
      lockPath: path.join(runtimeDir, 'companion.lock'),
      endpoint: path.join(runtimeDir, 'companion.sock'),
    }
    const nonce = Buffer.alloc(32, 2).toString('base64url')
    await writeFile(
      paths.descriptorPath,
      JSON.stringify({
        protocol_version: 1,
        endpoint: paths.endpoint,
        pid: 4242,
        expires_at: Date.now() + 60_000,
        pairing_nonce: nonce,
      }),
    )
    const state = await assessRuntimeDescriptorState(paths, {
      platform: 'linux',
      isProcessAlive: (pid) => pid === 4242,
    })
    expect(state).toEqual({ kind: 'live_companion', pid: 4242 })
  })

  it('removes stale descriptor, lock, and unix socket inside runtime dir', async () => {
    runtimeDir = await mkdtemp(path.join(tmpdir(), 'tabby-runtime-stale-'))
    const paths = {
      runtimeDirectory: runtimeDir,
      descriptorPath: path.join(runtimeDir, 'descriptor.json'),
      lockPath: path.join(runtimeDir, 'companion.lock'),
      endpoint: path.join(runtimeDir, 'companion.sock'),
    }
    const nonce = Buffer.alloc(32, 3).toString('base64url')
    await writeFile(paths.lockPath, '{"pid":1}')
    await writeFile(paths.endpoint, '')
    await writeFile(
      paths.descriptorPath,
      JSON.stringify({
        protocol_version: 1,
        endpoint: paths.endpoint,
        pid: 99999,
        expires_at: Date.now() + 60_000,
        pairing_nonce: nonce,
      }),
    )

    const state = await assessRuntimeDescriptorState(paths, {
      platform: 'linux',
      isProcessAlive: () => false,
    })
    expect(state).toEqual({ kind: 'stale' })

    await cleanStaleRuntimeArtifacts(paths, { platform: 'linux' })

    await expect(stat(paths.descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(paths.lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(paths.endpoint)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not delete symlinked artifacts', async () => {
    runtimeDir = await mkdtemp(path.join(tmpdir(), 'tabby-runtime-symlink-'))
    const outside = await mkdtemp(path.join(tmpdir(), 'tabby-outside-'))
    const paths = {
      runtimeDirectory: runtimeDir,
      descriptorPath: path.join(runtimeDir, 'descriptor.json'),
      lockPath: path.join(runtimeDir, 'companion.lock'),
      endpoint: path.join(runtimeDir, 'companion.sock'),
    }
    await writeFile(path.join(outside, 'real.json'), '{}')
    await symlink(path.join(outside, 'real.json'), paths.descriptorPath)

    await cleanStaleRuntimeArtifacts(paths, { platform: 'linux' })
    await expect(stat(paths.descriptorPath)).resolves.toBeDefined()
  })
})

describe('companionBinPath', () => {
  it('uses .cmd on Windows', () => {
    const pluginsDir = 'C:\\Tabby\\plugins'
    expect(companionBinPath(pluginsDir, 'win32')).toBe(
      path.win32.join(pluginsDir, 'node_modules', '.bin', 'tabby-secure-mcp.cmd'),
    )
  })
})

describe('verifyInstalledLayout', () => {
  it('checks package names, versions, and required files', async () => {
    const pluginsDir = await mkdtemp(path.join(tmpdir(), 'tabby-plugins-verify-'))
    const pluginRoot = path.join(pluginsDir, 'node_modules', PLUGIN_PACKAGE_NAME)
    const companionRoot = path.join(pluginsDir, 'node_modules', '@tabby-secure-mcp', 'companion')
    await mkdir(path.join(pluginRoot, 'dist'), { recursive: true })
    await mkdir(path.join(companionRoot, 'dist'), { recursive: true })
    await writeFile(path.join(pluginRoot, 'package.json'), JSON.stringify({ name: PLUGIN_PACKAGE_NAME, version: EXPECTED_VERSION }))
    await writeFile(
      path.join(companionRoot, 'package.json'),
      JSON.stringify({ name: COMPANION_PACKAGE_NAME, version: EXPECTED_VERSION }),
    )
    await writeFile(path.join(pluginRoot, 'dist', 'index.js'), 'module.exports = {}')
    await writeFile(path.join(companionRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n')
    await mkdir(path.join(pluginsDir, 'node_modules', '.bin'), { recursive: true })
    await writeFile(path.join(pluginsDir, 'node_modules', '.bin', 'tabby-secure-mcp'), '')

    await expect(verifyInstalledLayout(pluginsDir, { platform: 'linux' })).resolves.toBeUndefined()
  })
})

describe('resolveRuntimePaths', () => {
  it('aligns with companion runtime layout on Linux', () => {
    const paths = resolveRuntimePaths({
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '/run/user/1000' },
      homedir: () => '/home/user',
      tmpdir: () => '/tmp',
    })
    expect(paths.descriptorPath).toBe('/run/user/1000/tabby-secure-mcp/descriptor.json')
    expect(paths.endpoint).toBe('/run/user/1000/tabby-secure-mcp/companion.sock')
  })
})
