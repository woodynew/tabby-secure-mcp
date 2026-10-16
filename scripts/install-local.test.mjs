import { mkdtemp, mkdir, writeFile, symlink, stat, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveNpmLauncher } from './npm-pack-utils.mjs'

import {
  PLUGIN_PACKAGE_NAME,
  COMPANION_PACKAGE_NAME,
  EXPECTED_VERSION,
  assertNoTransientInstallerReferences,
  assertSafeAbsolutePluginsDir,
  assessRuntimeCleanupSafety,
  cleanStaleRuntimeArtifacts,
  companionBinPath,
  listInstallerMetadataPaths,
  parseCliArgs,
  parseDescriptorBounded,
  parseLockBounded,
  removeTransientInstallerMetadata,
  resolveDefaultPluginsDir,
  resolveRuntimePaths,
  runInstall,
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

  it('uses win32 absolute rules on Windows', () => {
    expect(assertSafeAbsolutePluginsDir('C:\\Tabby\\plugins', { platform: 'win32' })).toBe(
      'C:\\Tabby\\plugins',
    )
    expect(() => assertSafeAbsolutePluginsDir('plugins', { platform: 'win32' })).toThrow(/absolute/i)
    expect(() => assertSafeAbsolutePluginsDir('C:\\', { platform: 'win32' })).toThrow(/unsafe/i)
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

describe('parseLockBounded', () => {
  it('accepts companion lock shape', () => {
    const parsed = parseLockBounded(JSON.stringify({ pid: 12, owner: 'abc123' }))
    expect(parsed.ok).toBe(true)
  })

  it('rejects malformed lock payloads', () => {
    expect(parseLockBounded('{').ok).toBe(false)
    expect(parseLockBounded(JSON.stringify({ pid: 0, owner: 'x' })).ok).toBe(false)
  })
})

describe('assessRuntimeCleanupSafety', () => {
  let runtimeDir
  let runtimeParent

  afterEach(async () => {
    if (runtimeParent) {
      await rm(runtimeParent, { recursive: true, force: true }).catch(() => undefined)
      runtimeParent = undefined
      runtimeDir = undefined
    }
  })

  async function makePaths() {
    runtimeParent = await mkdtemp(path.join(tmpdir(), 'tabby-runtime-parent-'))
    runtimeDir = path.join(runtimeParent, 'tabby-secure-mcp')
    await mkdir(runtimeDir, { recursive: true })
    return {
      runtimeDirectory: runtimeDir,
      descriptorPath: path.join(runtimeDir, 'descriptor.json'),
      lockPath: path.join(runtimeDir, 'companion.lock'),
      endpoint: path.join(runtimeDir, 'companion.sock'),
    }
  }

  it('blocks when descriptor PID is alive', async () => {
    const paths = await makePaths()
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
    const state = await assessRuntimeCleanupSafety(paths, {
      platform: 'linux',
      isProcessAlive: (pid) => pid === 4242,
    })
    expect(state.status).toBe('blocked')
    expect(state.message).toMatch(/4242/)
  })

  it('blocks on startup lock-only with a live PID', async () => {
    const paths = await makePaths()
    await writeFile(paths.lockPath, JSON.stringify({ pid: 5150, owner: 'deadbeef' }))
    const state = await assessRuntimeCleanupSafety(paths, {
      platform: 'linux',
      isProcessAlive: (pid) => pid === 5150,
    })
    expect(state.status).toBe('blocked')
    expect(state.message).toMatch(/5150/)
  })

  it('blocks on malformed descriptor with a live lock PID', async () => {
    const paths = await makePaths()
    await writeFile(paths.descriptorPath, '{not-json')
    await writeFile(paths.lockPath, JSON.stringify({ pid: 6001, owner: 'live' }))
    const state = await assessRuntimeCleanupSafety(paths, {
      platform: 'linux',
      isProcessAlive: (pid) => pid === 6001,
    })
    expect(state.status).toBe('blocked')
    expect(state.message).toMatch(/malformed/i)
  })

  it('blocks on malformed lock while descriptor is missing', async () => {
    const paths = await makePaths()
    await writeFile(paths.lockPath, '{"pid":1}')
    const state = await assessRuntimeCleanupSafety(paths, { platform: 'linux', isProcessAlive: () => false })
    expect(state.status).toBe('blocked')
    expect(state.message).toMatch(/lock/i)
  })

  it('blocks on symlinked descriptor without deleting artifacts', async () => {
    const paths = await makePaths()
    const outside = await mkdtemp(path.join(tmpdir(), 'tabby-outside-'))
    await writeFile(path.join(outside, 'real.json'), '{}')
    await symlink(path.join(outside, 'real.json'), paths.descriptorPath)
    const state = await assessRuntimeCleanupSafety(paths, { platform: 'linux', isProcessAlive: () => false })
    expect(state.status).toBe('blocked')
    await cleanStaleRuntimeArtifacts(paths, { platform: 'linux' })
    await expect(stat(paths.descriptorPath)).resolves.toBeDefined()
  })

  it('cleans stale descriptor, lock, and unix socket when PIDs are dead', async () => {
    const paths = await makePaths()
    const nonce = Buffer.alloc(32, 3).toString('base64url')
    await writeFile(paths.lockPath, JSON.stringify({ pid: 1, owner: 'stale' }))
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

    const state = await assessRuntimeCleanupSafety(paths, {
      platform: 'linux',
      isProcessAlive: () => false,
    })
    expect(state.status).toBe('cleanable')

    await cleanStaleRuntimeArtifacts(paths, { platform: 'linux' })

    await expect(stat(paths.descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(paths.lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(paths.endpoint)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('installer metadata', () => {
  it('rejects synthetic hidden package-lock file references', async () => {
    const pluginsDir = await mkdtemp(path.join(tmpdir(), 'tabby-metadata-'))
    await mkdir(path.join(pluginsDir, 'node_modules'), { recursive: true })
    await writeFile(
      path.join(pluginsDir, 'node_modules', '.package-lock.json'),
      JSON.stringify({ dependencies: { demo: 'file:/tmp/evil.tgz' } }),
    )
    await expect(assertNoTransientInstallerReferences(pluginsDir)).rejects.toThrow(/file:/i)
    await removeTransientInstallerMetadata(pluginsDir)
    await expect(assertNoTransientInstallerReferences(pluginsDir)).resolves.toBeUndefined()
  })

  it('includes hidden node_modules lock in metadata scan paths', () => {
    const pluginsDir = '/tmp/plugins'
    expect(listInstallerMetadataPaths(pluginsDir)).toContain(
      path.join(pluginsDir, 'node_modules', '.package-lock.json'),
    )
  })
})

describe('resolveRuntimePaths win32', () => {
  it('uses LOCALAPPDATA runtime layout on Windows', () => {
    const paths = resolveRuntimePaths({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\user\\AppData\\Local' },
      homedir: () => 'C:\\Users\\user',
    })
    expect(paths.runtimeDirectory).toBe('C:\\Users\\user\\AppData\\Local\\tabby-secure-mcp')
    expect(paths.descriptorPath).toBe(
      'C:\\Users\\user\\AppData\\Local\\tabby-secure-mcp\\descriptor.json',
    )
  })
})

describe('runInstall smoke', () => {
  let pluginsDir
  let runtimeParent

  afterEach(async () => {
    if (pluginsDir) {
      await rm(pluginsDir, { recursive: true, force: true }).catch(() => undefined)
      pluginsDir = undefined
    }
    if (runtimeParent) {
      await rm(runtimeParent, { recursive: true, force: true }).catch(() => undefined)
      runtimeParent = undefined
    }
  })

  it('packs, installs offline into a temp prefix, and runs companion --help', async () => {
    const npm = resolveNpmLauncher()
    const build = spawnSync(npm.command, ['run', 'build'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: npm.shell,
    })
    expect(build.status).toBe(0)

    pluginsDir = await mkdtemp(path.join(tmpdir(), 'tabby-plugins-smoke-'))
    runtimeParent = await mkdtemp(path.join(tmpdir(), 'tabby-runtime-smoke-'))

    const packDir = await mkdtemp(path.join(tmpdir(), 'tabby-pack-smoke-'))
    const result = await runInstall({
      argv: ['--plugins-dir', pluginsDir, '--skip-build'],
      env: { ...process.env, XDG_RUNTIME_DIR: runtimeParent },
      platform: 'linux',
      packDir,
      keepPackDir: true,
    })

    expect(result.pluginsDir).toBe(path.resolve(pluginsDir))
    await verifyInstalledLayout(pluginsDir, { platform: 'linux' })
    await assertNoTransientInstallerReferences(pluginsDir)
    await expect(stat(result.pluginPack.tarballPath)).resolves.toBeDefined()
    await expect(stat(result.companionPack.tarballPath)).resolves.toBeDefined()

    await rm(packDir, { recursive: true, force: true })
    await assertNoTransientInstallerReferences(pluginsDir)

    const help = spawnSync(result.companionCommand, ['--help'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    })
    expect(help.status).toBe(0)
    expect(help.stdout).toMatch(/tabby-secure-mcp/)
  }, 120_000)
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
    await writeFile(
      path.join(pluginRoot, 'package.json'),
      JSON.stringify({
        name: PLUGIN_PACKAGE_NAME,
        version: EXPECTED_VERSION,
        keywords: ['tabby-plugin'],
        main: 'dist/index.js',
        author: 'tabby-secure-mcp',
      }),
    )
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
