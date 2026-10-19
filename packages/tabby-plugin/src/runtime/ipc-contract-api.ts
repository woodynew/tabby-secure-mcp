import { createRequire } from 'node:module'

import type { Buffer } from 'node:buffer'

const require = createRequire(import.meta.url)
const ipcContract = require('../../../ipc-contract/dist/index.js') as {
  encodeFrame(message: IpcMessage): Buffer
  IpcFrameDecoder: new () => {
    push(chunk: Uint8Array): IpcMessage[]
    close(): void
    reset(): void
    readonly closed: boolean
  }
}

export type ErrorCode =
  | 'target_unavailable'
  | 'not_approved'
  | 'expired'
  | 'cancelled'
  | 'busy'
  | 'rate_limited'
  | 'plugin_unavailable'
  | 'internal'

export type OperationalRequest =
  | { method: 'list_authorized_ssh_profiles'; params: Record<string, never> }
  | { method: 'open_authorized_ssh_profile'; params: { profile_ref: string } }
  | { method: 'get_ssh_operation_authorization'; params: { profile_ref: string } }

export type IpcMessage =
  | {
      v: 1
      seq: number
      type: 'plugin_hello'
      window_instance_id: string
      is_main_window: boolean
      plugin_challenge: string
    }
  | { v: 1; seq: number; type: 'companion_challenge'; companion_challenge: string }
  | {
      v: 1
      seq: number
      type: 'pairing_decision'
      window_instance_id: string
      approved: boolean
      response: string
    }
  | { v: 1; seq: number; type: 'lease_granted'; lease_epoch: number }
  | { v: 1; seq: number; type: 'lease_revoked'; lease_epoch: number; reason: ErrorCode }
  | {
      v: 1
      seq: number
      type: 'rpc_request'
      request_id: string
      lease_epoch: number
      request: OperationalRequest
    }
  | {
      v: 1
      seq: number
      type: 'rpc_result'
      request_id: string
      lease_epoch: number
      ok: true
      result: Record<string, unknown>
    }
  | {
      v: 1
      seq: number
      type: 'rpc_result'
      request_id: string
      lease_epoch: number
      ok: false
      error: { code: ErrorCode; message?: string }
    }
  | {
      v: 1
      seq: number
      type: 'rpc_cancelled'
      request_id: string
      lease_epoch: number
      reason: ErrorCode
    }
  | {
      v: 1
      seq: number
      type: 'cancel_request'
      request_id: string
      lease_epoch: number
    }

export const encodeFrame = ipcContract.encodeFrame
export const IpcFrameDecoder = ipcContract.IpcFrameDecoder
