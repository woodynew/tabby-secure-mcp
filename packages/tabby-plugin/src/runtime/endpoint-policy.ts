import path from 'node:path'

const WIN_PIPE_PATTERN = /^\\\\\.\\pipe\\tabby-secure-mcp-[0-9a-f]+$/i

export function isAllowedIpcEndpoint(endpoint: string, platform: NodeJS.Platform): boolean {
  if (endpoint.includes('://')) {
    return false
  }
  if (platform === 'win32') {
    return WIN_PIPE_PATTERN.test(endpoint)
  }
  return path.posix.isAbsolute(endpoint) || path.isAbsolute(endpoint)
}
