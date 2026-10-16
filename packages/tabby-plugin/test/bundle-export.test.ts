import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('Tabby plugin bundle export', () => {
  it('ships a UMD bundle with an Angular NgModule default export', () => {
    const bundlePath = resolve(import.meta.dirname, '../dist/index.js')
    const bundle = readFileSync(bundlePath, 'utf8')

    expect(bundle).toMatch(/webpackUniversalModuleDefinition|module\.exports/)
    expect(bundle).toMatch(/default:\(\)=>/)
    expect(bundle).toContain('secure-mcp')
    expect(bundle).toContain('SettingsTabProvider')
    expect(bundle).toContain('ConfigProvider')
    expect(bundle).toContain('NgModule')
    expect(bundle).toContain('Authorized SSH profiles')
  })
})
