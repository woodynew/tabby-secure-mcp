import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const INDEX_SOURCE = readFileSync(resolve(import.meta.dirname, '../src/index.ts'), 'utf8')

describe('TabbySecureMcpPluginModule wiring', () => {
  it('injects BOOTSTRAP_DATA into PluginRuntimeService and forces lifecycle construction', () => {
    expect(INDEX_SOURCE).toMatch(/BOOTSTRAP_DATA/)
    expect(INDEX_SOURCE).toMatch(/normalizeWindowBootstrap/)
    expect(INDEX_SOURCE).toMatch(/constructor\(_runtimeLifecycle: PluginRuntimeLifecycle\)/)
    expect(INDEX_SOURCE).not.toMatch(/readTabbyBootstrapData/)
    expect(INDEX_SOURCE).not.toMatch(/globalThis/)
  })
})
