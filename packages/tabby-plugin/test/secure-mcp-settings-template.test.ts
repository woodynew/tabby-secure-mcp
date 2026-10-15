import { describe, expect, it } from 'vitest'

import { secureMcpSettingsTemplate } from '../src/settings/secure-mcp-settings.template'

describe('Secure MCP settings template', () => {
  it('only uses row.displayName for visible row interpolation', () => {
    const interpolations = secureMcpSettingsTemplate.match(/\{\{[^}]+\}\}/g) ?? []
    const rowInterpolations = interpolations.filter(chunk => chunk.includes('row.'))

    expect(rowInterpolations).toEqual(['{{ row.displayName }}'])
    expect(secureMcpSettingsTemplate).not.toMatch(/\{\{\s*row\.id/)
    expect(secureMcpSettingsTemplate).not.toMatch(/\{\{\s*row\.options/)
    expect(secureMcpSettingsTemplate).not.toMatch(/\{\{[^}]*(host|username|user)[^}]*\}\}/i)
  })
})
