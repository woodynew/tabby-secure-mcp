import { describe, expect, it } from 'vitest'

import { safeErrorText, toMcpToolError } from '../src/mcp/safe-errors.js'

describe('safe MCP-visible errors', () => {
  it('maps every IPC error code to stable user-facing text', () => {
    expect(safeErrorText('plugin_unavailable')).toBe(
      'Tabby is not connected or paired with this companion.',
    )
    expect(safeErrorText('not_approved')).toBe('The operation was not approved in Tabby.')
    expect(safeErrorText('expired')).toBe('The operation timed out before it could finish.')
    expect(safeErrorText('cancelled')).toBe('The operation was cancelled.')
    expect(safeErrorText('busy')).toBe('Too many operations are already in progress.')
    expect(safeErrorText('rate_limited')).toBe('Too many operations were requested in a short period.')
    expect(safeErrorText('target_unavailable')).toBe('The requested SSH profile is not available.')
    expect(safeErrorText('internal')).toBe('The companion could not complete the operation.')
  })

  it('never leaks raw error details into MCP tool results', () => {
    const result = toMcpToolError('internal', new Error('/secret/path ECONNREFUSED'))
    expect(result.isError).toBe(true)
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'The companion could not complete the operation.',
    })
    expect(JSON.stringify(result)).not.toMatch(/secret|ECONNREFUSED/i)
  })
})
