import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { serveStdio } from '@modelcontextprotocol/server/stdio'

import { createPluginGateway } from './gateway/plugin-gateway.js'
import { createMcpServer } from './mcp/server.js'
import {
  CompanionAlreadyRunningError,
  acquireCompanionLock,
  createPairingNonce,
  createRuntimePaths,
  type CompanionLock,
  type RuntimeDescriptor,
} from './index.js'
import { bindCompanionRuntimeArtifacts } from './runtime/startup.js'

function diagnostic(message: string): void {
  process.stderr.write(`${message}\n`)
}

async function removeIfOwned(path: string, owned: boolean): Promise<void> {
  if (!owned) {
    return
  }
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      diagnostic(`failed to remove ${path}: ${error.message}`)
    }
  })
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('tabby-secure-mcp stdio MCP companion\n')
    return
  }

  const paths = createRuntimePaths()
  const pairingNonce = createPairingNonce(randomBytes)
  const descriptor: RuntimeDescriptor = {
    protocol_version: 1,
    endpoint: paths.endpoint,
    pid: process.pid,
    expires_at: Date.now() + 24 * 60 * 60 * 1000,
    pairing_nonce: pairingNonce,
  }

  let lock: CompanionLock | undefined
  let ownsEndpoint = false
  let ownsDescriptor = false
  const gateway = createPluginGateway({
    endpoint: paths.endpoint,
    pid: process.pid,
    pairingNonce,
    onDiagnostic: diagnostic,
  })
  let stdioHandle: { close(): Promise<void> } | undefined

  const shutdown = async (reason: string) => {
    diagnostic(`shutting down: ${reason}`)
    if (stdioHandle) {
      await stdioHandle.close().catch(() => undefined)
      stdioHandle = undefined
    }
    await gateway.close().catch(() => undefined)
    await removeIfOwned(paths.endpoint, ownsEndpoint)
    await removeIfOwned(paths.descriptorPath, ownsDescriptor)
    if (lock) {
      await lock.release().catch(() => undefined)
      lock = undefined
    }
  }

  try {
    lock = await acquireCompanionLock(paths.lockPath)
    const ownership = await bindCompanionRuntimeArtifacts(gateway, paths, descriptor)
    ownsEndpoint = ownership.ownsEndpoint
    ownsDescriptor = ownership.ownsDescriptor

    stdioHandle = serveStdio(() => createMcpServer(gateway), {
      onerror: (error) => diagnostic(`mcp error: ${error.message}`),
    })

    const onSignal = () => {
      void shutdown('signal').finally(() => process.exit(0))
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    process.stdin.on('end', () => {
      void shutdown('stdin end').finally(() => process.exit(0))
    })
  } catch (error) {
    if (error instanceof CompanionAlreadyRunningError) {
      diagnostic(error.message)
      process.exitCode = 1
      await gateway.close().catch(() => undefined)
      return
    }
    diagnostic(`startup failed: ${(error as Error).message}`)
    await removeIfOwned(paths.endpoint, ownsEndpoint)
    await removeIfOwned(paths.descriptorPath, ownsDescriptor)
    await gateway.close().catch(() => undefined)
    if (lock) {
      await lock.release().catch(() => undefined)
    }
    process.exitCode = 1
  }
}

function isCliMain(): boolean {
  const entry = process.argv[1]
  if (!entry) {
    return false
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isCliMain()) {
  void main()
}
