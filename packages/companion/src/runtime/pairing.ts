import { createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto'

export interface PairingTranscript {
  endpoint: string
  pid: number
  protocolVersion: number
  companionChallenge: string
  pluginChallenge: string
  windowInstanceId: string
}

const PAIRING_TRANSCRIPT_LABEL = 'tabby-secure-mcp-pairing-v1'

export function createPairingNonce(
  randomBytes: (size: number) => Uint8Array = nodeRandomBytes,
): string {
  return Buffer.from(randomBytes(32)).toString('base64url')
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

function pairingKey(nonce: string): Buffer {
  return Buffer.from(nonce, 'base64url')
}

export function createPairingResponse(nonce: string, transcript: PairingTranscript): string {
  return createHmac('sha256', pairingKey(nonce))
    .update(canonicalPairingTranscript(transcript), 'utf8')
    .digest('hex')
}

export function verifyPairingResponse(
  nonce: string,
  transcript: PairingTranscript,
  response: string,
): boolean {
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
