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
  | 'open_authorized'
  | 'command_requested'
  | 'command_authorized'
  | 'open_result'
  | 'command_result'
  | 'tab_close_requested'
  | 'tab_close_result'
  | 'file_transfer_requested'
  | 'file_transfer_result'
  | 'cancel'

export type AuditResult = 'ok' | 'error'

export interface AuditEventInput {
  event: AuditEventType
  result: AuditResult
  errorCode?: ErrorCode | 'descriptor_invalid' | 'internal'
  requestId?: string
  authorizedCount?: number
  approvalMode?: 'ask' | 'auto_edit' | 'full'
  commandRisk?: 'low' | 'high' | 'unknown'
  commandRuleId?: string
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
  approval_mode?: 'ask' | 'auto_edit' | 'full'
  command_risk?: 'low' | 'high' | 'unknown'
  command_rule_id?: string
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
  if (input.approvalMode !== undefined) payload.approval_mode = input.approvalMode
  if (input.commandRisk !== undefined) payload.command_risk = input.commandRisk
  if (input.commandRuleId !== undefined) payload.command_rule_id = input.commandRuleId
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
