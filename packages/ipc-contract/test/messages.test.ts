import { describe, expect, it } from 'vitest'

import {
  MAX_JSON_DEPTH,
  MAX_STRING_BYTES,
  errorCodeSchema,
  ipcMessageSchema,
  operationalRequestSchema,
} from '../src/index.js'

const base = { v: 1 as const, seq: 1 }

describe('version 1 IPC schemas', () => {
  it('accepts every supported message and only the two operational requests', () => {
    const messages = [
      {
        ...base,
        type: 'plugin_hello',
        window_instance_id: 'window-1',
        is_main_window: true,
        plugin_challenge: 'plugin-challenge',
      },
      { ...base, type: 'companion_challenge', companion_challenge: 'companion-challenge' },
      {
        ...base,
        type: 'pairing_decision',
        window_instance_id: 'window-1',
        approved: true,
        response: 'response',
      },
      { ...base, type: 'lease_granted', lease_epoch: 1 },
      { ...base, type: 'lease_revoked', lease_epoch: 2, reason: 'cancelled' },
      {
        ...base,
        type: 'window_state',
        window_instance_id: 'window-1',
        is_main_window: false,
      },
      {
        ...base,
        type: 'rpc_request',
        request_id: 'request-1',
        lease_epoch: 1,
        request: { method: 'list_authorized_ssh_profiles', params: {} },
      },
      {
        ...base,
        type: 'rpc_result',
        request_id: 'request-1',
        lease_epoch: 1,
        ok: true,
        result: { profiles: [] },
      },
      {
        ...base,
        type: 'rpc_cancelled',
        request_id: 'request-1',
        lease_epoch: 1,
        reason: 'cancelled',
      },
      {
        ...base,
        type: 'cancel_request',
        request_id: 'request-1',
        lease_epoch: 1,
      },
    ]

    for (const message of messages) {
      expect(ipcMessageSchema.safeParse(message).success, message.type).toBe(true)
    }

    expect(
      operationalRequestSchema.safeParse({
        method: 'open_authorized_ssh_profile',
        params: { profile_ref: 'profile-1' },
      }).success,
    ).toBe(true)
    expect(
      operationalRequestSchema.safeParse({ method: 'run_command', params: {} }).success,
    ).toBe(false)
  })

  it('requires v1, a positive integer sequence and no unknown fields', () => {
    const message = {
      ...base,
      type: 'companion_challenge',
      companion_challenge: 'challenge',
    }

    expect(ipcMessageSchema.safeParse({ ...message, v: 2 }).success).toBe(false)
    expect(ipcMessageSchema.safeParse({ ...message, seq: 0 }).success).toBe(false)
    expect(ipcMessageSchema.safeParse({ ...message, seq: 1.5 }).success).toBe(false)
    expect(ipcMessageSchema.safeParse({ ...message, extra: true }).success).toBe(false)
  })

  it('enforces profile references and all stable error codes', () => {
    expect(
      operationalRequestSchema.safeParse({
        method: 'open_authorized_ssh_profile',
        params: { profile_ref: 'a'.repeat(257) },
      }).success,
    ).toBe(false)

    for (const code of [
      'target_unavailable',
      'not_approved',
      'expired',
      'cancelled',
      'busy',
      'rate_limited',
      'plugin_unavailable',
      'internal',
    ]) {
      expect(errorCodeSchema.safeParse(code).success, code).toBe(true)
    }
    expect(errorCodeSchema.safeParse('unknown').success).toBe(false)
  })

  it('rejects dangerous keys anywhere in an arbitrary result', () => {
    for (const key of ['__proto__', 'prototype', 'constructor']) {
      const result = JSON.parse(`{"${key}":{"polluted":true}}`) as unknown
      expect(
        ipcMessageSchema.safeParse({
          ...base,
          type: 'rpc_result',
          request_id: 'request-1',
          lease_epoch: 1,
          ok: true,
          result,
        }).success,
        key,
      ).toBe(false)
    }
  })

  it('rejects strings over 8 KiB by UTF-8 bytes and structures over depth 16', () => {
    const oversized = '€'.repeat(Math.ceil(MAX_STRING_BYTES / 3) + 1)
    expect(
      ipcMessageSchema.safeParse({
        ...base,
        type: 'rpc_result',
        request_id: 'request-1',
        lease_epoch: 1,
        ok: true,
        result: oversized,
      }).success,
    ).toBe(false)

    let nested: unknown = 'leaf'
    for (let index = 0; index < MAX_JSON_DEPTH; index += 1) {
      nested = { nested }
    }
    expect(
      ipcMessageSchema.safeParse({
        ...base,
        type: 'rpc_result',
        request_id: 'request-1',
        lease_epoch: 1,
        ok: true,
        result: nested,
      }).success,
    ).toBe(false)
  })
})
