import { mkdir, mkdtemp, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it } from 'vitest'

import { createPluginGateway } from '../src/gateway/plugin-gateway.js'
import { bindCompanionRuntimeArtifacts } from '../src/runtime/startup.js'
import { createPairingNonce, createRuntimePaths } from '../src/index.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe('bindCompanionRuntimeArtifacts', () => {
  it.skipIf(process.platform === 'win32')(
    'removes the endpoint when descriptor writing fails after listen',
    async () => {
      const parent = await mkdtemp(path.join('/tmp', 'tsm-'))
      const paths = createRuntimePaths({
        platform: 'linux',
        env: { XDG_RUNTIME_DIR: parent },
        homedir: () => parent,
        tmpdir: () => parent,
        randomBytes: () => Buffer.alloc(8),
      })
      await mkdir(paths.runtimeDirectory, { recursive: true, mode: 0o700 })
      const gateway = createPluginGateway({
        endpoint: paths.endpoint,
        pid: 99,
        pairingNonce: createPairingNonce(() => Buffer.alloc(32, 1)),
      })
      cleanups.push(async () => {
        await gateway.close()
        await unlink(paths.endpoint).catch(() => undefined)
        await unlink(paths.descriptorPath).catch(() => undefined)
      })

      await expect(
        bindCompanionRuntimeArtifacts(
          gateway,
          paths,
          {
            protocol_version: 1,
            endpoint: paths.endpoint,
            pid: 99,
            expires_at: Date.now() + 60_000,
            pairing_nonce: createPairingNonce(() => Buffer.alloc(32, 2)),
          },
          {
            writeDescriptor: async () => {
              throw new Error('descriptor write failed')
            },
          },
        ),
      ).rejects.toThrow(/descriptor write failed/)

      await expect(stat(paths.endpoint)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(paths.descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )
})
