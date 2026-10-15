import { Buffer } from 'node:buffer'
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface PairingTranscript {
  endpoint: string
  pid: number
  protocolVersion: number
  companionChallenge: string
  pluginChallenge: string
  windowInstanceId: string
}

const PAIRING_TRANSCRIPT_LABEL = 'tabby-secure-mcp-pairing-v1'
export const PAIRING_NONCE_BYTES = 32

export function decodePairingNonce(nonce: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(nonce)) {
    return undefined
  }
  const bytes = Buffer.from(nonce, 'base64url')
  return bytes.length === PAIRING_NONCE_BYTES ? bytes : undefined
}

export function canonicalPairingTranscript(transcript: PairingTranscript): string {
  return JSON.stringify([
    PAIRING_TRANSCRIPT_LABEL,
    transcript.endpoint,
    transcript.pid,
    transcript.protocolVersion,
    transcript.companionChallenge,
    transcript.pluginChallenge,
    transcript.windowInstanceId,
  ])
}

export function createPairingResponse(nonce: string, transcript: PairingTranscript): string {
  const key = decodePairingNonce(nonce)
  if (!key) {
    throw new Error('pairing nonce must be base64url encoding of exactly 32 bytes')
  }
  return createHmac('sha256', key)
    .update(canonicalPairingTranscript(transcript), 'utf8')
    .digest('hex')
}

export function verifyPairingResponse(
  nonce: string,
  transcript: PairingTranscript,
  response: string,
): boolean {
  if (decodePairingNonce(nonce) === undefined) {
    return false
  }
  if (!/^[a-f0-9]{64}$/.test(response)) {
    return false
  }
  const expected = createPairingResponse(nonce, transcript)
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(response, 'hex'))
  } catch {
    return false
  }
}
