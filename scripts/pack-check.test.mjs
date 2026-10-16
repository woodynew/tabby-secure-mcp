import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  EXPECTED_VERSION,
  TABBY_PLUGIN_KEYWORD,
  assertCompanionLaunchMode,
  assertPackManifest,
  assertTabbyPluginDiscoveryManifest,
  inspectPackedTarball,
  listPackageJsonFromTarball,
  listTarballEntries,
  resolveTabbyPluginAuthor,
} from './pack-check-core.mjs'

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

describe('listTarballEntries', () => {
  it('lists package-relative paths from a minimal tgz', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pack-list-'))
    const tarball = path.join(dir, 'sample.tgz')
    await writeMinimalTgz(tarball, {
      'package/package.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
      'package/dist/index.js': 'export {}',
    })
    const entries = await listTarballEntries(tarball)
    expect(entries.sort()).toEqual(['dist/index.js', 'package.json'])
  })
})

describe('assertTabbyPluginDiscoveryManifest', () => {
  it('rejects manifests Tabby parsePluginInfo would throw on', () => {
    expect(() =>
      assertTabbyPluginDiscoveryManifest({
        keywords: [TABBY_PLUGIN_KEYWORD],
        main: 'dist/index.js',
      }),
    ).toThrow(/author/i)
    expect(() =>
      resolveTabbyPluginAuthor({ author: undefined }),
    ).toThrow(/author/i)
  })

  it('accepts string or object author like Tabby', () => {
    expect(
      resolveTabbyPluginAuthor({ author: 'Tabby Developers' }),
    ).toBe('Tabby Developers')
    expect(
      resolveTabbyPluginAuthor({ author: { name: 'Example', email: 'a@b.c' } }),
    ).toBe('Example')
    assertTabbyPluginDiscoveryManifest({
      keywords: [TABBY_PLUGIN_KEYWORD],
      main: 'dist/index.js',
      author: 'tabby-secure-mcp',
    })
  })
})

describe('assertCompanionLaunchMode', () => {
  const bin = { 'tabby-secure-mcp': './dist/cli.js' }

  it('accepts a Windows tarball whose bin shim targets the CLI', () => {
    expect(() =>
      assertCompanionLaunchMode({
        mode: 0o100644,
        platform: 'win32',
        bin,
      }),
    ).not.toThrow()
  })

  it('rejects a companion whose bin field does not target the CLI', () => {
    expect(() =>
      assertCompanionLaunchMode({
        mode: 0o100755,
        platform: 'win32',
        bin: { 'tabby-secure-mcp': './other.js' },
      }),
    ).toThrow(/bin/i)
  })

  it('rejects a Unix tarball whose CLI is not executable', () => {
    expect(() =>
      assertCompanionLaunchMode({
        mode: 0o100644,
        platform: 'linux',
        bin,
      }),
    ).toThrow(/executable/i)
  })
})

describe('assertPackManifest', () => {
  it('rejects workspace and file dependencies', () => {
    expect(() =>
      assertPackManifest({ name: 'x', version: '0.1.0', dependencies: { foo: 'workspace:*' } }, 'plugin'),
    ).toThrow(/workspace/i)
    expect(() =>
      assertPackManifest({ name: 'x', version: '0.1.0', dependencies: { foo: 'file:../x' } }, 'plugin'),
    ).toThrow(/file:/i)
  })

  it('requires companion tarballs to ship without runtime dependencies', () => {
    expect(() =>
      assertPackManifest({ version: '0.1.0', dependencies: { zod: '4.6.7' } }, 'companion'),
    ).toThrow(/runtime dependencies/i)
    expect(assertPackManifest({ version: '0.1.0' }, 'companion')).toBeUndefined()
  })
})

describe('inspectPackedTarball integration', () => {
  it('validates real workspace tarballs after build', async () => {
    const pluginBundle = path.join(repoRoot, 'packages/tabby-plugin/dist/index.js')
    const companionCli = path.join(repoRoot, 'packages/companion/dist/cli.js')
    await expect(readFile(pluginBundle)).resolves.toBeDefined()
    await expect(readFile(companionCli)).resolves.toBeDefined()

    const result = await inspectPackedTarball({
      repoRoot,
      runPack: true,
    })

    expect(result.plugin.version).toBe(EXPECTED_VERSION)
    expect(result.companion.version).toBe(EXPECTED_VERSION)
    expect(result.plugin.entries.sort()).toEqual(['dist/index.js', 'package.json'])
    expect(result.companion.entries.sort()).toEqual(['dist/cli.js', 'package.json'])
    expect(result.plugin.bundle).toMatch(/webpackUniversalModuleDefinition|module\.exports/)
    expect(result.companion.shebang).toBe('#!/usr/bin/env node\n')
    expect(() =>
      assertCompanionLaunchMode({
        mode: result.companion.mode,
        platform: process.platform,
        bin: result.companion.bin,
      }),
    ).not.toThrow()
  })
})

async function writeMinimalTgz(tarballPath, files) {
  const { gzipSync } = await import('node:zlib')
  const { packTar } = await import('./pack-check-core.mjs')
  const tar = packTar(files)
  await mkdir(path.dirname(tarballPath), { recursive: true })
  await writeFile(tarballPath, gzipSync(tar))
}
