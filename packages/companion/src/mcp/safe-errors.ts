import type { CallToolResult } from '@modelcontextprotocol/server'
import type { ErrorCode } from '@tabby-secure-mcp/ipc-contract'

const SAFE_ERROR_TEXT: Record<ErrorCode, string> = {
  target_unavailable: 'The requested SSH profile is not available.',
  not_approved: 'The operation was not approved in Tabby.',
  command_disabled: 'SSH command execution is disabled for this profile. Enable an approval mode in Tabby.',
  unsupported_command: 'Only one command without shell operators or terminal controls is supported.',
  approval_unavailable: 'The approval could not be saved or validated. The command was not executed; review Tabby settings and retry.',
  expired: 'The operation timed out before it could finish.',
  cancelled: 'The operation was cancelled.',
  busy: 'Too many operations are already in progress.',
  rate_limited: 'Too many operations were requested in a short period.',
  plugin_unavailable: 'The Tabby MCP service is unavailable or this client is not approved.',
  internal: 'The Tabby MCP service could not complete the operation.',
  audit_unavailable: 'Audit persistence is unavailable. The operation was not executed.',
  outcome_unknown: 'The operation may have taken effect. Inspect the relevant SSH tab and file state before retrying; do not retry automatically.',
  file_transfer_disabled: 'File transfer is disabled for this client and SSH profile. Enable it in Tabby.',
  file_transfer_failed: 'The file transfer failed. Check Tabby before retrying.',
  file_exists: 'The destination file already exists. Overwriting is not allowed.',
  file_too_large: 'The file exceeds the 64 MiB transfer limit.',
  invalid_path: 'Use absolute paths to single files on the Tabby machine and SSH host.',
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
