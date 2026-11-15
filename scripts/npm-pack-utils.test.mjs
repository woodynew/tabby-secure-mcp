import { describe, expect, it } from 'vitest'

import { parseNpmPackJson, resolveNpmLauncher } from './npm-pack-utils.mjs'

describe('resolveNpmLauncher', () => {
  it('launches npm JavaScript through Node without a shell on every platform', () => {
    for (const platform of ['win32', 'linux', 'darwin']) {
      const launcher = resolveNpmLauncher(platform)
      expect(launcher.command).toBe(process.execPath)
      expect(launcher.shell).toBe(false)
      expect(launcher.args[0]).toMatch(/npm-cli\.js$/)
    }
  })
})

describe('parseNpmPackJson', () => {
  it('parses a single npm pack record', () => {
    const record = parseNpmPackJson(
      JSON.stringify([
        {
          name: 'tabby-secure-mcp',
          version: '0.1.0',
          filename: 'tabby-secure-mcp-0.1.0.tgz',
        },
      ]),
    )
    expect(record.filename).toBe('tabby-secure-mcp-0.1.0.tgz')
  })

  it('rejects malformed output', () => {
    expect(() => parseNpmPackJson('')).toThrow(/no JSON/i)
    expect(() => parseNpmPackJson('[]')).toThrow(/exactly one record/i)
  })
})
