import { describe, expect, it } from 'vitest'

import { secureMcpSettingsTemplate } from '../src/settings/secure-mcp-settings.template'

describe('Secure MCP settings template', () => {
  it('offers both global command-session close policies with an accessible label', () => {
    expect(secureMcpSettingsTemplate).toContain('for="command-session-close-policy"')
    expect(secureMcpSettingsTemplate).toContain('id="command-session-close-policy"')
    expect(secureMcpSettingsTemplate).toContain('value="keep"')
    expect(secureMcpSettingsTemplate).toContain('value="after-completion"')
    expect(secureMcpSettingsTemplate).toContain('onClosePolicyChange(')
    expect(secureMcpSettingsTemplate).toMatch(/timeout/i)
  })
  it('only uses row.displayName for visible row interpolation', () => {
    const interpolations = secureMcpSettingsTemplate.match(/\{\{[^}]+\}\}/g) ?? []
    const rowInterpolations = interpolations.filter(chunk => chunk.includes('row.'))

    expect(rowInterpolations).toEqual(['{{ row.displayName }}'])
    expect(secureMcpSettingsTemplate).not.toMatch(/\{\{\s*row\.id/)
    expect(secureMcpSettingsTemplate).not.toMatch(/\{\{\s*row\.options/)
    expect(secureMcpSettingsTemplate).not.toMatch(/\{\{[^}]*(host|username|user)[^}]*\}\}/i)
  })
})
