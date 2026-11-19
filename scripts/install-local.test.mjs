import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, stat, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveNpmLauncher, runCommand } from './npm-pack-utils.mjs'

import {
  PLUGIN_PACKAGE_NAME,
  COMPANION_PACKAGE_NAME,
  EXPECTED_VERSION,
  assertNoTransientInstallerReferences,
  assertSafeAbsolutePluginsDir,
  assessRuntimeCleanupSafety,
  cleanStaleRuntimeArtifacts,
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
    const outside = path.join(runtimeParent, 'real.json')
    await writeFile(outside, '{}')
    await symlink(outside, paths.descriptorPath)
    const state = await assessRuntimeCleanupSafety(paths, { platform: 'linux', isProcessAlive: () => false })
    expect(state.status).toBe('blocked')
    expect(state.message).toMatch(/symbolic link/i)
    await cleanStaleRuntimeArtifacts(paths, { platform: 'linux' })
    await expect(stat(paths.descriptorPath)).resolves.toBeDefined()
  })

  it.each(['descriptorPath', 'lockPath'])('blocks when %s is a directory', async (artifact) => {
    const paths = await makePaths()
    await mkdir(paths[artifact])
    const state = await assessRuntimeCleanupSafety(paths, {
      platform: 'linux',
      isProcessAlive: () => false,
    })
    expect(state.status).toBe('blocked')
    expect(state.message).toMatch(/malformed/i)
  })

  it('preserves stale descriptor, lock, and unix socket when PIDs are dead', async () => {
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

    await expect(stat(paths.descriptorPath)).resolves.toBeDefined()
    await expect(stat(paths.lockPath)).resolves.toBeDefined()
    await expect(stat(paths.endpoint)).resolves.toBeDefined()
  })
})

