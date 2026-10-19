import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import type { PluginGateway } from '../gateway/plugin-gateway.js'
import { DEFAULT_RPC_DEADLINE_MS } from '../gateway/plugin-gateway.js'
import { safeErrorText, toMcpToolError, toMcpToolSuccess } from './safe-errors.js'

function readDeadlineMs(): number {
  const fromEnv = Number(process.env.TABBY_SECURE_MCP_RPC_DEADLINE_MS)
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_RPC_DEADLINE_MS
}

export function createMcpServer(gateway: PluginGateway): McpServer {
  const server = new McpServer(
    { name: 'tabby-secure-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.registerTool(
    'list_authorized_ssh_profiles',
    {
      description: 'List SSH profiles authorized for MCP access in Tabby.',
      inputSchema: z.strictObject({}),
      outputSchema: z.object({
        profiles: z.array(
          z.object({
            profile_ref: z.string(),
            display_name: z.string(),
          }),
        ),
      }),
    },
    async (_args, ctx) => {
      const result = await gateway.call(
        { method: 'list_authorized_ssh_profiles', params: {} },
        { signal: ctx.mcpReq.signal, deadlineMs: readDeadlineMs() },
      )
      if (!result.ok) {
        return toMcpToolError(result.code)
      }
      return toMcpToolSuccess(result.result)
    },
  )

  server.registerTool(
    'open_authorized_ssh_profile',
    {
      description: 'Open an authorized SSH profile in Tabby.',
      inputSchema: z.strictObject({
        profile_ref: z.string().min(1).max(256),
      }),
      outputSchema: z.object({
        status: z.literal('opened'),
      }),
    },
    async ({ profile_ref }, ctx) => {
      const result = await gateway.call(
        { method: 'open_authorized_ssh_profile', params: { profile_ref } },
        { signal: ctx.mcpReq.signal, deadlineMs: readDeadlineMs() },
      )
      if (!result.ok) {
        return toMcpToolError(result.code)
      }
      return toMcpToolSuccess(result.result)
    },
  )

  server.registerTool(
    'get_ssh_operation_authorization',
    {
      description:
        'Read the permanent SSH operation tier stored in Tabby. This does not execute a command or change the grant.',
      inputSchema: z.strictObject({
        profile_ref: z.string().min(1).max(256),
      }),
      outputSchema: z.object({
        profile_ref: z.string(),
        open_session: z.boolean(),
        operation_tier: z.enum(['none', 'readonly', 'readwrite', 'full']),
        policy: z.array(
          z.object({
            tier: z.enum(['readonly', 'readwrite', 'full']),
            rank: z.number(),
            label: z.string(),
            effect: z.enum(['read_only', 'read_write', 'full_control']),
          }),
        ),
      }),
    },
    async ({ profile_ref }, ctx) => {
      const result = await gateway.call(
        { method: 'get_ssh_operation_authorization', params: { profile_ref } },
        { signal: ctx.mcpReq.signal, deadlineMs: readDeadlineMs() },
      )
      if (!result.ok) {
        return toMcpToolError(result.code)
      }
      return toMcpToolSuccess(result.result)
    },
  )

  return server
}

export { safeErrorText }
