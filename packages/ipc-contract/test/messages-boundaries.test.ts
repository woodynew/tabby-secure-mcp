import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  MAX_IDENTIFIER_CODE_UNITS,
  MAX_JSON_DEPTH,
  MAX_STRING_BYTES,
  ipcMessageSchema,
  operationalRequestSchema,
  rpcResultSchema,
  secureSchema,
} from '../src/index.js'

const secureDepthSchema = secureSchema(z.object({ nested: z.unknown() }))

const base = { v: 1 as const, seq: 1 }

function rpcSuccess(result: unknown) {
  return {
    ...base,
    type: 'rpc_result' as const,
    request_id: 'request-1',
    lease_epoch: 1,
    ok: true as const,
    result,
  }
}

function rpcFailure(code: string) {
  return {
    ...base,
    type: 'rpc_result' as const,
    request_id: 'request-1',
    lease_epoch: 1,
    ok: false as const,
    error: { code },
  }
}

describe('IPC message validation boundaries', () => {
  it.each(['upload_ssh_file', 'download_ssh_file'])('validates strict bounded file paths for %s', method => {
    const params = { profile_ref: 'profile-1', local_path: '/tmp/local file', remote_path: '/tmp/remote file' }
    const request = { method, params }
    expect(operationalRequestSchema.parse(request)).toEqual(request)
    for (const field of ['local_path', 'remote_path']) {
      expect(operationalRequestSchema.safeParse({ method, params: { ...params, [field]: 'a'.repeat(4096) } }).success).toBe(true)
      for (const value of ['', 'a'.repeat(4097), null, 1, {}, [], 'a\0b', 'a\nb', 'a\rb', 'a\tb', 'a\u001bb', 'a\u007fb', 'a\u0085b', 'a\u2028b', 'a\u2029b']) {
        expect(operationalRequestSchema.safeParse({ method, params: { ...params, [field]: value } }).success, JSON.stringify(value)).toBe(false)
      }
    }
    for (const change of [{ extra: true }, { overwrite: true }, { mkdir: true }, { recursive: true }, { profile_ref: '' }, { profile_ref: 'x'.repeat(257) }]) {
      expect(operationalRequestSchema.safeParse({ method, params: { ...params, ...change } }).success).toBe(false)
    }
    expect(operationalRequestSchema.safeParse({ ...request, extra: true }).success).toBe(false)
    expect(operationalRequestSchema.safeParse({ method, params: { profile_ref: 'profile-1' } }).success).toBe(false)
  })

  it.each(['uploaded', 'downloaded'])('validates strict %s results and optional tab metadata', status => {
    for (const bytes_transferred of [0, 64 * 1024 * 1024]) {
      expect(rpcResultSchema.safeParse(rpcSuccess({ status, bytes_transferred })).success).toBe(true)
      expect(rpcResultSchema.safeParse(rpcSuccess({ status, bytes_transferred, tab_ref: 'tab-1', tab_reusable: false })).success).toBe(true)
    }
    for (const invalid of [
      { bytes_transferred: -1 }, { bytes_transferred: 0.5 }, { bytes_transferred: '1' }, { bytes_transferred: null },
      { extra: true }, { tab_ref: '' }, { tab_ref: 't'.repeat(257) }, { tab_reusable: 'true' },
    ]) expect(rpcResultSchema.safeParse(rpcSuccess({ status, bytes_transferred: 1, ...invalid })).success).toBe(false)
    expect(rpcResultSchema.safeParse(rpcSuccess({ status })).success).toBe(false)
  })

  it.each(['file_transfer_disabled', 'file_transfer_failed', 'file_exists', 'file_too_large', 'invalid_path'])('accepts stable file transfer error %s', code => {
    expect(rpcResultSchema.safeParse(rpcFailure(code)).success).toBe(true)
  })

  it('preserves strict command params while accepting compatible tab selection options', () => {
    const request = { method: 'run_authorized_ssh_command', params: { profile_ref: 'profile-1', command: 'pwd' } }
    for (const options of [{}, { tab_ref: 't' }, { tab_ref: 't'.repeat(256) }, { new_tab: true }, { new_tab: false }, { tab_ref: 'tab-1', new_tab: false }]) {
      const value = { ...request, params: { ...request.params, ...options } }
      expect(operationalRequestSchema.parse(value)).toEqual(value)
      expect(ipcMessageSchema.safeParse({ ...base, type: 'rpc_request', request_id: 'request-1', lease_epoch: 1, request: value }).success).toBe(true)
    }
    for (const options of [
      { tab_ref: 'tab-1', new_tab: true }, { extra: true }, { window_instance_id: 'window-1' },
      ...['', 't'.repeat(257), null, 1, [], {}].map(tab_ref => ({ tab_ref })),
      ...['true', 1, null].map(new_tab => ({ new_tab })),
      { command: '' }, { command: 'x'.repeat(513) },
    ]) {
      expect(operationalRequestSchema.safeParse({ ...request, params: { ...request.params, ...options } }).success, JSON.stringify(options)).toBe(false)
    }
    expect(operationalRequestSchema.safeParse({ ...request, params: { ...request.params, command: 'x'.repeat(512) } }).success).toBe(true)
  })

  it('accepts optional boolean tab reuse metadata without widening result fields', () => {
    const open = { status: 'opened', tab_ref: 'tab-1' }
    const command = { status: 'completed', command_risk: 'low', output: '', truncated: false, tab_ref: 'tab-1' }
    for (const result of [open, command]) {
      expect(rpcResultSchema.safeParse(rpcSuccess(result)).success).toBe(true)
      for (const tab_reusable of [true, false]) {
        expect(rpcResultSchema.safeParse(rpcSuccess({ ...result, tab_reusable })).success).toBe(true)
      }
      for (const tab_reusable of [null, 1, 'true']) {
        expect(rpcResultSchema.safeParse(rpcSuccess({ ...result, tab_reusable })).success).toBe(false)
      }
      expect(rpcResultSchema.safeParse(rpcSuccess({ ...result, extra: true })).success).toBe(false)
    }
    for (const reused_tab of [true, false]) {
      expect(rpcResultSchema.safeParse(rpcSuccess({ ...command, reused_tab })).success).toBe(true)
    }
    for (const reused_tab of [null, 1, 'true']) {
      expect(rpcResultSchema.safeParse(rpcSuccess({ ...command, reused_tab })).success).toBe(false)
    }
    expect(rpcResultSchema.safeParse(rpcSuccess({ ...open, reused_tab: true })).success).toBe(false)
  })

  it('accepts close requests only with a bounded tab_ref and no profile, window or extra fields', () => {
    const request = { method: 'close_mcp_ssh_tab', params: { tab_ref: 'tab-1' } }
    for (const tab_ref of ['t', 't'.repeat(MAX_IDENTIFIER_CODE_UNITS)]) {
      expect(operationalRequestSchema.safeParse({ ...request, params: { tab_ref } }).success).toBe(true)
    }
    expect(operationalRequestSchema.safeParse({ ...request, extra: true }).success).toBe(false)
    for (const params of [
      {}, { profile_ref: 'profile-1' }, { profile_id: 'profile-1' }, { window_instance_id: 'window-1' },
      { tab_ref: 'tab-1', extra: true }, { tab_ref: 'tab-1', profile_ref: 'profile-1' },
      { tab_ref: 'tab-1', window_instance_id: 'window-1' },
      ...['', 't'.repeat(MAX_IDENTIFIER_CODE_UNITS + 1), null, 1, [], {}].map(tab_ref => ({ tab_ref })),
    ]) {
      expect(operationalRequestSchema.safeParse({ ...request, params }).success, JSON.stringify(params)).toBe(false)
    }
    expect(ipcMessageSchema.safeParse({ ...base, type: 'rpc_request', request_id: 'request-1', lease_epoch: 1, request }).success).toBe(true)
  })

  it('accepts only a closed status for close results', () => {
    expect(rpcResultSchema.safeParse(rpcSuccess({ status: 'closed' })).success).toBe(true)
    for (const result of [{ status: 'closing' }, { status: 'closed', tab_ref: 'tab-1' }, { status: 'closed', extra: true }]) {
      expect(rpcResultSchema.safeParse(rpcSuccess(result)).success).toBe(false)
    }
  })

  it('allows bounded tab refs on open and command results while preserving results without refs', () => {
    for (const result of [
      { status: 'opened' },
      { status: 'completed', command_risk: 'low', output: 'file\n', truncated: false },
      { status: 'truncated', command_risk: 'low', output: 'file\n', truncated: true },
    ]) {
      expect(rpcResultSchema.safeParse(rpcSuccess(result)).success).toBe(true)
      for (const tab_ref of ['t', 't'.repeat(MAX_IDENTIFIER_CODE_UNITS)]) {
        expect(rpcResultSchema.safeParse(rpcSuccess({ ...result, tab_ref })).success).toBe(true)
      }
      for (const tab_ref of ['', 't'.repeat(MAX_IDENTIFIER_CODE_UNITS + 1), null, 1, [], {}]) {
        expect(rpcResultSchema.safeParse(rpcSuccess({ ...result, tab_ref })).success).toBe(false)
      }
    }
  })

  it('accepts JSON nested exactly at MAX_JSON_DEPTH and rejects one deeper level', () => {
    let atLimit: unknown = 'leaf'
    for (let index = 0; index < MAX_JSON_DEPTH - 2; index += 1) {
      atLimit = { nested: atLimit }
    }
    expect(secureDepthSchema.safeParse({ nested: atLimit }).success).toBe(true)

    let tooDeep: unknown = 'leaf'
    for (let index = 0; index < MAX_JSON_DEPTH - 1; index += 1) {
      tooDeep = { nested: tooDeep }
    }
    expect(secureDepthSchema.safeParse({ nested: tooDeep }).success).toBe(false)
  })

  it('accepts strings at the UTF-8 byte limit and rejects one byte over', () => {
    const atLimit = 'a'.repeat(MAX_STRING_BYTES)
    expect(
      ipcMessageSchema.safeParse({
        ...base,
        type: 'pairing_decision',
        window_instance_id: 'window-1',
        approved: true,
        response: atLimit,
      }).success,
    ).toBe(true)

    const overLimit = 'a'.repeat(MAX_STRING_BYTES + 1)
    expect(
      ipcMessageSchema.safeParse({
        ...base,
        type: 'pairing_decision',
        window_instance_id: 'window-1',
        approved: true,
        response: overLimit,
      }).success,
    ).toBe(false)
  })

  it('enforces identifier code-unit max independently of the global UTF-8 byte cap', () => {
    const atCodeUnits = 'a'.repeat(MAX_IDENTIFIER_CODE_UNITS)
    expect(
      operationalRequestSchema.safeParse({
        method: 'open_authorized_ssh_profile',
        params: { profile_ref: atCodeUnits },
      }).success,
    ).toBe(true)

    expect(
      operationalRequestSchema.safeParse({
        method: 'open_authorized_ssh_profile',
        params: { profile_ref: 'a'.repeat(MAX_IDENTIFIER_CODE_UNITS + 1) },
      }).success,
    ).toBe(false)

    const wideCharAtByteLimit = '€'.repeat(Math.floor(MAX_STRING_BYTES / 3))
    expect(Buffer.byteLength(wideCharAtByteLimit, 'utf8')).toBeLessThanOrEqual(MAX_STRING_BYTES)
    expect(wideCharAtByteLimit.length).toBeGreaterThan(MAX_IDENTIFIER_CODE_UNITS)
    expect(
      operationalRequestSchema.safeParse({
        method: 'open_authorized_ssh_profile',
        params: { profile_ref: wideCharAtByteLimit },
      }).success,
    ).toBe(false)
  })

  it('rejects dangerous keys inside operational params', () => {
    for (const key of ['__proto__', 'prototype', 'constructor']) {
      const params = JSON.parse(`{"${key}":"x","profile_ref":"p"}`) as Record<string, string>
      expect(
        operationalRequestSchema.safeParse({
          method: 'open_authorized_ssh_profile',
          params,
        }).success,
        key,
      ).toBe(false)
    }
  })

  it('accepts both rpc success result shapes and rejects unknown result fields', () => {
    expect(
      rpcResultSchema.safeParse(
        rpcSuccess({
          profiles: [{ profile_ref: 'ref-1', display_name: 'Primary' }],
        }),
      ).success,
    ).toBe(true)
    expect(rpcResultSchema.safeParse(rpcSuccess({ status: 'opened' })).success).toBe(true)
    expect(
      rpcResultSchema.safeParse(
        rpcSuccess({
          profile_ref: 'ref-1',
          open_session: true,
          approval_mode: 'auto_edit',
          authorizes: 'ssh_command',
          policy: [
            { mode: 'ask', label: '请求审批', auto_approve: 'none' },
            { mode: 'auto_edit', label: '自动编辑', auto_approve: 'low_risk' },
            { mode: 'full', label: '完全访问', auto_approve: 'all' },
          ],
        }),
      ).success,
    ).toBe(true)
    expect(
      rpcResultSchema.safeParse(
        rpcSuccess({
          profile_ref: 'ref-1',
          open_session: true,
          approval_mode: 'full',
          authorizes: 'ssh_command',
          policy: [{ mode: 'full', label: '完全访问', auto_approve: 'all', shell: true }],
        }),
      ).success,
    ).toBe(false)

    expect(
      rpcResultSchema.safeParse(
        rpcSuccess({
          status: 'completed',
          command_risk: 'low',
          output: 'file\n',
          truncated: false,
        }),
      ).success,
    ).toBe(true)
    expect(
      rpcResultSchema.safeParse(
        rpcSuccess({
          status: 'completed',
          command_risk: 'low',
          output: 'file\n',
          truncated: false,
          command: 'ls',
        }),
      ).success,
    ).toBe(false)

    expect(
      rpcResultSchema.safeParse(
        rpcSuccess({
          profiles: [{ profile_ref: 'ref-1', display_name: 'Primary', extra: true }],
        }),
      ).success,
    ).toBe(false)
    expect(rpcResultSchema.safeParse(rpcSuccess({ status: 'opened', extra: true })).success).toBe(
      false,
    )
    expect(rpcResultSchema.safeParse(rpcSuccess({ profiles: [] })).success).toBe(true)
    expect(rpcResultSchema.safeParse(rpcSuccess({ unexpected: true })).success).toBe(false)
  })

  it('accepts rpc failure results with stable error codes', () => {
    expect(rpcResultSchema.safeParse(rpcFailure('busy')).success).toBe(true)
    expect(rpcResultSchema.safeParse(rpcFailure('not_a_code')).success).toBe(false)
  })

  it('rejects dangerous keys nested inside rpc success results', () => {
    const polluted = JSON.parse(
      '{"profiles":[{"profile_ref":"r","display_name":"n","__proto__":{"x":1}}]}',
    ) as unknown
    expect(ipcMessageSchema.safeParse(rpcSuccess(polluted)).success).toBe(false)
  })
})
