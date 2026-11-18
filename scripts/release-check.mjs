import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

export function checkRelease({ repository, tag, ref, sha }, cwd = repoRoot) {
  if (repository !== 'woodynew/tabby-secure-mcp') throw new Error('Unexpected release repository')
  if (typeof tag !== 'string' || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) {
    throw new Error('Release requires a stable version tag such as v0.1.0')
  }
  if (ref !== `refs/tags/${tag}`) throw new Error('Dispatch must use the matching tag ref')
  const manifest = JSON.parse(readFileSync(path.join(cwd, 'packages/tabby-plugin/package.json'), 'utf8'))
  if (manifest.name !== 'tabby-secure-mcp' || manifest.private === true || tag !== `v${manifest.version}`) {
    throw new Error('Release tag must match the public plugin package version')
  }
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  if (git('rev-parse', 'HEAD') !== sha || git('rev-parse', `${ref}^{commit}`) !== sha) {
    throw new Error('Checked-out commit and tag must match the workflow event commit')
  }
  try {
    git('merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main')
  } catch {
    throw new Error('Release commit must already be included in origin/main')
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    checkRelease({ repository: process.env.GITHUB_REPOSITORY, tag: process.env.RELEASE_TAG, ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA })
    process.stdout.write('Release source, tag and package version verified\n')
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
