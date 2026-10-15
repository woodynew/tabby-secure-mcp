import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGunzip } from 'node:zlib'

export const EXPECTED_VERSION = '0.1.0'
export const PLUGIN_PACKAGE_NAME = 'tabby-secure-mcp'
export const COMPANION_PACKAGE_NAME = '@tabby-secure-mcp/companion'

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ?? process.env,
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed (${code}): ${stderr || stdout}`))
      }
    })
  })
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

async function packWorkspace(workspacePath, destinationDir) {
  const { stdout } = await runCommand('npm', ['pack', '-w', workspacePath, '--pack-destination', destinationDir])
  const tarballName = stdout.trim().split('\n').pop()?.trim()
  if (!tarballName) {
    throw new Error(`npm pack produced no tarball for ${workspacePath}`)
  }
  return path.join(destinationDir, tarballName)
}

export async function inspectPackedTarball(options = {}) {
  const packDir =
    options.packDir ?? await mkdtemp(path.join(tmpdir(), 'tabby-secure-mcp-pack-check-'))
  const shouldCleanup = options.packDir === undefined

  if (options.runPack ?? true) {
    await packWorkspace('packages/tabby-plugin', packDir)
    await packWorkspace('packages/companion', packDir)
  }

  const files = await import('node:fs/promises').then(({ readdir }) => readdir(packDir))
  const pluginTarball = `tabby-secure-mcp-${EXPECTED_VERSION}.tgz`
  const companionTarball = `tabby-secure-mcp-companion-${EXPECTED_VERSION}.tgz`
  if (!files.includes(pluginTarball) || !files.includes(companionTarball)) {
    throw new Error('expected plugin and companion tarballs in pack directory')
  }
  const pluginPath = path.join(packDir, pluginTarball)
  const companionPath = path.join(packDir, companionTarball)

  const pluginEntries = await listTarballEntries(pluginPath)
  const companionEntries = await listTarballEntries(companionPath)
  assertAllowedEntries(pluginEntries, 'plugin', ['dist/index.js', 'package.json'])
  assertAllowedEntries(companionEntries, 'companion', ['dist/cli.js', 'package.json'])

  const pluginManifest = await listPackageJsonFromTarball(pluginPath)
  const companionManifest = await listPackageJsonFromTarball(companionPath)
  assertPackManifest(pluginManifest, 'plugin')
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
    },
  }

  if (!result.plugin.bundle.match(/webpackUniversalModuleDefinition|module\.exports/)) {
    throw new Error('plugin bundle is missing a UMD export signature')
  }
  if (!result.companion.shebang.startsWith('#!/usr/bin/env node')) {
    throw new Error('companion CLI is missing a Node shebang')
  }
  if ((result.companion.mode & 0o111) === 0) {
    throw new Error('companion CLI tarball entry is not marked executable')
  }

  if (shouldCleanup) {
    await rm(packDir, { recursive: true, force: true }).catch(() => undefined)
  }

  return result
}

export async function main() {
  await inspectPackedTarball({ runPack: true })
  process.stdout.write('pack check passed\n')
}
