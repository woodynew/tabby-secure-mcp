import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir as nodeHomedir, tmpdir as nodeTmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertPackManifest, assertPluginBundle, assertTabbyPluginDiscoveryManifest } from './pack-check-core.mjs'
import { packWorkspacePackage, runCommand } from './npm-pack-utils.mjs'

export const EXPECTED_VERSION = '0.1.0'
export const PLUGIN_PACKAGE_NAME = 'tabby-secure-mcp'
export const COMPANION_PACKAGE_NAME = '@tabby-secure-mcp/companion'

const MAX_DESCRIPTOR_BYTES = 4096
const MAX_LOCK_BYTES = 4096
const MAX_LOCK_OWNER_LENGTH = 128
const PAIRING_NONCE_BYTES = 32

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

export function platformPathApi(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path
}

export function resolveDefaultPluginsDir(deps = {}) {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const getHome = deps.homedir ?? nodeHomedir
  const pathApi = platformPathApi(platform)

  if (platform === 'win32') {
    const appData = env.APPDATA ?? pathApi.join(getHome(), 'AppData', 'Roaming')
    return pathApi.join(appData, 'tabby', 'plugins')
  }
  if (platform === 'darwin') {
    return path.join(getHome(), 'Library', 'Application Support', 'tabby', 'plugins')
  }
  return path.join(getHome(), '.config', 'tabby', 'plugins')
}

export function assertSafeAbsolutePluginsDir(pluginsDir, deps = {}) {
  if (typeof pluginsDir !== 'string' || pluginsDir.length === 0) {
    throw new Error('plugins directory must be a non-empty string')
  }
  if (pluginsDir.includes('\0')) {
    throw new Error('plugins directory contains an unsafe null byte')
  }
  const platform = deps.platform ?? process.platform
  const pathApi = platformPathApi(platform)
  if (!pathApi.isAbsolute(pluginsDir)) {
    throw new Error('plugins directory must be an absolute path')
  }
  const resolved = pathApi.resolve(pluginsDir)
  const root = pathApi.parse(resolved).root
  if (resolved === root || resolved === root.replace(/\\$/, '')) {
    throw new Error('plugins directory path is unsafe')
  }
  return resolved
}

