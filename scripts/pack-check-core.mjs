import { createReadStream } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createGunzip } from 'node:zlib'

import { packWorkspacePackage } from './npm-pack-utils.mjs'

export const EXPECTED_VERSION = '0.1.0'
export const PLUGIN_PACKAGE_NAME = 'tabby-secure-mcp'
export const COMPANION_PACKAGE_NAME = '@tabby-secure-mcp/companion'
export const TABBY_PLUGIN_KEYWORD = 'tabby-plugin'

/** Mirrors Tabby plugins_11.ts parsePluginInfo author normalization. */
export function resolveTabbyPluginAuthor(manifest) {
  let author = manifest.author
  if (author === undefined || author === null) {
    throw new Error('plugin package.json must declare author for Tabby discovery')
  }
  return author.name || author
}

export function assertCompanionLaunchMode({ mode, platform, bin }) {
  if (!bin || bin['tabby-secure-mcp'] !== './dist/cli.js') {
    throw new Error('companion package.json bin must point at ./dist/cli.js')
  }
  if (platform !== 'win32' && (mode & 0o111) === 0) {
    throw new Error('companion CLI tarball entry is not marked executable')
  }
}

export function assertTabbyPluginDiscoveryManifest(manifest, label = 'plugin') {
  const keywords = manifest.keywords
  if (!Array.isArray(keywords) || !keywords.includes(TABBY_PLUGIN_KEYWORD)) {
    throw new Error(`${label} package.json keywords must include ${TABBY_PLUGIN_KEYWORD}`)
  }
  resolveTabbyPluginAuthor(manifest)
  if (typeof manifest.main !== 'string' || manifest.main.length === 0) {
    throw new Error(`${label} package.json must declare main entry`)
  }
}

async function readEntireStream(stream) {
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export async function gunzipFile(filePath) {
  return readEntireStream(createReadStream(filePath).pipe(createGunzip()))
}

function parseTarHeaders(buffer) {
  const records = []
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      break
    }
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const sizeOct = header.subarray(124, 136).toString('utf8').trim()
    const modeOct = header.subarray(100, 108).toString('utf8').trim()
    const size = Number.parseInt(sizeOct, 8) || 0
    const mode = Number.parseInt(modeOct, 8) || 0
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    records.push({
      name,
      size,
      mode,
      data: buffer.subarray(dataStart, dataEnd),
    })
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return records
}

function packageRelativeName(entryName) {
  const normalized = entryName.replace(/\\/g, '/')
  const prefix = 'package/'
  if (!normalized.startsWith(prefix)) {
    return undefined
  }
  return normalized.slice(prefix.length)
}

export async function listTarballEntries(tarballPath) {
  const tarBuffer = await gunzipFile(tarballPath)
  const records = parseTarHeaders(tarBuffer)
  return records
    .map((record) => packageRelativeName(record.name))
    .filter((name) => name && name.length > 0)
}

export async function listPackageJsonFromTarball(tarballPath) {
  const tarBuffer = await gunzipFile(tarballPath)
  const records = parseTarHeaders(tarBuffer)
  const manifest = records.find((record) => packageRelativeName(record.name) === 'package.json')
  if (!manifest) {
    throw new Error(`package.json missing from ${tarballPath}`)
  }
  return JSON.parse(manifest.data.toString('utf8'))
}

async function readTarEntry(tarballPath, relativePath) {
  const tarBuffer = await gunzipFile(tarballPath)
  const records = parseTarHeaders(tarBuffer)
  const record = records.find((entry) => packageRelativeName(entry.name) === relativePath)
  if (!record) {
    throw new Error(`${relativePath} missing from ${tarballPath}`)
  }
  return record
}

export function assertPackManifest(manifest, label) {
  if (manifest.version !== EXPECTED_VERSION) {
    throw new Error(`${label} tarball version must be ${EXPECTED_VERSION}`)
  }
  if (label === 'companion') {
    for (const section of ['dependencies', 'optionalDependencies']) {
      const deps = manifest[section]
      if (deps && typeof deps === 'object' && Object.keys(deps).length > 0) {
        throw new Error('companion tarball must not declare runtime dependencies')
      }
    }
  }
  const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
  for (const section of dependencySections) {
    const deps = manifest[section]
    if (!deps || typeof deps !== 'object') {
      continue
    }
    for (const [name, specifier] of Object.entries(deps)) {
      if (typeof specifier !== 'string') {
        continue
      }
      if (specifier.startsWith('workspace:') || specifier.startsWith('file:')) {
        throw new Error(`${label} tarball must not declare ${section}.${name}=${specifier}`)
      }
    }
  }
}

