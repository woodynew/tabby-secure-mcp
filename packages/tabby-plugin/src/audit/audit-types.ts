import { createHash } from 'node:crypto'

import type { ErrorCode } from '../runtime/ipc-contract-api'

export const AUDIT_LOG_VERSION = 1
export const AUDIT_GENESIS_HASH =
  '0000000000000000000000000000000000000000000000000000000000000000'

/**
 * Hash chaining detects tampering within a file but cannot detect whole-file
 * replacement or tail deletion by a user with filesystem access.
 */
export const AUDIT_CHAIN_LIMITATION =
  'Audit hash chaining cannot detect whole-file replacement or tail deletion.'

export type AuditEventType =
  | 'runtime_start'
  | 'runtime_stop'
  | 'runtime_connect'
  | 'pairing_decision'
  | 'lease_granted'
  | 'lease_lost'
  | 'list_result'
  | 'open_requested'
  | 'open_result'
  | 'cancel'

export type AuditResult = 'ok' | 'error'

export interface AuditEventInput {
  event: AuditEventType
  result: AuditResult
  errorCode?: ErrorCode | 'descriptor_invalid' | 'internal'
  requestId?: string
  authorizedCount?: number
}

export interface StoredAuditEvent {
  version: typeof AUDIT_LOG_VERSION
  sequence: number
  timestamp_utc: string
  event: AuditEventType
  result: AuditResult
  error_code?: string
  request_id?: string
  authorized_count?: number
  previous_hash: string
  hash: string
}

export function canonicalAuditPayload(
  input: AuditEventInput & {
    version: number
    sequence: number
    timestampUtc: string
    previousHash: string
  },
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    version: input.version,
    sequence: input.sequence,
    timestamp_utc: input.timestampUtc,
    event: input.event,
    result: input.result,
    previous_hash: input.previousHash,
  }
  if (input.errorCode !== undefined) {
    payload.error_code = input.errorCode
  }
  if (input.requestId !== undefined) {
    payload.request_id = input.requestId
  }
  if (input.authorizedCount !== undefined) {
    payload.authorized_count = input.authorizedCount
  }
  return payload
}

export function hashAuditEvent(
  payload: Record<string, unknown>,
  previousHash: string,
): { previous_hash: string; hash: string } {
  const body = { ...payload, previous_hash: previousHash }
  const canonical = JSON.stringify(body)
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex')
  return { previous_hash: previousHash, hash }
}
