import { Buffer } from 'node:buffer'

import { decodePairingNonce } from './pairing'

export const MAX_DESCRIPTOR_BYTES = 4096

export interface RuntimeDescriptor {
  protocol_version: 1
  endpoint: string
  pid: number
  expires_at: number
  pairing_nonce: string
}

export function parseRuntimeDescriptor(value: unknown): RuntimeDescriptor | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const record = value as Record<string, unknown>
  if (record.protocol_version !== 1) {
    return undefined
  }
  if (typeof record.endpoint !== 'string' || record.endpoint.length === 0) {
    return undefined
  }
  if (Buffer.byteLength(record.endpoint, 'utf8') > 8 * 1024) {
    return undefined
  }
  if (!Number.isInteger(record.pid) || (record.pid as number) <= 0) {
    return undefined
  }
  if (!Number.isInteger(record.expires_at) || (record.expires_at as number) <= 0) {
    return undefined
  }
  if (typeof record.pairing_nonce !== 'string' || decodePairingNonce(record.pairing_nonce) === undefined) {
    return undefined
  }
  return {
    protocol_version: 1,
    endpoint: record.endpoint,
    pid: record.pid as number,
    expires_at: record.expires_at as number,
    pairing_nonce: record.pairing_nonce,
  }
}
