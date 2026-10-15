import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  EXPECTED_VERSION,
  assertPackManifest,
  inspectPackedTarball,
  listPackageJsonFromTarball,
  listTarballEntries,
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

describe('assertPackManifest', () => {
  it('rejects workspace and file dependencies', () => {
    expect(() =>
      assertPackManifest({ name: 'x', version: '0.1.0', dependencies: { foo: 'workspace:*' } }, 'plugin'),
    ).toThrow(/workspace/i)
    expect(() =>
      assertPackManifest({ name: 'x', version: '0.1.0', dependencies: { foo: 'file:../x' } }, 'plugin'),
    ).toThrow(/file:/i)
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
    expect(result.companion.mode & 0o111).not.toBe(0)
  })
})

async function writeMinimalTgz(tarballPath, files) {
  const { gzipSync } = await import('node:zlib')
  const { packTar } = await import('./pack-check-core.mjs')
  const tar = packTar(files)
  await mkdir(path.dirname(tarballPath), { recursive: true })
  await writeFile(tarballPath, gzipSync(tar))
}
