import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises'
import { homedir as nodeHomedir, tmpdir as nodeTmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const EXPECTED_VERSION = '0.1.0'
export const PLUGIN_PACKAGE_NAME = 'tabby-secure-mcp'
export const COMPANION_PACKAGE_NAME = '@tabby-secure-mcp/companion'

const MAX_DESCRIPTOR_BYTES = 4096
const PAIRING_NONCE_BYTES = 32

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

export function resolveDefaultPluginsDir(deps = {}) {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const getHome = deps.homedir ?? nodeHomedir

  if (platform === 'win32') {
    const appData = env.APPDATA ?? path.win32.join(getHome(), 'AppData', 'Roaming')
    return path.win32.join(appData, 'tabby', 'plugins')
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
  const isAbsoluteInput =
    platform === 'win32' ? path.win32.isAbsolute(pluginsDir) : path.isAbsolute(pluginsDir)
  if (!isAbsoluteInput) {
    throw new Error('plugins directory must be an absolute path')
  }
  const resolved =
    platform === 'win32' ? path.win32.resolve(pluginsDir) : path.resolve(pluginsDir)
  const root = platform === 'win32' ? path.win32.parse(resolved).root : path.parse(resolved).root
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

export function resolveRuntimePaths(deps = {}) {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const getHome = deps.homedir ?? nodeHomedir
  const getTmp = deps.tmpdir ?? nodeTmpdir

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? path.win32.join(getHome(), 'AppData', 'Local')
    const runtimeDirectory = path.win32.join(localAppData, 'tabby-secure-mcp')
    return {
      runtimeDirectory,
      endpoint: `\\\\.\\pipe\\tabby-secure-mcp-placeholder`,
      descriptorPath: path.win32.join(runtimeDirectory, 'descriptor.json'),
      lockPath: path.win32.join(runtimeDirectory, 'companion.lock'),
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
  const resolve = platform === 'win32' ? path.win32.resolve : path.resolve
  const relative = platform === 'win32' ? path.win32.relative : path.relative
  const resolvedCandidate = resolve(candidate)
  const resolvedDirectory = resolve(directory)
  const rel = relative(resolvedDirectory, resolvedCandidate)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
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

export async function assessRuntimeDescriptorState(runtimePaths, deps = {}) {
  const platform = deps.platform ?? process.platform
  const isProcessAlive = deps.isProcessAlive ?? defaultProcessLivenessProbe
  let raw
  try {
    const fileStat = await lstat(runtimePaths.descriptorPath)
    if (fileStat.isSymbolicLink()) {
      return { kind: 'stale' }
    }
    if (fileStat.size > MAX_DESCRIPTOR_BYTES) {
      return { kind: 'stale' }
    }
    raw = await readFile(runtimePaths.descriptorPath, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { kind: 'stale' }
    }
    throw error
  }

  const parsed = parseDescriptorBounded(raw)
  if (!parsed.ok) {
    return { kind: 'stale' }
  }
  if (isProcessAlive(parsed.descriptor.pid)) {
    return { kind: 'live_companion', pid: parsed.descriptor.pid }
  }
  return { kind: 'stale' }
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
  if (platform === 'win32') {
    return path.win32.join(pluginsDir, 'node_modules', '.bin', binName)
  }
  return path.join(pluginsDir, 'node_modules', '.bin', binName)
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

async function packWorkspacePackage(workspacePath, destinationDir) {
  const { stdout } = await runCommand(
    'npm',
    ['pack', '-w', workspacePath, '--pack-destination', destinationDir],
    {
      cwd: repoRoot,
    },
  )
  const tarballName = stdout.trim().split('\n').pop()?.trim()
  if (!tarballName) {
    throw new Error(`npm pack produced no tarball for ${workspacePath}`)
  }
  return path.join(destinationDir, tarballName)
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
  const runtimeState = await assessRuntimeDescriptorState(runtimePaths, {
    platform,
    isProcessAlive: options.isProcessAlive,
  })
  if (runtimeState.kind === 'live_companion') {
    throw new Error(
      `tabby-secure-mcp companion is still running (pid ${runtimeState.pid}). Stop the companion process and retry.`,
    )
  }
  await cleanStaleRuntimeArtifacts(runtimePaths, { platform })

  if (!parsed.skipBuild) {
    await runCommand('npm', ['run', 'build'], { cwd: repoRoot, env: options.env })
  }

  const packDir = options.packDir ?? await mkdtemp(path.join(nodeTmpdir(), 'tabby-secure-mcp-pack-'))
  const pluginTarball = await packWorkspacePackage('packages/tabby-plugin', packDir)
  const companionTarball = await packWorkspacePackage('packages/companion', packDir)

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
      '--save-exact',
      pluginTarball,
      companionTarball,
    ],
    { cwd: repoRoot, env: options.env },
  )

  await verifyInstalledLayout(pluginsDir, { platform })

  if (!options.keepPackDir) {
    await rm(packDir, { recursive: true, force: true }).catch(() => undefined)
  }

  const companionCommand = path.resolve(companionBinPath(pluginsDir, platform))
  return { pluginsDir: path.resolve(pluginsDir), companionCommand }
}

export async function main(argv = process.argv.slice(2)) {
  const { pluginsDir, companionCommand } = await runInstall({ argv })
  process.stdout.write(`${pluginsDir}\n${companionCommand}\n`)
}
