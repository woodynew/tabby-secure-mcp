import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

export function parseNpmPackJson(stdout) {
  const trimmed = stdout.trim()
  if (!trimmed) {
    throw new Error('npm pack produced no JSON output')
  }
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new Error('npm pack JSON output is not valid JSON')
  }
  const records = Array.isArray(parsed) ? parsed : [parsed]
  if (records.length !== 1) {
    throw new Error(`npm pack JSON must contain exactly one record, got ${records.length}`)
  }
  const record = records[0]
  if (!record || typeof record !== 'object') {
    throw new Error('npm pack JSON record is malformed')
  }
  if (typeof record.filename !== 'string' || record.filename.length === 0) {
    throw new Error('npm pack JSON record is missing filename')
  }
  if (typeof record.name !== 'string' || record.name.length === 0) {
    throw new Error('npm pack JSON record is missing name')
  }
  if (typeof record.version !== 'string' || record.version.length === 0) {
    throw new Error('npm pack JSON record is missing version')
  }
  return record
}

export function resolveNpmLauncher(_platform = process.platform) {
  const candidates = [
    process.env.npm_execpath && path.join(path.dirname(process.env.npm_execpath), 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  ]
  const cli = candidates.find(candidate => candidate && existsSync(candidate))
  if (!cli) throw new Error('Cannot locate npm-cli.js. Run this command through npm run.')
  return { command: process.execPath, args: [cli], shell: false }
}

export function runCommand(command, args, options = {}) {
  const launched = command === 'npm' ? resolveNpmLauncher() : { command, shell: false }
  return new Promise((resolve, reject) => {
    const child = spawn(launched.command, [...(launched.args ?? []), ...args], {
      cwd: options.cwd ?? repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ?? process.env,
      shell: launched.shell,
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
        reject(new Error(`${launched.command} ${args.join(' ')} failed (${code}): ${stderr || stdout}`))
      }
    })
  })
}

export async function packWorkspacePackage(workspacePath, destinationDir, options = {}) {
  const { stdout } = await runCommand(
    'npm',
    ['pack', '-w', workspacePath, '--json', '--pack-destination', destinationDir],
    options,
  )
  const record = parseNpmPackJson(stdout)
  return {
    tarballPath: path.join(destinationDir, record.filename),
    record,
  }
}
