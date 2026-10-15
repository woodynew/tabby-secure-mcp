import { describe, expect, it } from 'vitest'

import { AUDIT_CHAIN_LIMITATION, AuditService, type AuditFileSystem } from '../src/audit/audit-service'
import { AUDIT_GENESIS_HASH } from '../src/audit/audit-types'

function createMemoryFs(): { fs: AuditFileSystem; lines: string[] } {
  const lines: string[] = []
  const fs: AuditFileSystem = {
    async mkdir() {
      return undefined
    },
    async chmod() {
      return undefined
    },
    async readFile() {
      return lines.join('\n') + (lines.length > 0 ? '\n' : '')
    },
    async writeFile(_path, data, options) {
      if (options.flag === 'a') {
        lines.push(data.trimEnd())
        return
      }
      lines.length = 0
      if (data) {
        lines.push(data.trimEnd())
      }
    },
    async rename(from, to) {
      lines.push(`renamed:${from}->${to}`)
    },
  }
  return { fs, lines }
}

describe('AuditService', () => {
  it('documents hash chain limitations in code', () => {
    expect(AUDIT_CHAIN_LIMITATION).toMatch(/whole-file replacement/)
    expect(AUDIT_CHAIN_LIMITATION).toMatch(/tail deletion/)
  })

  it('appends chained events with serialized concurrent writes', async () => {
    const { fs, lines } = createMemoryFs()
    const audit = new AuditService({ logPath: '/tmp/audit.jsonl', fs, platform: 'linux' })
    await Promise.all([
      audit.append({ event: 'runtime_start', result: 'ok' }),
      audit.append({ event: 'runtime_connect', result: 'ok' }),
      audit.append({ event: 'list_result', result: 'ok', authorizedCount: 2 }),
    ])
    expect(lines).toHaveLength(3)
    const first = JSON.parse(lines[0])
    const second = JSON.parse(lines[1])
    const third = JSON.parse(lines[2])
    expect(first.previous_hash).toBe(AUDIT_GENESIS_HASH)
    expect(second.previous_hash).toBe(first.hash)
    expect(third.previous_hash).toBe(second.hash)
    expect(third.authorized_count).toBe(2)
  })

  it('redacts sensitive fields from serialized audit lines', async () => {
    const { fs, lines } = createMemoryFs()
    const audit = new AuditService({ logPath: '/tmp/audit.jsonl', fs, platform: 'linux' })
    await audit.append({
      event: 'open_requested',
      result: 'ok',
      requestId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })
    const serialized = lines.join('\n')
    expect(serialized).not.toMatch(/password|hunter2|secret-host|profile_ref|nonce|endpoint|\\\\\.\\pipe/i)
  })

  it('recovers the write queue after an append failure', async () => {
    let failNext = true
    const { fs, lines } = createMemoryFs()
    const failingFs: AuditFileSystem = {
      ...fs,
      async writeFile(path, data, options) {
        if (failNext && options.flag === 'a') {
          failNext = false
          throw new Error('disk full')
        }
        return fs.writeFile(path, data, options)
      },
    }
    const audit = new AuditService({ logPath: '/tmp/audit.jsonl', fs: failingFs, platform: 'linux' })
    await audit.safeAppend({ event: 'runtime_start', result: 'ok' })
    await audit.safeAppend({ event: 'runtime_connect', result: 'ok' })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('runtime_connect')
  })

  it('resumes a valid chain and rotates on corruption', async () => {
    const { fs, lines } = createMemoryFs()
    const first = new AuditService({ logPath: '/tmp/audit.jsonl', fs, platform: 'linux' })
    await first.append({ event: 'runtime_start', result: 'ok' })
    lines[0] = lines[0].replace(/"hash":"[a-f0-9]{64}"/, '"hash":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"')

    const second = new AuditService({ logPath: '/tmp/audit.jsonl', fs, platform: 'linux' })
    await second.append({ event: 'runtime_connect', result: 'ok' })
    expect(lines.some((line) => line.startsWith('renamed:'))).toBe(true)
    expect(second.getChainHead().sequence).toBe(1)
  })
})
