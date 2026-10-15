import { describe, expect, it } from 'vitest'

import { parseNpmPackJson } from './npm-pack-utils.mjs'

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
