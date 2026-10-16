import type { DescriptorFileSystem } from './descriptor-reader'
import type { ProcessLivenessProbe } from './process-liveness'
import type { RuntimeDiagnosticCode } from './runtime-diagnostics'

export interface PluginSocket {
  destroyed?: boolean
  writable?: boolean
  on(event: 'connect', listener: () => void): this
  on(event: 'data', listener: (chunk: Buffer) => void): this
  on(event: 'close', listener: () => void): this
  on(event: 'error', listener: (error: Error) => void): this
  write(buffer: Uint8Array, callback?: (error?: Error | null) => void): boolean
  removeAllListeners(): this
  destroy(): void
  end(): void
}

export interface SocketConnector {
  connect(endpoint: string, onConnect?: () => void): PluginSocket
}

export interface RuntimeTimerHandle {
  cancel(): void
}

export interface RuntimeTimerScheduler {
  schedule(delayMs: number, callback: () => void): RuntimeTimerHandle
}

export interface RandomBytesProvider {
  randomBytes(size: number): Uint8Array
  randomId(): string
}

export interface PluginRuntimeDependencies {
  platform?: NodeJS.Platform
  descriptorPaths?: { descriptorPath: string }
  fs?: DescriptorFileSystem
  connector?: SocketConnector
  timers?: RuntimeTimerScheduler
  random?: RandomBytesProvider
  reconnectDelayMs?: number
  isProcessAlive?: ProcessLivenessProbe
  onDiagnostic?: (code: RuntimeDiagnosticCode) => void
}
