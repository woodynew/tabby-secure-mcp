import { describe, expect, it } from 'vitest'

import { secureMcpSettingsTemplate } from '../src/settings/secure-mcp-settings.template'

describe('Secure MCP settings template', () => {
  it('binds file transfer to each selected client and SSH target without a global toggle', () => {
    const row = secureMcpSettingsTemplate.match(/<div class="connection-row"[\s\S]*?<\/div><p \*ngIf="!loading/)?.[0] ?? ''
    expect(row).toContain('[checked]="clientFileTransferEnabled(client, row)"')
    expect(row).toContain('(change)="onChangeClientFileTransfer(client, row, $any($event.target).checked, $any($event.target))"')
    expect(row).toMatch(/<input type="checkbox"[^>]*\[disabled\]="!canManage \|\| saving"/)
    expect(row).toContain("'secureMcp.enableFileTransfer' | translate")
    expect(secureMcpSettingsTemplate.match(/clientFileTransferEnabled\(/g)).toHaveLength(1)
    expect(secureMcpSettingsTemplate.match(/'secureMcp.fileTransferHelp' \| translate/g)).toHaveLength(1)
  })

  it('offers both global command-session close policies with an accessible label', () => {
    expect(secureMcpSettingsTemplate).toContain('for="command-session-close-policy"')
    expect(secureMcpSettingsTemplate).toContain('id="command-session-close-policy"')
    expect(secureMcpSettingsTemplate).toContain('value="keep"')
    expect(secureMcpSettingsTemplate).toContain('value="after-completion"')
    expect(secureMcpSettingsTemplate).toContain('onClosePolicyChange(')
    expect(secureMcpSettingsTemplate).toContain("'secureMcp.commandSessionsHelp' | translate")
  })
  it('retains per-client connection grants without restoring the global open-grant control', () => {
    expect(secureMcpSettingsTemplate).toContain('onChangeClientConnection(client, row, connectionChoice.value)')
    expect(secureMcpSettingsTemplate).toContain('onChangeClientPermission(client.id, client.generation, permissionChoice.value)')
    expect(secureMcpSettingsTemplate).toContain('[disabled]="!canManage || (saving && !row.selected)"')
    expect(secureMcpSettingsTemplate).not.toContain('onRevokeOpen(')
    expect(secureMcpSettingsTemplate).not.toContain('row.openSession')
  })

  it('only uses row.displayName for visible row interpolation', () => {
    const interpolations = secureMcpSettingsTemplate.match(/\{\{[^}]+\}\}/g) ?? []
    const rowInterpolations = interpolations.filter(chunk => chunk.includes('row.'))

    expect([...new Set(rowInterpolations)]).toEqual(['{{ row.displayName }}'])
    expect(secureMcpSettingsTemplate).not.toMatch(/\{\{\s*row\.id/)
    expect(secureMcpSettingsTemplate).not.toMatch(/\{\{\s*row\.options/)
    expect(secureMcpSettingsTemplate).not.toMatch(/\{\{[^}]*(host|username|user)[^}]*\}\}/i)
  })
})
