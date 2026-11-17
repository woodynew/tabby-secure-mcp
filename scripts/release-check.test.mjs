import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { checkRelease } from './release-check.mjs'

const directories = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'release-check-'))
  directories.push(cwd)
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main')
  await mkdir(path.join(cwd, 'packages/tabby-plugin'), { recursive: true })
  await writeFile(path.join(cwd, 'packages/tabby-plugin/package.json'), JSON.stringify({ name: 'tabby-secure-mcp', version: '0.1.0' }))
  git('add', '.')
  const commit = () => git('-c', 'user.name=Release Test', '-c', 'user.email=release@example.invalid', 'commit', '--allow-empty', '-m', 'fixture')
  commit()
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  git('-c', 'user.name=Release Test', '-c', 'user.email=release@example.invalid', 'tag', '-a', 'v0.1.0', '-m', 'release')
  return { cwd, git, commit, context: { repository: 'woodynew/tabby-secure-mcp', tag: 'v0.1.0', ref: 'refs/tags/v0.1.0', sha: git('rev-parse', 'HEAD') } }
}

describe('release validation', () => {
  it('accepts a matching version tag whose commit is on main', async () => {
    const { cwd, context } = await fixture()
    expect(() => checkRelease(context, cwd)).not.toThrow()
  })

  it('refuses a dispatch from a branch even when a tag is supplied', async () => {
    const { cwd, context } = await fixture()
    expect(() => checkRelease({ ...context, ref: 'refs/heads/main' }, cwd)).toThrow(/tag ref/i)
  })

  it('refuses a fork', async () => {
    const { cwd, context } = await fixture()
    expect(() => checkRelease({ ...context, repository: 'other/fork' }, cwd)).toThrow(/repository/i)
  })

  it('refuses input that is not a stable version tag', async () => {
    const { cwd, context } = await fixture()
    expect(() => checkRelease({ ...context, tag: 'v0.1.0; echo injected' }, cwd)).toThrow(/version tag/i)
  })

  it('refuses a tag that does not match the package version', async () => {
    const { cwd, context } = await fixture()
    expect(() => checkRelease({ ...context, tag: 'v0.2.0', ref: 'refs/tags/v0.2.0' }, cwd)).toThrow(/package version/i)
  })

  it('refuses a tag whose target differs from the event commit', async () => {
    const { cwd, context, git, commit } = await fixture()
    commit()
    git('tag', '-f', 'v0.1.0')
    expect(() => checkRelease(context, cwd)).toThrow(/commit/i)
  })

  it('refuses an otherwise valid tag outside main', async () => {
    const { cwd, context, git, commit } = await fixture()
    commit()
    git('tag', '-f', 'v0.1.0')
    expect(() => checkRelease({ ...context, sha: git('rev-parse', 'HEAD') }, cwd)).toThrow(/main/i)
  })
})
