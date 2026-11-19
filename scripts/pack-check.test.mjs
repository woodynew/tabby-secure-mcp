import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  EXPECTED_VERSION,
  TABBY_PLUGIN_KEYWORD,
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

describe('assertPackManifest', () => {
  it('rejects workspace and file dependencies', () => {
    expect(() =>
      assertPackManifest({ name: 'x', version: EXPECTED_VERSION, dependencies: { foo: 'workspace:*' } }, 'plugin'),
    ).toThrow(/workspace/i)
    expect(() =>
      assertPackManifest({ name: 'x', version: EXPECTED_VERSION, dependencies: { foo: 'file:../x' } }, 'plugin'),
    ).toThrow(/file:/i)
  })

  it('rejects plugin runtime dependencies on the internal companion', () => {
    expect(() => assertPackManifest({ version: EXPECTED_VERSION, dependencies: { '@tabby-secure-mcp/companion': EXPECTED_VERSION } }, 'plugin')).toThrow(/runtime|self.contained/i)
    expect(() => assertPackManifest({ version: EXPECTED_VERSION, optionalDependencies: { '@tabby-secure-mcp/companion': EXPECTED_VERSION } }, 'plugin')).toThrow(/runtime|self.contained/i)
    expect(() => assertPackManifest({ version: EXPECTED_VERSION, devDependencies: { '@tabby-secure-mcp/companion': EXPECTED_VERSION } }, 'plugin')).not.toThrow()
  })
})

describe('single self-contained plugin tarball', () => {
  const umd = 'if(typeof module === "object") module.exports = {}; else if (define.amd) define([], () => ({}));'

  async function inspectBundle(bundle = umd) {
    const packDir = await mkdtemp(path.join(tmpdir(), 'single-plugin-pack-'))
    await writeMinimalTgz(path.join(packDir, `tabby-secure-mcp-${EXPECTED_VERSION}.tgz`), {
      'package/package.json': JSON.stringify({ name: 'tabby-secure-mcp', version: EXPECTED_VERSION, author: 'test', keywords: [TABBY_PLUGIN_KEYWORD], main: 'dist/index.js' }),
      'package/dist/index.js': bundle,
      'package/LICENSE': 'MIT License',
      'package/README.md': 'See https://github.com/woodynew/tabby-secure-mcp/security/policy',
    })
    try {
      return await inspectPackedTarball({ packDir, runPack: false })
    } finally {
      await rm(packDir, { recursive: true, force: true })
    }
  }

  it('accepts the plugin alone without a companion tarball or CLI', async () => {
    const result = await inspectBundle()
    expect(Object.keys(result)).toEqual(['plugin'])
  })

  it.each(['@tabby-secure-mcp/companion', '@modelcontextprotocol/server', 'zod', './plugin.cjs'])('rejects an unbundled runtime import: %s', async (name) => {
    await expect(inspectBundle(umd + '\nrequire(' + JSON.stringify(name) + ')')).rejects.toThrow(/self.contained|external|unbundled/i)
  })

  it('rejects a plain CommonJS entry without UMD support', async () => {
    await expect(inspectBundle('module.exports = {}')).rejects.toThrow(/UMD/i)
  })

  it('rejects node: requires that Tabby cannot load', async () => {
    await expect(inspectBundle(umd + '\nrequire("node:http")')).rejects.toThrow(/node:/i)
  })

  it('ignores require text in generated-code strings and comments', async () => {
    const bundle = umd + '\nconst code = `require("ajv/dist/runtime/validation_error")`;\n// require("zod")'
    await expect(inspectBundle(bundle)).resolves.toHaveProperty('plugin')
  })
})

describe('inspectPackedTarball integration', () => {
  it('validates real workspace tarballs after build', async () => {
    const pluginBundle = path.join(repoRoot, 'packages/tabby-plugin/dist/index.js')
    await expect(readFile(pluginBundle)).resolves.toBeDefined()

    const packDir = await mkdtemp(path.join(tmpdir(), 'publication-pack-'))
    try {
      const result = await inspectPackedTarball({ packDir, runPack: true })
      const manifest = await listPackageJsonFromTarball(path.join(packDir, `tabby-secure-mcp-${EXPECTED_VERSION}.tgz`))
      expect(manifest.repository).toEqual({
        type: 'git',
        url: 'git+https://github.com/woodynew/tabby-secure-mcp.git',
        directory: 'packages/tabby-plugin',
      })
      expect(manifest.bugs.url).toBe('https://github.com/woodynew/tabby-secure-mcp/issues')
      expect(manifest.homepage).toBe('https://github.com/woodynew/tabby-secure-mcp#readme')
      expect(manifest.publishConfig).toEqual({ access: 'public', registry: 'https://registry.npmjs.org' })
      expect(result.plugin.version).toBe(EXPECTED_VERSION)
      expect(result.plugin.entries.sort()).toEqual(['LICENSE', 'README.md', 'dist/index.js', 'package.json'])
      expect(await readFile(path.join(repoRoot, 'packages/tabby-plugin/LICENSE'), 'utf8'))
        .toBe(await readFile(path.join(repoRoot, 'LICENSE'), 'utf8'))
      expect(result.plugin.bundle).toMatch(/webpackUniversalModuleDefinition|module\.exports/)
      expect(Object.keys(result)).toEqual(['plugin'])
      const readme = await readFile(path.join(repoRoot, 'packages/tabby-plugin/README.md'), 'utf8')
      expect(readme).toContain('https://github.com/woodynew/tabby-secure-mcp/security/policy')
      expect(readme).toContain('https://github.com/woodynew/tabby-secure-mcp#quick-start')
    } finally {
      await rm(packDir, { recursive: true, force: true })
    }
  })
})

async function writeMinimalTgz(tarballPath, files) {
  const { gzipSync } = await import('node:zlib')
  const { packTar } = await import('./pack-check-core.mjs')
  const tar = packTar(files)
  await mkdir(path.dirname(tarballPath), { recursive: true })
  await writeFile(tarballPath, gzipSync(tar))
}
