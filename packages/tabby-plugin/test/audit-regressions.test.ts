import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import * as nodeFs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AuditService, MAX_AUDIT_SEGMENT_BYTES, NodeAuditFileSystem, verifyAuditSegments, type AuditFileSystem } from '../src/audit/audit-service'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))

function memoryFs() {
  const files = new Map<string, string>()
  const fs: AuditFileSystem = {
    async mkdir() {}, async chmod() {}, async rename() { throw new Error('must not rename evidence') },
    async readFile(path) { if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(path)! },
    async writeFile(path, data, options) {
      if (options.flag === 'wx' && files.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      files.set(path, (options.flag === 'a' ? files.get(path) ?? '' : '') + data)
    },
  }
  return { files, fs }
}

describe('audit safety regressions', () => {
  it('enforces the UTF-8 byte limit even with stale size metadata', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'audit-read-'))
    try {
      const fs = new NodeAuditFileSystem()
      const file = path.join(dir, 'segment.jsonl')
      const content = 'é'.repeat(MAX_AUDIT_SEGMENT_BYTES / 2)
      await writeFile(file, content, 'utf8')
      expect(await fs.readFile(file, 'utf8')).toBe(content)
      await truncate(file, MAX_AUDIT_SEGMENT_BYTES + 1)
      await expect(fs.readFile(file, 'utf8')).rejects.toThrow('unsafe audit segment')

      const handle = await nodeFs.open(file, 'r')
      const openSpy = vi.spyOn(nodeFs, 'open').mockResolvedValueOnce(handle)
      try {
        // Model stale size metadata without changing the file during the read.
        const observed = await handle.stat({ bigint: true })
        observed.size = BigInt(MAX_AUDIT_SEGMENT_BYTES - 1024)
        vi.spyOn(handle, 'stat').mockResolvedValueOnce(observed)
        await expect(fs.readFile(file, 'utf8')).rejects.toThrow('unsafe audit segment')
        expect(handle.fd).toBe(-1)
      } finally {
        openSpy.mockRestore()
        await handle.close()
      }
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('rejects a directory and preserves ENOENT for a missing segment', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'audit-read-'))
    try {
      const fs = new NodeAuditFileSystem()
      await expect(fs.readFile(dir, 'utf8')).rejects.toThrow('unsafe audit segment')
      await expect(fs.readFile(path.join(dir, 'missing.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it.skipIf(process.platform === 'win32')('rejects segment symlinks even when their target is missing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'audit-read-'))
    try {
      const file = path.join(dir, 'segment.jsonl')
      const link = path.join(dir, 'link.jsonl')
      await writeFile(file, 'segment\n', 'utf8')
      await symlink(file, link)
      await expect(new NodeAuditFileSystem().readFile(link, 'utf8')).rejects.toThrow()
      await rm(file)
      await expect(verifyAuditSegments([link])).rejects.toThrow()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('flushes and verifies real disk segments with private file permissions', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'audit-disk-'))
    try {
      const audit = AuditService.forTests({ logPath: path.join(dir, '000001.jsonl'), maxSegmentBytes: 500 })
      for (let i = 0; i < 3; i++) await audit.append({ event: 'runtime_start', result: 'ok' })
      expect(audit.getSegmentPaths()).toHaveLength(3)
      expect((await verifyAuditSegments(audit.getSegmentPaths())).sequence).toBe(3)
      for (const file of audit.getSegmentPaths()) {
        const info = await stat(file)
        expect(info.size).toBeLessThanOrEqual(500)
        if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o600)
      }
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('uses separate logs for independent writers and leaves the legacy file untouched', async () => {
    const { fs, files } = memoryFs()
    const legacy = '/legacy/audit.jsonl'
    files.set(legacy, 'legacy evidence')
    const a = AuditService.forTests({ fs })
    const b = AuditService.forTests({ fs })
    await Promise.all([a.append({ event: 'runtime_start', result: 'ok' }), b.append({ event: 'runtime_start', result: 'ok' })])
    expect(files.size).toBe(3)
    expect(files.get(legacy)).toBe('legacy evidence')
    for (const raw of [...files.values()].filter(value => value !== 'legacy evidence')) expect(JSON.parse(raw).sequence).toBe(1)
  })

  it('rotates bounded segments without resetting the hash chain', async () => {
    const { fs, files } = memoryFs()
    const audit = AuditService.forTests({ fs, logPath: '/audit/events.jsonl', maxSegmentBytes: 500 } as any)
    for (let i = 0; i < 3; i++) await audit.append({ event: 'runtime_start', result: 'ok' })
    expect(files.size).toBe(3)
    const records = [...files.values()].map(raw => JSON.parse(raw))
    expect(records.map(record => record.sequence)).toEqual([1, 2, 3])
    expect(records[1].previous_hash).toBe(records[0].hash)
    expect(records[2].previous_hash).toBe(records[1].hash)
    expect((await verifyAuditSegments(audit.getSegmentPaths(), fs)).sequence).toBe(3)
    const second = audit.getSegmentPaths()[1]
    files.set(second, files.get(second)!.replace('runtime_start', 'runtime_stop'))
    await expect(verifyAuditSegments(audit.getSegmentPaths(), fs)).rejects.toThrow('chain')
  })

  it('does not detach later queued writes when an earlier safe append fails', async () => {
    const { fs, files } = memoryFs()
    let count = 0
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>(resolve => { entered = resolve })
    const faulty = { ...fs, async writeFile(path: string, data: string, options: any) {
      if (options.flag === 'a') {
        count++
        if (count === 1) throw new Error('disk full')
        if (count === 2) { entered(); await new Promise<void>(resolve => { release = resolve }) }
      }
      return fs.writeFile(path, data, options)
    } }
    const audit = AuditService.forTests({ fs: faulty, logPath: '/audit/events.jsonl' })
    const a = audit.safeAppend({ event: 'runtime_start', result: 'ok' })
    const b = audit.append({ event: 'runtime_connect', result: 'ok' })
    await blocked
    await a
    const c = audit.append({ event: 'list_result', result: 'ok' })
    await Promise.resolve()
    release()
    await Promise.all([b, c])
    const records = files.get('/audit/events.jsonl')!.trim().split('\n').map(line => JSON.parse(line))
    expect(records.map(record => record.sequence)).toEqual([1, 2])
    expect(records[1].previous_hash).toBe(records[0].hash)
  })

  it('recovers a newly created empty segment after its first flush fails', async () => {
    const { fs, files } = memoryFs()
    let fail = true
    const faulty = { ...fs, async writeFile(path: string, data: string, options: any) {
      await fs.writeFile(path, data, options)
      if (options.flag === 'wx' && fail) { fail = false; throw Object.assign(new Error('flush ENOSPC'), { code: 'ENOSPC' }) }
    } }
    const audit = AuditService.forTests({ fs: faulty, logPath: '/audit/events.jsonl', maxSegmentBytes: 500 })
    await audit.append({ event: 'runtime_start', result: 'ok' })
    await expect(audit.append({ event: 'runtime_connect', result: 'ok' })).rejects.toThrow('ENOSPC')
    await audit.append({ event: 'list_result', result: 'ok' })
    expect(files.size).toBe(2)
    expect((await verifyAuditSegments(audit.getSegmentPaths(), fs)).sequence).toBe(2)
  })
})
