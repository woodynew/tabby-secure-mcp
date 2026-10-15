import { randomBytes } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import { serveStdio } from '@modelcontextprotocol/server/stdio'

import { createPluginGateway } from './gateway/plugin-gateway.js'
import { createMcpServer } from './mcp/server.js'
import {
  CompanionAlreadyRunningError,
  acquireCompanionLock,
  createPairingNonce,
  createRuntimePaths,
  writeRuntimeDescriptor,
  type CompanionLock,
  type RuntimeDescriptor,
} from './index.js'

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
  let ownsRuntimeArtifacts = false
  let gateway = createPluginGateway({
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
    await removeIfOwned(paths.endpoint, ownsRuntimeArtifacts)
    await removeIfOwned(paths.descriptorPath, ownsRuntimeArtifacts)
    if (lock) {
      await lock.release().catch(() => undefined)
      lock = undefined
    }
  }

  try {
    lock = await acquireCompanionLock(paths.lockPath)
    await gateway.listen()
    await writeRuntimeDescriptor(paths, descriptor)
    ownsRuntimeArtifacts = true

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
    await shutdown('startup failure')
    process.exitCode = 1
  }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main()
}