function assertAllowedEntries(entries, label, allowed) {
  const sorted = [...entries].sort()
  const expected = [...allowed].sort()
  if (sorted.join('\n') !== expected.join('\n')) {
    throw new Error(`${label} tarball must contain only ${expected.join(', ')}; got ${sorted.join(', ')}`)
  }
}

export function packTar(files) {
  const chunks = []
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content)
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    header.write('0000644\0', 100, 12, 'utf8')
    header.write(body.length.toString(8).padStart(11, '0'), 124, 12, 'utf8')
    chunks.push(header, body)
    const padding = 512 - (body.length % 512)
    if (padding < 512) {
      chunks.push(Buffer.alloc(padding))
    }
  }
  chunks.push(Buffer.alloc(512))
  return Buffer.concat(chunks)
}

export async function inspectPackedTarball(options = {}) {
  const packDir =
    options.packDir ?? await mkdtemp(path.join(tmpdir(), 'tabby-secure-mcp-pack-check-'))
  const shouldCleanup = options.packDir === undefined

  try {
    if (options.runPack ?? true) {
      await packWorkspacePackage('packages/tabby-plugin', packDir)
      await packWorkspacePackage('packages/companion', packDir)
    }

    const pluginPath = path.join(packDir, `tabby-secure-mcp-${EXPECTED_VERSION}.tgz`)
    const companionPath = path.join(packDir, `tabby-secure-mcp-companion-${EXPECTED_VERSION}.tgz`)

    const pluginEntries = await listTarballEntries(pluginPath)
    const companionEntries = await listTarballEntries(companionPath)
    assertAllowedEntries(pluginEntries, 'plugin', ['dist/index.js', 'package.json'])
    assertAllowedEntries(companionEntries, 'companion', ['dist/cli.js', 'package.json'])

    const pluginManifest = await listPackageJsonFromTarball(pluginPath)
    const companionManifest = await listPackageJsonFromTarball(companionPath)
    assertPackManifest(pluginManifest, 'plugin')
    assertTabbyPluginDiscoveryManifest(pluginManifest, 'plugin')
    assertPackManifest(companionManifest, 'companion')
    if (pluginManifest.name !== PLUGIN_PACKAGE_NAME) {
      throw new Error('plugin tarball name mismatch')
    }
    if (companionManifest.name !== COMPANION_PACKAGE_NAME) {
      throw new Error('companion tarball name mismatch')
    }

    const pluginBundle = (await readTarEntry(pluginPath, 'dist/index.js')).data.toString('utf8')
    const companionCliRecord = await readTarEntry(companionPath, 'dist/cli.js')
    const companionShebang = companionCliRecord.data.subarray(0, 20).toString('utf8')

    const result = {
      plugin: {
        version: pluginManifest.version,
        entries: pluginEntries,
        bundle: pluginBundle,
      },
      companion: {
        version: companionManifest.version,
        entries: companionEntries,
        shebang: companionShebang.startsWith('#!/usr/bin/env node')
          ? companionShebang.slice(0, companionShebang.indexOf('\n') + 1)
          : companionShebang,
        mode: companionCliRecord.mode,
        bin: companionManifest.bin,
      },
    }

    if (!result.plugin.bundle.match(/webpackUniversalModuleDefinition|module\.exports/)) {
      throw new Error('plugin bundle is missing a UMD export signature')
    }
    if (/require\(["']node:/.test(result.plugin.bundle)) {
      throw new Error('plugin bundle must not require node: protocol builtins (Tabby host uses unprefixed requires)')
    }
    if (!result.companion.shebang.startsWith('#!/usr/bin/env node')) {
      throw new Error('companion CLI is missing a Node shebang')
    }
    assertCompanionLaunchMode({
      mode: result.companion.mode,
      platform: process.platform,
      bin: result.companion.bin,
    })

    return result
  } finally {
    if (shouldCleanup) {
      await rm(packDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

export async function main() {
  await inspectPackedTarball({ runPack: true })
  process.stdout.write('pack check passed\n')
}