export function parseCliArgs(argv) {
  let pluginsDir
  let skipBuild = false
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--skip-build') {
      skipBuild = true
      continue
    }
    if (token === '--plugins-dir') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('--plugins-dir requires an absolute path argument')
      }
      pluginsDir = value
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${token}`)
  }
  return { pluginsDir, skipBuild }
}

function decodePairingNonce(nonce) {
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]+$/.test(nonce)) {
    return undefined
  }
  const bytes = Buffer.from(nonce, 'base64url')
  return bytes.length === PAIRING_NONCE_BYTES ? bytes : undefined
}

export function parseDescriptorBounded(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_DESCRIPTOR_BYTES) {
    return { ok: false, code: 'oversize' }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, code: 'malformed' }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, code: 'invalid' }
  }
  if (parsed.protocol_version !== 1) {
    return { ok: false, code: 'invalid' }
  }
  if (typeof parsed.endpoint !== 'string' || parsed.endpoint.length === 0) {
    return { ok: false, code: 'invalid' }
  }
  if (Buffer.byteLength(parsed.endpoint, 'utf8') > 8 * 1024) {
    return { ok: false, code: 'invalid' }
  }
  if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) {
    return { ok: false, code: 'invalid' }
  }
  if (!Number.isInteger(parsed.expires_at) || parsed.expires_at <= 0) {
    return { ok: false, code: 'invalid' }
  }
  if (decodePairingNonce(parsed.pairing_nonce) === undefined) {
    return { ok: false, code: 'invalid' }
  }
  return {
    ok: true,
    descriptor: {
      protocol_version: 1,
      endpoint: parsed.endpoint,
      pid: parsed.pid,
      expires_at: parsed.expires_at,
      pairing_nonce: parsed.pairing_nonce,
    },
  }
}

export function parseLockBounded(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_LOCK_BYTES) {
    return { ok: false, code: 'oversize' }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, code: 'malformed' }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, code: 'invalid' }
  }
  if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) {
    return { ok: false, code: 'invalid' }
  }
  if (typeof parsed.owner !== 'string' || parsed.owner.length === 0) {
    return { ok: false, code: 'invalid' }
  }
  if (Buffer.byteLength(parsed.owner, 'utf8') > MAX_LOCK_OWNER_LENGTH) {
    return { ok: false, code: 'invalid' }
  }
  return { ok: true, lock: { pid: parsed.pid, owner: parsed.owner } }
}

export function resolveRuntimePaths(deps = {}) {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const getHome = deps.homedir ?? nodeHomedir
  const getTmp = deps.tmpdir ?? nodeTmpdir
  const pathApi = platformPathApi(platform)

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? pathApi.join(getHome(), 'AppData', 'Local')
    const runtimeDirectory = pathApi.join(localAppData, 'tabby-secure-mcp')
    return {
      runtimeDirectory,
      endpoint: `\\\\.\\pipe\\tabby-secure-mcp-placeholder`,
      descriptorPath: pathApi.join(runtimeDirectory, 'descriptor.json'),
      lockPath: pathApi.join(runtimeDirectory, 'companion.lock'),
    }
  }

  const runtimeBase =
    platform === 'linux' && env.XDG_RUNTIME_DIR ? env.XDG_RUNTIME_DIR : getTmp()
  const runtimeDirectory = path.posix.join(runtimeBase, 'tabby-secure-mcp')
  return {
    runtimeDirectory,
    endpoint: path.posix.join(runtimeDirectory, 'companion.sock'),
    descriptorPath: path.posix.join(runtimeDirectory, 'descriptor.json'),
    lockPath: path.posix.join(runtimeDirectory, 'companion.lock'),
  }
}

function isPathInsideDirectory(candidate, directory, platform) {
  const pathApi = platformPathApi(platform)
  const resolvedCandidate = pathApi.resolve(candidate)
  const resolvedDirectory = pathApi.resolve(directory)
  const rel = pathApi.relative(resolvedDirectory, resolvedCandidate)
  return rel === '' || (!rel.startsWith('..') && !pathApi.isAbsolute(rel))
}

async function readArtifactState(filePath) {
  try {
    const fileStat = await lstat(filePath)
    if (fileStat.isSymbolicLink()) {
      return { kind: 'symlink' }
    }
    if (fileStat.size > MAX_DESCRIPTOR_BYTES) {
      return { kind: 'oversize' }
    }
    const raw = await readFile(filePath, 'utf8')
    return { kind: 'present', raw, size: fileStat.size }
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { kind: 'missing' }
    }
    throw error
  }
}

async function readLockArtifactState(filePath) {
  try {
    const fileStat = await lstat(filePath)
    if (fileStat.isSymbolicLink()) {
      return { kind: 'symlink' }
    }
    if (fileStat.size > MAX_LOCK_BYTES) {
      return { kind: 'oversize' }
    }
    const raw = await readFile(filePath, 'utf8')
    return { kind: 'present', raw, size: fileStat.size }
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { kind: 'missing' }
    }
    throw error
  }
}

function lockParseState(lockArtifact) {
  if (lockArtifact.kind === 'missing') {
    return { shape: 'missing' }
  }
  if (lockArtifact.kind === 'symlink') {
    return { shape: 'symlink' }
  }
  if (lockArtifact.kind === 'oversize') {
    return { shape: 'malformed' }
  }
  const parsed = parseLockBounded(lockArtifact.raw)
  if (!parsed.ok) {
    return { shape: 'malformed' }
  }
  return { shape: 'valid', pid: parsed.lock.pid }
}

function descriptorParseState(descriptorArtifact) {
  if (descriptorArtifact.kind === 'missing') {
    return { shape: 'missing' }
  }
  if (descriptorArtifact.kind === 'symlink') {
    return { shape: 'symlink' }
  }
  if (descriptorArtifact.kind === 'oversize') {
    return { shape: 'malformed' }
  }
  const parsed = parseDescriptorBounded(descriptorArtifact.raw)
  if (!parsed.ok) {
    return { shape: 'malformed' }
  }
  return { shape: 'valid', pid: parsed.descriptor.pid }
}

export async function assessRuntimeCleanupSafety(runtimePaths, deps = {}) {
  const platform = deps.platform ?? process.platform
  const isProcessAlive = deps.isProcessAlive ?? defaultProcessLivenessProbe

  const descriptorArtifact = await readArtifactState(runtimePaths.descriptorPath)
  const lockArtifact = await readLockArtifactState(runtimePaths.lockPath)
  const descriptor = descriptorParseState(descriptorArtifact)
  const lock = lockParseState(lockArtifact)

  if (descriptor.shape === 'symlink' || lock.shape === 'symlink') {
    return {
      status: 'blocked',
      message:
        'companion runtime artifacts include a symbolic link. Inspect the runtime directory manually, stop any tabby-secure-mcp companion, and retry.',
    }
  }

  if (descriptor.shape === 'malformed') {
    return {
      status: 'blocked',
      message:
        'companion runtime descriptor is malformed or oversize. Stop any tabby-secure-mcp companion, inspect the runtime directory manually, and retry.',
    }
  }

  if (descriptor.shape === 'missing') {
    if (lock.shape === 'symlink' || lock.shape === 'malformed') {
      return {
        status: 'blocked',
        message:
          'companion runtime lock is malformed or unsafe while descriptor is missing. Stop any tabby-secure-mcp companion, inspect the runtime directory manually, and retry.',
      }
    }
    if (lock.shape === 'valid' && isProcessAlive(lock.pid)) {
      return {
        status: 'blocked',
        message: `tabby-secure-mcp companion is still running (pid ${lock.pid}). Stop the companion process and retry.`,
        pid: lock.pid,
      }
    }
  }

  if (lock.shape === 'malformed') {
    return {
      status: 'blocked',
      message:
        'companion runtime lock is malformed or oversize. Stop any tabby-secure-mcp companion, inspect the runtime directory manually, and retry.',
    }
  }

  const livePids = []
  if (descriptor.shape === 'valid' && isProcessAlive(descriptor.pid)) {
    livePids.push(descriptor.pid)
  }
  if (lock.shape === 'valid' && isProcessAlive(lock.pid)) {
    livePids.push(lock.pid)
  }
  if (livePids.length > 0) {
    const pid = livePids[0]
    return {
      status: 'blocked',
      message: `tabby-secure-mcp companion is still running (pid ${pid}). Stop the companion process and retry.`,
      pid,
    }
  }

  if (platform !== 'win32') {
    try {
      const socketStat = await lstat(runtimePaths.endpoint)
      if (socketStat.isSymbolicLink()) {
        return {
          status: 'blocked',
          message:
            'companion runtime socket is a symbolic link. Inspect the runtime directory manually, stop any tabby-secure-mcp companion, and retry.',
        }
      }
    } catch (error) {
      if (!(error && typeof error === 'object' && error.code === 'ENOENT')) {
        throw error
      }
    }
  }

  return { status: 'cleanable' }
}

/** @deprecated Stop all clients and inspect stale artifacts manually; never delete live paths. */
export async function cleanStaleRuntimeArtifacts(_runtimePaths, _deps = {}) {}

export async function verifyInstalledLayout(pluginsDir) {
  const pluginRoot = path.join(pluginsDir, 'node_modules', PLUGIN_PACKAGE_NAME)
  const pluginPkg = JSON.parse(await readFile(path.join(pluginRoot, 'package.json'), 'utf8'))
  if (pluginPkg.name !== PLUGIN_PACKAGE_NAME || pluginPkg.version !== EXPECTED_VERSION) {
    throw new Error('installed plugin package name or version mismatch')
  }
  assertTabbyPluginDiscoveryManifest(pluginPkg, 'installed plugin')
  assertPackManifest(pluginPkg, 'plugin')
  if (pluginPkg.main !== 'dist/index.js') throw new Error('installed plugin main must be dist/index.js')
  assertPluginBundle(await readFile(path.join(pluginRoot, 'dist', 'index.js'), 'utf8'))
}

export function listInstallerMetadataPaths(pluginsDir) {
  return [
    path.join(pluginsDir, 'package.json'),
    path.join(pluginsDir, 'package-lock.json'),
    path.join(pluginsDir, 'node_modules', '.package-lock.json'),
  ]
}

/** @deprecated Persistent dependencies require preserving npm metadata. */
export async function removeTransientInstallerMetadata(_pluginsDir) {}

export async function assertNoTransientInstallerReferences(pluginsDir) {
  const manifest = await readPluginsManifest(pluginsDir)
  for (const name of [PLUGIN_PACKAGE_NAME]) {
    const reference = manifest.dependencies?.[name]
    if (reference === undefined) continue
    if (typeof reference !== 'string' || !reference.startsWith('file:')) throw new Error(`Missing persistent file: dependency for ${name}`)
    const artifact = path.resolve(pluginsDir, reference.slice(5))
    const store = path.join(pluginsDir, '.secure-mcp-artifacts')
    if (path.dirname(artifact) !== store || !/^[a-f0-9]{64}\.tgz$/.test(path.basename(artifact))) throw new Error(`Unsafe file: dependency for ${name}`)
    const info = await lstat(artifact)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe installer artifact')
    const hash = createHash('sha256').update(await readFile(artifact)).digest('hex')
    if (path.basename(artifact) !== `${hash}.tgz`) throw new Error('Installer artifact checksum mismatch')
  }
}

async function readPluginsManifest(pluginsDir) {
  try {
    const manifest = JSON.parse(await readFile(path.join(pluginsDir, 'package.json'), 'utf8'))
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid plugins package.json')
    return manifest
  } catch (error) {
    if (error?.code === 'ENOENT') return { private: true }
    throw error
  }
}

async function assertRegisteredPlugins(pluginsDir) {
  const manifest = await readPluginsManifest(pluginsDir)
  const declared = new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies }))
  const nodeModules = path.join(pluginsDir, 'node_modules')
  let roots
  try { roots = await readdir(nodeModules, { withFileTypes: true }) } catch (error) { if (error?.code === 'ENOENT') return; throw error }
  const packages = []
  for (const entry of roots) {
    if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue
    if (entry.name.startsWith('@')) {
      for (const child of await readdir(path.join(nodeModules, entry.name))) packages.push(`${entry.name}/${child}`)
    } else packages.push(entry.name)
  }
  const unregistered = []
  for (const name of packages) {
    if ([PLUGIN_PACKAGE_NAME, COMPANION_PACKAGE_NAME].includes(name) || declared.has(name)) continue
    let pkg
    try { pkg = JSON.parse(await readFile(path.join(nodeModules, name, 'package.json'), 'utf8')) } catch (error) { if (error?.code === 'ENOENT') continue; throw error }
    if (Array.isArray(pkg.keywords) && pkg.keywords.includes('tabby-plugin')) unregistered.push(name)
  }
  if (unregistered.length) throw new Error(`Unregistered Tabby plugins: ${unregistered.join(', ')}. Register them in package.json before installing.`)
}

async function persistTarball(pluginsDir, file) {
  const data = await readFile(file)
  const hash = createHash('sha256').update(data).digest('hex')
  const directory = path.join(pluginsDir, '.secure-mcp-artifacts')
  await mkdir(directory, { recursive: true })
  const target = path.join(directory, `${hash}.tgz`)
  try { await writeFile(target, data, { flag: 'wx', mode: 0o600 }) } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink() || createHash('sha256').update(await readFile(target)).digest('hex') !== hash) throw new Error('Installer artifact collision')
  }
  return target
}

/** @deprecated Use assertNoTransientInstallerReferences */
export async function assertNoFileDependencyPersistence(pluginsDir) {
  return assertNoTransientInstallerReferences(pluginsDir)
}

function defaultProcessLivenessProbe(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined
    if (code === 'ESRCH') {
      return false
    }
    return true
  }
}

export async function runInstall(options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const parsed = parseCliArgs(options.argv ?? process.argv.slice(2))
  const pluginsDir = assertSafeAbsolutePluginsDir(
    parsed.pluginsDir ?? resolveDefaultPluginsDir({ platform, env, homedir: options.homedir }),
    { platform },
  )

  const runtimePaths = resolveRuntimePaths({
    platform,
    env,
    homedir: options.homedir,
    tmpdir: options.tmpdir,
  })
  const runtimeAssessment = await assessRuntimeCleanupSafety(runtimePaths, {
    platform,
    isProcessAlive: options.isProcessAlive,
  })
  if (runtimeAssessment.status === 'blocked') {
    throw new Error(runtimeAssessment.message)
  }
  await assertRegisteredPlugins(pluginsDir)

  if (!parsed.skipBuild) {
    await runCommand('npm', ['run', 'build'], { cwd: repoRoot, env: options.env })
  }

  const ownsPackDir = options.packDir === undefined
  const packDir = options.packDir ?? await mkdtemp(path.join(nodeTmpdir(), 'tabby-secure-mcp-pack-'))
  try {
    const pluginPack = await packWorkspacePackage('packages/tabby-plugin', packDir, {
      cwd: repoRoot,
      env: options.env,
    })
    await mkdir(pluginsDir, { recursive: true })
    const pluginArtifact = await persistTarball(pluginsDir, pluginPack.tarballPath)
    try { await writeFile(path.join(pluginsDir, 'package.json'), JSON.stringify({ private: true }, null, 2) + '\n', { flag: 'wx' }) } catch (error) { if (error?.code !== 'EEXIST') throw error }
    await runCommand(
      'npm',
      [
        'install',
        '--prefix',
        pluginsDir,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--save',
        '--save-exact',
        '--legacy-peer-deps',
        '--include=dev',
        '--include=optional',
        pluginArtifact,
      ],
      { cwd: repoRoot, env: options.env },
    )

    await verifyInstalledLayout(pluginsDir)
    const installedManifest = await readPluginsManifest(pluginsDir)
    for (const name of [PLUGIN_PACKAGE_NAME]) {
      if (!installedManifest.dependencies?.[name]) throw new Error(`Missing persistent dependency for ${name}`)
    }
    await assertNoTransientInstallerReferences(pluginsDir)

    const warnings = []
    if (['dependencies', 'devDependencies', 'optionalDependencies'].some(section => installedManifest[section]?.[COMPANION_PACKAGE_NAME] !== undefined)) {
      warnings.push('Legacy companion dependency retained. Disable old stdio client configurations; remove the old package manually when no longer needed.')
    }
    return {
      pluginsDir: platformPathApi(platform).resolve(pluginsDir),
      connectionInstructions: 'Restart Tabby, enable Secure MCP in the main window, add a client and copy its local Streamable HTTP URL and Authorization header from settings. Disable old stdio client configurations.',
      warnings,
      pluginPack,
    }
  } finally {
    if (ownsPackDir && !options.keepPackDir) {
      await rm(packDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { pluginsDir, connectionInstructions, warnings } = await runInstall({ argv })
  process.stdout.write([pluginsDir, connectionInstructions, ...warnings].join('\n') + '\n')
}
