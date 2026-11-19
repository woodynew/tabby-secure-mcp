import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import type { ErrorCode, OperationalRequest } from '@tabby-secure-mcp/ipc-contract'
import { fileTransferParamsSchema, fileTransferRpcResultSchema } from '@tabby-secure-mcp/ipc-contract'
import { safeErrorText, toMcpToolError, toMcpToolSuccess } from './safe-errors.js'

function readDeadlineMs(): number {
  const fromEnv = Number(process.env.TABBY_SECURE_MCP_RPC_DEADLINE_MS)
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 30_000
}

export interface McpDispatcher {
  call(request: OperationalRequest, options?: { signal?: AbortSignal; deadlineMs?: number }): Promise<
    { ok: true; result: Record<string, unknown> } | { ok: false; code: ErrorCode }
  >
}

export function createMcpServer(gateway: McpDispatcher): McpServer {
  const server = new McpServer(
    { name: 'tabby-secure-mcp', version: '0.1.1' },
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
      description: 'Always create a new SSH tab for an authorized profile in Tabby. Keep and reuse the returned tab_ref with run_authorized_ssh_command while tab_reusable is true; each command still requires current approval. Close your own MCP-created tab with close_mcp_ssh_tab when finished. Refs are valid only in the current runtime; do not use manual tabs or other clients\' tabs. Closing may interrupt remote processes. tab_reusable:false may also mean manual takeover; do not auto-close a manually taken-over tab. Explicit close remains available when requested.',
      inputSchema: z.strictObject({
        profile_ref: z.string().min(1).max(256),
      }),
      outputSchema: z.object({
        status: z.literal('opened'),
        tab_ref: z.string().min(1).max(256).optional(),
        tab_reusable: z.boolean().optional(),
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
    'close_mcp_ssh_tab',
    {
      description: 'Close your own MCP-created SSH tab using a tab_ref returned by open_authorized_ssh_profile or run_authorized_ssh_command. Refs are valid only in the current runtime; manual tabs and other clients\' tabs cannot be closed. Closing may interrupt remote processes. tab_reusable:false may also mean manual takeover; do not auto-close a manually taken-over tab. Explicit close remains available when requested.',
      inputSchema: z.strictObject({
        tab_ref: z.string().min(1).max(256),
      }),
      outputSchema: z.strictObject({
        status: z.literal('closed'),
      }),
    },
    async ({ tab_ref }, ctx) => {
      const result = await gateway.call(
        { method: 'close_mcp_ssh_tab', params: { tab_ref } },
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
        'Read the SSH command approval mode: ask, auto_edit, full, or none (disabled). Command sets are managed only in Tabby. This does not execute a command or change permission.',
      inputSchema: z.strictObject({
        profile_ref: z.string().min(1).max(256),
      }),
      outputSchema: z.object({
        profile_ref: z.string(),
        open_session: z.boolean(),
        approval_mode: z.enum(['none', 'ask', 'auto_edit', 'full']),
        authorizes: z.literal('ssh_command'),
        policy: z.array(
          z.object({
            mode: z.enum(['ask', 'auto_edit', 'full']),
            label: z.string(),
            auto_approve: z.enum(['none', 'low_risk', 'all']),
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

  server.registerTool(
    'run_authorized_ssh_command',
    {
      description:
        'Run one SSH command. Every command still passes current connection and command approval policy: ask uses approved command sets, auto_edit asks for high-risk or unknown commands, and full skips command approval. Shell operators are rejected; allow time for a Tabby approval prompt. By default, reuse this client\'s idle owned tab for the same profile. Keep and pass the returned tab_ref for subsequent commands while tab_reusable is true. An explicit ref must match the owner, profile and current configuration and be healthy; failure never silently opens another tab. Set new_tab:true to always create a new tab; do not combine it with tab_ref (new_tab:false is allowed). Never reuse a tab after an unknown execution outcome or a truncated/running command; close it first. Close your own tabs with close_mcp_ssh_tab when finished; auto-closed tabs have no tab_ref. Refs are valid only in the current runtime; never use manual tabs or other clients\' tabs. Closing may interrupt remote processes. tab_reusable:false may also mean manual takeover; do not auto-close a manually taken-over tab. Explicit close remains available when requested.',
      inputSchema: z.strictObject({
        profile_ref: z.string().min(1).max(256),
        command: z.string().min(1).max(512).refine(value => Buffer.byteLength(value, 'utf8') <= 512),
        tab_ref: z.string().min(1).max(256).optional(),
        new_tab: z.boolean().optional(),
      }).refine(params => !(params.tab_ref !== undefined && params.new_tab === true), {
        message: 'tab_ref cannot be combined with new_tab: true.',
        path: ['new_tab'],
      }),
      outputSchema: z.object({
        status: z.enum(['completed', 'truncated']),
        command_risk: z.enum(['low', 'high', 'unknown']),
        output: z.string(),
        truncated: z.boolean(),
        tab_ref: z.string().min(1).max(256).optional(),
        tab_reusable: z.boolean().optional(),
        reused_tab: z.boolean().optional(),
      }),
    },
    async (params, ctx) => {
      const result = await gateway.call(
        { method: 'run_authorized_ssh_command', params },
        { signal: ctx.mcpReq.signal, deadlineMs: Math.max(readDeadlineMs(), 105_000) },
      )
      if (!result.ok) {
        return toMcpToolError(result.code)
      }
      return toMcpToolSuccess(result.result)
    },
  )

  for (const [method, status] of [['upload_ssh_file', 'uploaded'], ['download_ssh_file', 'downloaded']] as const) {
    server.registerTool(
      method,
      {
        description: (method === 'upload_ssh_file' ? 'Upload one file from the Tabby machine to the SSH host.' : 'Download one file from the SSH host to the Tabby machine.') + ' local_path refers to the machine running Tabby, not the AI client. Use absolute local_path and remote_path for single files, at most 64 MiB. Destinations must not exist: no overwrite, directory transfer or directory creation. File transfer permission is disabled by default and must be enabled in Tabby for this client and SSH profile.',
        inputSchema: fileTransferParamsSchema,
        outputSchema: fileTransferRpcResultSchema.extend({ status: z.literal(status) }),
      },
      async (params, ctx) => {
        const result = await gateway.call(
          { method, params },
          { signal: ctx.mcpReq.signal, deadlineMs: Math.max(readDeadlineMs(), 180_000) },
        )
        if (!result.ok) return toMcpToolError(result.code)
        return toMcpToolSuccess(result.result)
      },
    )
  }

  return server
}

export { safeErrorText }
