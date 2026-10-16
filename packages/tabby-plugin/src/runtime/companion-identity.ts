import { sanitizeApprovalDisplayText } from '../approval/display-sanitizer'
import type { RuntimeDescriptor } from './descriptor'

export function formatCompanionClientIdentity(descriptor: RuntimeDescriptor): string {
  const pid = Math.trunc(descriptor.pid)
  return sanitizeApprovalDisplayText(`tabby-secure-mcp-companion (pid ${pid})`)
}

export const COMPANION_PAIRING_LABEL = 'Local Tabby Secure MCP companion'