describe('installer metadata', () => {
  it('preserves unrelated local dependencies and npm metadata', async () => {
    const pluginsDir = await mkdtemp(path.join(tmpdir(), 'tabby-metadata-'))
    await mkdir(path.join(pluginsDir, 'node_modules'), { recursive: true })
    await writeFile(
      path.join(pluginsDir, 'node_modules', '.package-lock.json'),
      JSON.stringify({ dependencies: { demo: 'file:/tmp/evil.tgz' } }),
    )
    await expect(assertNoTransientInstallerReferences(pluginsDir)).resolves.toBeUndefined()
    await removeTransientInstallerMetadata(pluginsDir)
    await expect(stat(path.join(pluginsDir, 'node_modules', '.package-lock.json'))).resolves.toBeDefined()
  })

  it('allows a registered legacy companion dependency without rewriting it', async () => {
    const pluginsDir = await mkdtemp(path.join(tmpdir(), 'tabby-legacy-companion-'))
    const manifest = { private: true, dependencies: { [COMPANION_PACKAGE_NAME]: 'file:/legacy/companion.tgz' } }
    await writeFile(path.join(pluginsDir, 'package.json'), JSON.stringify(manifest))
    await expect(assertNoTransientInstallerReferences(pluginsDir)).resolves.toBeUndefined()
    expect(JSON.parse(await readFile(path.join(pluginsDir, 'package.json'), 'utf8'))).toEqual(manifest)
  })

  it('checks persistent artifact contents and the packed byte count', async () => {
    const pluginsDir = await mkdtemp(path.join(tmpdir(), 'tabby-artifact-'))
    try {
      const data = Buffer.alloc(128 * 1024 + 1, 1)
      const hash = createHash('sha256').update(data).digest('hex')
      const reference = `.secure-mcp-artifacts/${hash}.tgz`
      const artifact = path.join(pluginsDir, reference)
      await mkdir(path.dirname(artifact))
      await writeFile(path.join(pluginsDir, 'package.json'), JSON.stringify({
        dependencies: { [PLUGIN_PACKAGE_NAME]: `file:${reference}` },
      }))
      await writeFile(artifact, data)
      await expect(assertNoTransientInstallerReferences(pluginsDir)).resolves.toBeUndefined()
      await expect(assertNoTransientInstallerReferences(pluginsDir, data.length)).resolves.toBeUndefined()
      await expect(assertNoTransientInstallerReferences(pluginsDir, data.length - 1)).rejects.toThrow(/checksum mismatch/i)
      await writeFile(artifact, data.fill(2))
      await expect(assertNoTransientInstallerReferences(pluginsDir, data.length)).rejects.toThrow(/checksum mismatch/i)
    } finally {
      await rm(pluginsDir, { recursive: true, force: true })
    }
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

  it('installs only the self-contained plugin and preserves later package maintenance', async () => {
    const npm = resolveNpmLauncher()
    const build = spawnSync(npm.command, [...(npm.args ?? []), 'run', 'build'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: npm.shell,
    })
    expect(build.status).toBe(0)

    pluginsDir = await mkdtemp(path.join(tmpdir(), 'tabby plugins & smoke-'))
    runtimeParent = await mkdtemp(path.join(tmpdir(), 'tabby-runtime-smoke-'))
    await writeFile(path.join(pluginsDir, 'package.json'), JSON.stringify({ private: true, name: 'qa-plugin-root', custom: { keep: true } }))

    const packDir = await mkdtemp(path.join(tmpdir(), 'tabby-pack-smoke-'))
    const result = await runInstall({
      argv: ['--plugins-dir', pluginsDir, '--skip-build'],
      platform: 'linux',
      packDir,
      keepPackDir: true,
      // Installation must register dependencies even when npm's user default disables saving.
      env: { ...process.env, XDG_RUNTIME_DIR: runtimeParent, npm_config_save: 'false' },
    })

    expect(result.pluginsDir).toBe(path.resolve(pluginsDir))
    await verifyInstalledLayout(pluginsDir, { platform: 'linux' })
    await assertNoTransientInstallerReferences(pluginsDir)
    await expect(stat(result.pluginPack.tarballPath)).resolves.toBeDefined()
    expect(await readdir(packDir)).toEqual([`tabby-secure-mcp-${EXPECTED_VERSION}.tgz`])
    expect(result).not.toHaveProperty('companionPack')
    expect(result).not.toHaveProperty('companionCommand')
    expect(result.connectionInstructions).toMatch(/HTTP|127\.0\.0\.1/)
    await expect(stat(path.join(pluginsDir, 'node_modules', '@tabby-secure-mcp', 'companion'))).rejects.toMatchObject({ code: 'ENOENT' })

    await rm(packDir, { recursive: true, force: true })
    await assertNoTransientInstallerReferences(pluginsDir)
    const manifest = JSON.parse(await readFile(path.join(pluginsDir, 'package.json'), 'utf8'))
    for (const name of [PLUGIN_PACKAGE_NAME]) {
      expect(manifest.dependencies[name]).toMatch(/^file:.*\.secure-mcp-artifacts/)
    }

    const otherSource = path.join(runtimeParent, 'other plugin source')
    await mkdir(otherSource)
    await writeFile(path.join(otherSource, 'package.json'), JSON.stringify({ name: 'tabby-qa-other', version: '1.0.0', keywords: ['tabby-plugin'] }))
    await runCommand('npm', ['pack', '--pack-destination', runtimeParent], { cwd: otherSource })
    await runCommand('npm', ['install', '--prefix', pluginsDir, '--ignore-scripts', '--legacy-peer-deps', '--save', '--save-exact', path.join(runtimeParent, 'tabby-qa-other-1.0.0.tgz')])
    await verifyInstalledLayout(pluginsDir)
    await runInstall({ argv: ['--plugins-dir', pluginsDir, '--skip-build'], env: { ...process.env, XDG_RUNTIME_DIR: runtimeParent }, platform: 'linux' })
    await verifyInstalledLayout(pluginsDir)
    await expect(stat(path.join(pluginsDir, 'node_modules', 'tabby-qa-other', 'package.json'))).resolves.toBeDefined()
    expect(JSON.parse(await readFile(path.join(pluginsDir, 'package.json'), 'utf8')).custom).toEqual({ keep: true })

    const legacySource = path.join(runtimeParent, 'legacy companion source')
    await mkdir(legacySource)
    await writeFile(path.join(legacySource, 'package.json'), JSON.stringify({ name: COMPANION_PACKAGE_NAME, version: '0.1.0' }))
    await runCommand('npm', ['pack', '--pack-destination', runtimeParent], { cwd: legacySource })
    const legacyTarball = path.join(runtimeParent, 'tabby-secure-mcp-companion-0.1.0.tgz')
    await runCommand('npm', ['install', '--prefix', pluginsDir, '--ignore-scripts', '--legacy-peer-deps', '--save', '--save-exact', legacyTarball])
    const legacyReference = JSON.parse(await readFile(path.join(pluginsDir, 'package.json'), 'utf8')).dependencies[COMPANION_PACKAGE_NAME]
    const runtimeDir = path.join(runtimeParent, 'tabby-secure-mcp')
    await mkdir(runtimeDir)
    const staleLock = JSON.stringify({ pid: 999999, owner: 'legacy-owner' })
    await writeFile(path.join(runtimeDir, 'companion.lock'), staleLock)
    const cli = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/install-local.mjs'), '--plugins-dir', pluginsDir, '--skip-build'], {
      cwd: repoRoot, encoding: 'utf8', shell: false,
      env: { ...process.env, XDG_RUNTIME_DIR: runtimeParent, npm_config_save: 'false' },
    })
    expect(cli.status, cli.stderr).toBe(0)
    expect(cli.stdout).toContain(pluginsDir)
    expect(cli.stdout).toMatch(/Streamable HTTP/)
    expect(cli.stdout).toMatch(/Legacy companion.*retained/i)
    expect(cli.stdout).toMatch(/disable.*stdio/i)
    expect(cli.stdout).not.toMatch(/node_modules[/\\]\.bin|dist[/\\]cli\.js/)
    expect(JSON.parse(await readFile(path.join(pluginsDir, 'package.json'), 'utf8')).dependencies[COMPANION_PACKAGE_NAME]).toBe(legacyReference)
    await expect(stat(path.join(pluginsDir, 'node_modules', '@tabby-secure-mcp', 'companion', 'package.json'))).resolves.toBeDefined()
    expect(await readFile(path.join(runtimeDir, 'companion.lock'), 'utf8')).toBe(staleLock)
    await verifyInstalledLayout(pluginsDir)
    await assertNoTransientInstallerReferences(pluginsDir)

  }, 120_000)

  it.each([
    ['devDependencies', { NODE_ENV: 'production' }],
    ['devDependencies', { npm_config_omit: 'dev' }],
    ['devDependencies', { NODE_ENV: 'production', npm_config_omit: 'dev' }],
    ['optionalDependencies', { npm_config_omit: 'optional' }],
  ])('preserves a registered %s plugin under omit environment %j', async (section, omitEnv) => {
    pluginsDir = await mkdtemp(path.join(tmpdir(), 'tabby plugins & omit-'))
    runtimeParent = await mkdtemp(path.join(tmpdir(), 'tabby-runtime-omit-'))
    const otherSource = path.join(runtimeParent, 'other plugin source')
    await mkdir(otherSource)
    const otherManifest = { name: 'tabby-qa-registered', version: '1.0.0', keywords: ['tabby-plugin'], main: 'index.js' }
    const otherCode = 'module.exports = { preserved: true }\n'
    await writeFile(path.join(otherSource, 'package.json'), JSON.stringify(otherManifest))
    await writeFile(path.join(otherSource, 'index.js'), otherCode)
    await writeFile(path.join(pluginsDir, 'package.json'), JSON.stringify({ private: true, custom: { keep: true } }))
    await runCommand('npm', ['pack', '--pack-destination', runtimeParent], { cwd: otherSource })
    await runCommand('npm', [
      'install', '--prefix', pluginsDir, '--ignore-scripts', '--legacy-peer-deps',
      '--include=dev', '--include=optional', '--save', '--save-exact',
      section === 'devDependencies' ? '--save-dev' : '--save-optional',
      path.join(runtimeParent, 'tabby-qa-registered-1.0.0.tgz'),
    ])
    const before = JSON.parse(await readFile(path.join(pluginsDir, 'package.json'), 'utf8'))
    const installedOther = path.join(pluginsDir, 'node_modules', otherManifest.name)
    expect(await readFile(path.join(installedOther, 'index.js'), 'utf8')).toBe(otherCode)

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await runInstall({
        argv: ['--plugins-dir', pluginsDir, '--skip-build'],
        platform: 'linux',
        env: { ...process.env, ...omitEnv, XDG_RUNTIME_DIR: runtimeParent, npm_config_save: 'false' },
      })
      const after = JSON.parse(await readFile(path.join(pluginsDir, 'package.json'), 'utf8'))
      expect(after[section]).toEqual(before[section])
      expect(after.custom).toEqual(before.custom)
      expect(after.dependencies[otherManifest.name]).toBeUndefined()
      expect(after.dependencies[PLUGIN_PACKAGE_NAME]).toMatch(/^file:.*\.secure-mcp-artifacts/)
      expect(JSON.parse(await readFile(path.join(installedOther, 'package.json'), 'utf8'))).toEqual(otherManifest)
      expect(await readFile(path.join(installedOther, 'index.js'), 'utf8')).toBe(otherCode)
    }
  }, 120_000)

  it('refuses to prune an existing unregistered Tabby plugin', async () => {
    pluginsDir = await mkdtemp(path.join(tmpdir(), 'tabby-existing-'))
    runtimeParent = await mkdtemp(path.join(tmpdir(), 'tabby-runtime-smoke-'))
    const old = path.join(pluginsDir, 'node_modules', 'tabby-existing', 'package.json')
    await mkdir(path.dirname(old), { recursive: true })
    const bytes = JSON.stringify({ name: 'tabby-existing', version: '1.0.0', keywords: ['tabby-plugin'] })
    await writeFile(old, bytes)
    await expect(runInstall({ argv: ['--plugins-dir', pluginsDir, '--skip-build'], env: { ...process.env, XDG_RUNTIME_DIR: runtimeParent } })).rejects.toThrow(/unregistered/i)
    expect(await readFile(old, 'utf8')).toBe(bytes)
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

describe('verifyInstalledLayout', () => {
  it('checks the plugin alone without a companion directory or bin', async () => {
    const pluginsDir = await mkdtemp(path.join(tmpdir(), 'tabby-plugins-verify-'))
    const pluginRoot = path.join(pluginsDir, 'node_modules', PLUGIN_PACKAGE_NAME)
    await mkdir(path.join(pluginRoot, 'dist'), { recursive: true })
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
    await writeFile(path.join(pluginRoot, 'dist', 'index.js'), 'if(typeof module === "object") module.exports = {}; else if (define.amd) define([], () => ({}));')

    await expect(verifyInstalledLayout(pluginsDir, { platform: 'linux' })).resolves.toBeUndefined()
  })
})
