import { spawn } from 'node:child_process'
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

export function runCommand(command, args, options = {}) {
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
