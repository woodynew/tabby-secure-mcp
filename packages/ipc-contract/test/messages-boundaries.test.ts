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
          operation_tier: 'readonly',
          authorizes: 'ssh_command',
          policy: [
            { tier: 'readonly', rank: 1, label: '低级 · 只读', subject: 'ssh_command', effect: 'read_only' },
            { tier: 'readwrite', rank: 2, label: '中级 · 读写', subject: 'ssh_command', effect: 'read_write' },
            { tier: 'full', rank: 3, label: '高级 · 完全控制', subject: 'ssh_command', effect: 'full_control' },
          ],
        }),
      ).success,
    ).toBe(true)
    expect(
      rpcResultSchema.safeParse(
        rpcSuccess({
          profile_ref: 'ref-1',
          open_session: true,
          operation_tier: 'full',
          authorizes: 'ssh_command',
          policy: [{ tier: 'full', rank: 3, label: '高级 · 完全控制', subject: 'ssh_command', effect: 'full_control', shell: true }],
        }),
      ).success,
    ).toBe(false)

    expect(
      rpcResultSchema.safeParse(
        rpcSuccess({
          status: 'completed',
          command_class: 'read_only',
          output: 'file\n',
          truncated: false,
        }),
      ).success,
    ).toBe(true)
    expect(
      rpcResultSchema.safeParse(
        rpcSuccess({
          status: 'completed',
          command_class: 'read_only',
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
