import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const config = require('../webpack.config.cjs') as {
  externals?: RegExp | RegExp[]
  externalsType?: string
}

function isExternal(request: string): boolean {
  const externals = Array.isArray(config.externals)
    ? config.externals
    : config.externals
      ? [config.externals]
      : []

  return externals.some(entry => typeof entry !== 'function' && entry.test(request))
}

describe('Tabby plugin webpack host dependencies', () => {
  it.each([
    '@angular/core',
    '@angular/common',
    '@angular/common/http',
    '@ng-bootstrap/ng-bootstrap',
    'rxjs',
    'rxjs/operators',
    'tabby-core',
    'tabby-settings',
  ])('externalizes %s', request => {
    expect(isExternal(request)).toBe(true)
  })

  it.each([
    '@angular/common/locales/en',
    '@angular/common/locales/extra/en',
    '@tabby-secure-mcp/ipc-contract',
  ])('allows bundling %s', request => {
    expect(isExternal(request)).toBe(false)
  })

  it('loads externals from the Electron host through CommonJS', () => {
    expect(config.externalsType).toBe('commonjs')
  })

  it('maps node: builtins to unprefixed CommonJS requires for Tabby', () => {
    const externals = Array.isArray(config.externals)
      ? config.externals
      : config.externals
        ? [config.externals]
        : []
    const nodeMapper = externals.find(
      (entry): entry is (data: { request?: string }, callback: (error?: Error | null, result?: string) => void) => void =>
        typeof entry === 'function',
    )
    expect(nodeMapper).toBeDefined()
    let mapped: string | undefined
    nodeMapper?.({ request: 'node:buffer' }, (_error, result) => {
      mapped = result
    })
    expect(mapped).toBe('commonjs buffer')
  })
})
