export {
  CompanionAlreadyRunningError,
  acquireCompanionLock,
  type CompanionLock,
  type CompanionLockDependencies,
} from './runtime/lock.js'
export {
  assertValidRuntimeDescriptor,
  runtimeDescriptorSchema,
  RuntimeDescriptorValidationError,
  type RuntimeDescriptor,
} from './runtime/descriptor.js'
export {
  assertBindableUnixSocketPath,
  createRuntimePaths,
  PORTABLE_UNIX_SOCKET_PATH_MAX,
  writeRuntimeDescriptor,
  type RuntimePathDependencies,
  type RuntimePaths,
  type WriteRuntimeDescriptorOptions,
} from './runtime/paths.js'
export {
  LeaseManager,
  type LeaseGrant,
  type PendingRequest,
  type RegisteredWindow,
} from './runtime/lease.js'
export {
  canonicalPairingTranscript,
  createPairingNonce,
  createPairingResponse,
  decodePairingNonce,
  PAIRING_NONCE_BYTES,
  verifyPairingResponse,
  type PairingTranscript,
} from './runtime/pairing.js'
