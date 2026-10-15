import { Buffer } from 'node:buffer'
import { z } from 'zod'

export const MAX_FRAME_BYTES = 64 * 1024
export const MAX_BUFFER_BYTES = 128 * 1024
export const MAX_JSON_DEPTH = 16
export const MAX_STRING_BYTES = 8 * 1024
/** Identifier fields cap Unicode code units; UTF-8 byte limits still apply globally. */
export const MAX_IDENTIFIER_CODE_UNITS = 256

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function validateJsonValue(
  value: unknown,
  ctx: z.core.$RefinementCtx<unknown>,
  depth = 1,
): void {
  if (depth > MAX_JSON_DEPTH) {
    ctx.addIssue({ code: 'custom', message: `JSON depth exceeds ${MAX_JSON_DEPTH}` })
    return
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES) {
      ctx.addIssue({ code: 'custom', message: `string exceeds ${MAX_STRING_BYTES} bytes` })
    }
    return
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      validateJsonValue(item, ctx, depth + 1)
    }
    return
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      ctx.addIssue({ code: 'custom', message: 'JSON objects must have a plain prototype' })
      return
    }
    for (const [key, child] of Object.entries(value)) {
      if (DANGEROUS_KEYS.has(key)) {
        ctx.addIssue({ code: 'custom', message: `dangerous key: ${key}` })
      }
      if (Buffer.byteLength(key, 'utf8') > MAX_STRING_BYTES) {
        ctx.addIssue({ code: 'custom', message: `key exceeds ${MAX_STRING_BYTES} bytes` })
      }
      validateJsonValue(child, ctx, depth + 1)
    }
    return
  }
  ctx.addIssue({ code: 'custom', message: 'value is not valid JSON' })
}

export function secureSchema<T extends z.ZodType>(schema: T) {
  return schema.superRefine((value, ctx) => validateJsonValue(value, ctx))
}

const boundedString = z
  .string()
  .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_STRING_BYTES, {
    message: `string exceeds ${MAX_STRING_BYTES} bytes`,
  })
const identifier = boundedString.min(1).max(MAX_IDENTIFIER_CODE_UNITS)
const sequence = z.number().int().positive()
const leaseEpoch = z.number().int().positive()

export const errorCodeSchema = z.enum([
  'target_unavailable',
  'not_approved',
  'expired',
  'cancelled',
  'busy',
  'rate_limited',
  'plugin_unavailable',
  'internal',
])
export type ErrorCode = z.infer<typeof errorCodeSchema>

export const listAuthorizedSshProfilesRequestSchema = z.strictObject({
  method: z.literal('list_authorized_ssh_profiles'),
  params: z.strictObject({}),
})

export const openAuthorizedSshProfileRequestSchema = z.strictObject({
  method: z.literal('open_authorized_ssh_profile'),
  params: z.strictObject({
    profile_ref: identifier,
  }),
})

export const operationalRequestSchema = secureSchema(
  z.discriminatedUnion('method', [
    listAuthorizedSshProfilesRequestSchema,
    openAuthorizedSshProfileRequestSchema,
  ]),
)
export type OperationalRequest = z.infer<typeof operationalRequestSchema>

const messageBase = {
  v: z.literal(1),
  seq: sequence,
}

export const pluginHelloSchema = secureSchema(
  z.strictObject({
    ...messageBase,
    type: z.literal('plugin_hello'),
    window_instance_id: identifier,
    is_main_window: z.boolean(),
    plugin_challenge: identifier,
  }),
)

export const companionChallengeSchema = secureSchema(
  z.strictObject({
    ...messageBase,
    type: z.literal('companion_challenge'),
    companion_challenge: identifier,
  }),
)

export const pairingDecisionSchema = secureSchema(
  z.strictObject({
    ...messageBase,
    type: z.literal('pairing_decision'),
    window_instance_id: identifier,
    approved: z.boolean(),
    response: boundedString.min(1),
  }),
)

export const leaseGrantedSchema = secureSchema(
  z.strictObject({
    ...messageBase,
    type: z.literal('lease_granted'),
    lease_epoch: leaseEpoch,
  }),
)

export const leaseRevokedSchema = secureSchema(
  z.strictObject({
    ...messageBase,
    type: z.literal('lease_revoked'),
    lease_epoch: leaseEpoch,
    reason: errorCodeSchema,
  }),
)

export const windowStateSchema = secureSchema(
  z.strictObject({
    ...messageBase,
    type: z.literal('window_state'),
    window_instance_id: identifier,
    is_main_window: z.boolean(),
  }),
)

const operationalBase = {
  ...messageBase,
  request_id: identifier,
  lease_epoch: leaseEpoch,
}

export const rpcRequestSchema = secureSchema(
  z.strictObject({
    ...operationalBase,
    type: z.literal('rpc_request'),
    request: operationalRequestSchema,
  }),
)

const sshProfileSummarySchema = z.strictObject({
  profile_ref: identifier,
  display_name: identifier,
})

export const listProfilesRpcResultSchema = z.strictObject({
  profiles: z.array(sshProfileSummarySchema),
})

export const openProfileRpcResultSchema = z.strictObject({
  status: z.literal('opened'),
})

export const rpcSuccessResultSchema = z.union([
  listProfilesRpcResultSchema,
  openProfileRpcResultSchema,
])

const rpcSuccessSchema = z.strictObject({
  ...operationalBase,
  type: z.literal('rpc_result'),
  ok: z.literal(true),
  result: rpcSuccessResultSchema,
})
const rpcFailureSchema = z.strictObject({
  ...operationalBase,
  type: z.literal('rpc_result'),
  ok: z.literal(false),
  error: z.strictObject({
    code: errorCodeSchema,
    message: boundedString.max(512).optional(),
  }),
})
export const rpcResultSchema = secureSchema(z.union([rpcSuccessSchema, rpcFailureSchema]))

export const rpcCancelledSchema = secureSchema(
  z.strictObject({
    ...operationalBase,
    type: z.literal('rpc_cancelled'),
    reason: errorCodeSchema,
  }),
)

export const cancelRequestSchema = secureSchema(
  z.strictObject({
    ...operationalBase,
    type: z.literal('cancel_request'),
  }),
)

export const ipcMessageSchema = secureSchema(
  z.union([
    pluginHelloSchema,
    companionChallengeSchema,
    pairingDecisionSchema,
    leaseGrantedSchema,
    leaseRevokedSchema,
    windowStateSchema,
    rpcRequestSchema,
    rpcResultSchema,
    rpcCancelledSchema,
    cancelRequestSchema,
  ]),
)

export type PluginHello = z.infer<typeof pluginHelloSchema>
export type CompanionChallenge = z.infer<typeof companionChallengeSchema>
export type PairingDecision = z.infer<typeof pairingDecisionSchema>
export type LeaseGranted = z.infer<typeof leaseGrantedSchema>
export type LeaseRevoked = z.infer<typeof leaseRevokedSchema>
export type WindowState = z.infer<typeof windowStateSchema>
export type RpcRequest = z.infer<typeof rpcRequestSchema>
export type RpcResult = z.infer<typeof rpcResultSchema>
export type RpcCancelled = z.infer<typeof rpcCancelledSchema>
export type CancelRequest = z.infer<typeof cancelRequestSchema>
export type IpcMessage = z.infer<typeof ipcMessageSchema>

export const messageSchema = ipcMessageSchema
export type Message = IpcMessage
