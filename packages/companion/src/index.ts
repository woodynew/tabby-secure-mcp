export {
  CompanionAlreadyRunningError,
  acquireCompanionLock,
  type CompanionLock,
  type CompanionLockDependencies,
} from './runtime/lock.js'
export {
  createRuntimePaths,
  writeRuntimeDescriptor,
  type RuntimeDescriptor,
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
  verifyPairingResponse,
  type PairingTranscript,
} from './runtime/pairing.js'
