import type { CallToolResult } from '@modelcontextprotocol/server'
import type { ErrorCode } from '@tabby-secure-mcp/ipc-contract'

const SAFE_ERROR_TEXT: Record<ErrorCode, string> = {
  target_unavailable: 'The requested SSH profile is not available.',
  not_approved: 'The operation was not approved in Tabby.',
  expired: 'The operation timed out before it could finish.',
  cancelled: 'The operation was cancelled.',
  busy: 'Too many operations are already in progress.',
  rate_limited: 'Too many operations were requested in a short period.',
  plugin_unavailable: 'Tabby is not connected or paired with this companion.',
  internal: 'The companion could not complete the operation.',
}

export function safeErrorText(code: ErrorCode): string {
  return SAFE_ERROR_TEXT[code]
}

export function toMcpToolError(code: ErrorCode, _cause?: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: safeErrorText(code) }],
  }
}

export function toMcpToolSuccess(structuredContent: Record<string, unknown>): CallToolResult {
  const text = JSON.stringify(structuredContent)
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  }
}
