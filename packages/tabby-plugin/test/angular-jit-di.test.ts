import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const SRC = resolve(import.meta.dirname, '../src')
const BUNDLE = resolve(import.meta.dirname, '../dist/index.js')

function readSource(relativePath: string): string {
  return readFileSync(resolve(SRC, relativePath), 'utf8')
}

describe('Angular JIT constructor injection (Tabby host)', () => {
  it('uses explicit @Inject tokens for tabby-core services erased by import type', () => {
    const authorized = readSource('services/authorized-profiles.service.ts')
    expect(authorized).toMatch(/@Inject\(ProfilesService\)/)
    expect(authorized).toMatch(/@Inject\(ConfigService\)/)
    expect(authorized).toMatch(/import \{[^}]*ProfilesService[^}]*\} from 'tabby-core'/)
    expect(authorized).not.toMatch(
      /import type \{[^}]*(?:ProfilesService|ConfigService)[^}]*\} from 'tabby-core'/,
    )

    const settings = readSource('settings/secure-mcp-settings.component.ts')
    expect(settings).toMatch(/@Inject\(ProfilesService\)/)
    expect(settings).toMatch(/@Inject\(ConfigService\)/)
    expect(settings).toMatch(/import \{[^}]*ProfilesService[^}]*\} from 'tabby-core'/)
    expect(settings).not.toMatch(
      /import type \{[^}]*(?:ProfilesService|ConfigService)[^}]*\} from 'tabby-core'/,
    )

    const lifecycle = readSource('runtime/plugin-runtime-lifecycle.ts')
    expect(lifecycle).toMatch(/@Inject\(PluginRuntimeService\)/)

    const audit = readSource('audit/audit-service.ts')
    expect(audit).toMatch(/constructor\(\)/)
    expect(audit).not.toMatch(/constructor\(\s*\n?\s*options:/)
  })

  it('ships JIT metadata or inject tokens for host services in the production bundle', () => {
    const bundle = readFileSync(BUNDLE, 'utf8')
    expect(bundle).toMatch(/ProfilesService/)
    expect(bundle).toMatch(/ConfigService/)
    expect(bundle).toMatch(/design:paramtypes|Inject\(/)
  })
})
