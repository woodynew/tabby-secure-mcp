import { Buffer } from 'node:buffer'
import { z } from 'zod'

import { MAX_STRING_BYTES } from '@tabby-secure-mcp/ipc-contract'

import { decodePairingNonce } from './pairing.js'

const endpointSchema = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_STRING_BYTES, {
    message: `endpoint exceeds ${MAX_STRING_BYTES} bytes`,
  })

export const runtimeDescriptorSchema = z.strictObject({
  protocol_version: z.literal(1),
  endpoint: endpointSchema,
  pid: z.number().int().positive(),
  expires_at: z.number().int().positive(),
  pairing_nonce: z.string().superRefine((value, ctx) => {
    if (decodePairingNonce(value) === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'pairing_nonce must be base64url encoding of exactly 32 bytes',
      })
    }
  }),
})

export type RuntimeDescriptor = z.infer<typeof runtimeDescriptorSchema>

export class RuntimeDescriptorValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RuntimeDescriptorValidationError'
  }
}

export function assertValidRuntimeDescriptor(
  descriptor: RuntimeDescriptor,
  expectedEndpoint: string,
): void {
  const parsed = runtimeDescriptorSchema.safeParse(descriptor)
  if (!parsed.success) {
    throw new RuntimeDescriptorValidationError('runtime descriptor failed validation', {
      cause: parsed.error,
    })
  }
  if (descriptor.endpoint !== expectedEndpoint) {
    throw new RuntimeDescriptorValidationError(
      'runtime descriptor endpoint does not match runtime paths',
    )
  }
}
