import { lstat, mkdir, mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises'
import { homedir as nodeHomedir, tmpdir as nodeTmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

async function removeOwnedRegularFile(filePath, runtimeDirectory, platform) {
  try {
    const fileStat = await lstat(filePath)
    if (fileStat.isSymbolicLink()) {
      return
    }
    if (!isPathInsideDirectory(filePath, runtimeDirectory, platform)) {
      return
    }
    await unlink(filePath)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return
    }
    throw error
  }
}

export async function cleanStaleRuntimeArtifacts(runtimePaths, deps = {}) {
  const platform = deps.platform ?? process.platform
  await removeOwnedRegularFile(runtimePaths.descriptorPath, runtimePaths.runtimeDirectory, platform)
  await removeOwnedRegularFile(runtimePaths.lockPath, runtimePaths.runtimeDirectory, platform)
  if (platform !== 'win32') {
    await removeOwnedRegularFile(runtimePaths.endpoint, runtimePaths.runtimeDirectory, platform)
  }
}

export function companionBinPath(pluginsDir, platform = process.platform) {
  const binName = platform === 'win32' ? 'tabby-secure-mcp.cmd' : 'tabby-secure-mcp'
  const pathApi = platformPathApi(platform)
  return pathApi.join(pluginsDir, 'node_modules', '.bin', binName)
}

export async function verifyInstalledLayout(pluginsDir, deps = {}) {
  const platform = deps.platform ?? process.platform
  const pluginPkgPath = path.join(pluginsDir, 'node_modules', PLUGIN_PACKAGE_NAME, 'package.json')
  const companionPkgPath = path.join(
    pluginsDir,
    'node_modules',
    '@tabby-secure-mcp',
    'companion',
    'package.json',
  )
  const pluginPkg = JSON.parse(await readFile(pluginPkgPath, 'utf8'))
  const companionPkg = JSON.parse(await readFile(companionPkgPath, 'utf8'))
  if (pluginPkg.name !== PLUGIN_PACKAGE_NAME || pluginPkg.version !== EXPECTED_VERSION) {
    throw new Error('installed plugin package name or version mismatch')
  }
  if (companionPkg.name !== COMPANION_PACKAGE_NAME || companionPkg.version !== EXPECTED_VERSION) {
    throw new Error('installed companion package name or version mismatch')
  }
  await stat(path.join(pluginsDir, 'node_modules', PLUGIN_PACKAGE_NAME, 'dist', 'index.js'))
  await stat(path.join(pluginsDir, 'node_modules', '@tabby-secure-mcp', 'companion', 'dist', 'cli.js'))
  await stat(companionBinPath(pluginsDir, platform))
}

export function listInstallerMetadataPaths(pluginsDir) {
  return [
    path.join(pluginsDir, 'package.json'),
    path.join(pluginsDir, 'package-lock.json'),
    path.join(pluginsDir, 'node_modules', '.package-lock.json'),
  ]
}

export async function removeTransientInstallerMetadata(pluginsDir) {
  const hiddenLock = path.join(pluginsDir, 'node_modules', '.package-lock.json')
  try {
    await unlink(hiddenLock)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return
    }
    throw error
  }
}

export async function assertNoTransientInstallerReferences(pluginsDir) {
  for (const manifestPath of listInstallerMetadataPaths(pluginsDir)) {
    try {
      const raw = await readFile(manifestPath, 'utf8')
      if (raw.includes('file:')) {
        throw new Error(`${manifestPath} must not persist file: dependency references`)
      }
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        continue
      }
      throw error
    }
  }
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
  await cleanStaleRuntimeArtifacts(runtimePaths, { platform })

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
    const companionPack = await packWorkspacePackage('packages/companion', packDir, {
      cwd: repoRoot,
      env: options.env,
    })

    await mkdir(pluginsDir, { recursive: true })
    await runCommand(
      'npm',
      [
        'install',
        '--prefix',
        pluginsDir,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--no-save',
        '--legacy-peer-deps',
        pluginPack.tarballPath,
        companionPack.tarballPath,
      ],
      { cwd: repoRoot, env: options.env },
    )

    await verifyInstalledLayout(pluginsDir, { platform })
    await removeTransientInstallerMetadata(pluginsDir)
    await assertNoTransientInstallerReferences(pluginsDir)

    const companionCommand = platformPathApi(platform).resolve(companionBinPath(pluginsDir, platform))
    return {
      pluginsDir: platformPathApi(platform).resolve(pluginsDir),
      companionCommand,
      pluginPack,
      companionPack,
    }
  } finally {
    if (ownsPackDir && !options.keepPackDir) {
      await rm(packDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { pluginsDir, companionCommand } = await runInstall({ argv })
  process.stdout.write(`${pluginsDir}\n${companionCommand}\n`)
}
