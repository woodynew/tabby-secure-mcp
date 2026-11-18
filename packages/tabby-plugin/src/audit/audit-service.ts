import { Injectable } from '@angular/core'
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  AUDIT_CHAIN_LIMITATION,
  AUDIT_GENESIS_HASH,
  AUDIT_LOG_VERSION,
  canonicalAuditPayload,
  hashAuditEvent,
  type AuditEventInput,
  type StoredAuditEvent,
} from './audit-types'
import { resolveAuditLogPath } from './audit-paths'

export { AUDIT_CHAIN_LIMITATION }
export const MAX_AUDIT_SEGMENT_BYTES = 10 * 1024 * 1024

export interface AuditFileSystem {
  mkdir(dir: string, options: { recursive: boolean; mode?: number }): Promise<void>
  chmod(target: string, mode: number): Promise<void>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(
    path: string,
    data: string,
    options: { encoding: 'utf8'; flag?: string; mode?: number; flush?: boolean },
  ): Promise<void>
  rename(from: string, to: string): Promise<void>
}

export interface AuditServiceOptions {
  logPath?: string
  fs?: AuditFileSystem
  platform?: NodeJS.Platform
  maxSegmentBytes?: number
}

export class NodeAuditFileSystem implements AuditFileSystem {
  async mkdir(dir: string, options: { recursive: boolean; mode?: number }): Promise<void> {
    await mkdir(dir, options)
  }

  async chmod(target: string, mode: number): Promise<void> {
    await chmod(target, mode)
  }

  async readFile(file: string, encoding: 'utf8'): Promise<string> {
    const noFollow = constants.O_NOFOLLOW ?? 0
    // Without O_NOFOLLOW, require the handle to match the regular directory entry.
    const entry = noFollow ? undefined : await lstat(file, { bigint: true })
    if (entry && (!entry.isFile() || entry.ino === 0n)) throw new Error('unsafe audit segment')

    const handle = await open(file, constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0), 0o600).catch((error: NodeJS.ErrnoException) => {
      // A replaced entry can produce ENOENT by pointing to a missing target.
      if (entry && error.code === 'ENOENT') throw new Error('unsafe audit segment')
      throw error
    })
    try {
      const info = await handle.stat({ bigint: true })
      if (!info.isFile() || info.size > MAX_AUDIT_SEGMENT_BYTES || (entry && (info.dev !== entry.dev || info.ino !== entry.ino))) {
        throw new Error('unsafe audit segment')
      }

      // Read at most one extra byte to detect growth past the limit.
      const readLimit = MAX_AUDIT_SEGMENT_BYTES + 1
      let buffer = Buffer.allocUnsafe(Number(info.size) + 1)
      let total = 0
      while (true) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total)
        if (bytesRead === 0) return buffer.toString(encoding, 0, total)
        total += bytesRead
        if (total === readLimit) throw new Error('unsafe audit segment')
        if (total === buffer.length) {
          const expanded = Buffer.allocUnsafe(Math.min(buffer.length * 2, readLimit))
          buffer.copy(expanded)
          buffer = expanded
        }
      }
    } finally {
      await handle.close()
    }
  }
  writeFile = writeFile
  rename = rename
}

@Injectable()
export class AuditService {
  private logPath!: string
  private fs!: AuditFileSystem
  private platform!: NodeJS.Platform
  private sequence = 0
  private previousHash = AUDIT_GENESIS_HASH
  private writeChain: Promise<void> = Promise.resolve()
  private initPromise?: Promise<void>
  private segmentBytes = 0
  private maxSegmentBytes = MAX_AUDIT_SEGMENT_BYTES
  private segments: string[] = []
  private needsRecovery = false
  private pendingSegment?: string

  constructor() {
    this.applyOptions({})
  }

  static forTests(options: AuditServiceOptions = {}): AuditService {
    const audit = new AuditService()
    audit.applyOptions(options)
    return audit
  }

  private applyOptions(options: AuditServiceOptions): void {
    this.logPath = options.logPath ?? path.join(path.dirname(resolveAuditLogPath()), 'audit', randomBytes(16).toString('hex'), '000001.jsonl')
    this.segments = [this.logPath]
    this.maxSegmentBytes = Math.min(options.maxSegmentBytes ?? MAX_AUDIT_SEGMENT_BYTES, MAX_AUDIT_SEGMENT_BYTES)
    if (this.maxSegmentBytes <= 0) throw new Error('invalid audit limit')
    this.fs = options.fs ?? new NodeAuditFileSystem()
    this.platform = options.platform ?? process.platform
  }

  async append(input: AuditEventInput): Promise<void> {
    const task = this.writeChain.then(async () => {
      await this.ensureInitialized()
      if (this.pendingSegment) {
        const next = this.pendingSegment
        let present = true
        try {
          if (await this.fs.readFile(next, 'utf8') !== '') throw new Error('unexpected audit segment content')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          present = false
        }
        if (present) {
          await this.fs.writeFile(next, '', { encoding: 'utf8', flag: 'a', mode: 0o600, flush: true })
          this.segments.push(next)
          this.logPath = next
          this.segmentBytes = 0
        }
        this.pendingSegment = undefined
      }
      if (this.needsRecovery) {
        const head = await verifyAuditSegments(this.segments, this.fs)
        this.sequence = head.sequence
        this.previousHash = head.previousHash
        try {
          this.segmentBytes = Buffer.byteLength(await this.fs.readFile(this.logPath, 'utf8'), 'utf8')
        } catch (error) {
          if (head.sequence !== 0 || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          this.segmentBytes = 0
        }
        this.needsRecovery = false
      }
      await this.appendLine(input)
    })
    this.writeChain = task.catch(() => undefined)
    await task
  }

  async safeAppend(input: AuditEventInput): Promise<void> {
    try {
      await this.append(input)
    } catch {
      // Critical callers use append; diagnostic failures must not detach its queue.
    }
  }

  getChainHead(): { sequence: number; previousHash: string } {
    return { sequence: this.sequence, previousHash: this.previousHash }
  }

  getSegmentPaths(): string[] { return [...this.segments] }

  private ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initializeChain()
    }
    return this.initPromise
  }

  private async initializeChain(): Promise<void> {
    const dir = path.dirname(this.logPath)
    await this.fs.mkdir(dir, { recursive: true, mode: 0o700 })
    if (this.platform !== 'win32') {
      await this.fs.chmod(dir, 0o700)
    }

    let raw = ''
    try {
      raw = await this.fs.readFile(this.logPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }

    this.segmentBytes = Buffer.byteLength(raw, 'utf8')
    if (this.segmentBytes > this.maxSegmentBytes) throw new Error('oversize audit segment')
    if (raw && !raw.endsWith('\n')) throw new Error('incomplete audit record')

    const lines = raw.split('\n').filter((line) => line.length > 0)
    if (lines.length === 0) {
      return
    }

    let expectedPrevious = AUDIT_GENESIS_HASH
    let lastSequence = 0
    for (const line of lines) {
      let event: StoredAuditEvent
      try {
        event = JSON.parse(line) as StoredAuditEvent
      } catch {
        throw new Error('malformed audit record')
      }
      if (event.previous_hash !== expectedPrevious) {
        throw new Error('broken audit chain')
      }
      const payload = canonicalAuditPayload({
        version: event.version,
        sequence: event.sequence,
        timestampUtc: event.timestamp_utc,
        event: event.event,
        result: event.result,
        errorCode: event.error_code as AuditEventInput['errorCode'],
        requestId: event.request_id,
        authorizedCount: event.authorized_count,
        approvalMode: event.approval_mode,
        commandRisk: event.command_risk,
        commandRuleId: event.command_rule_id,
        previousHash: event.previous_hash,
      })
      const { hash } = hashAuditEvent(payload, event.previous_hash)
      if (hash !== event.hash || event.sequence !== lastSequence + 1 || event.version !== AUDIT_LOG_VERSION) {
        throw new Error('audit hash mismatch')
      }
      expectedPrevious = event.hash
      lastSequence = event.sequence
    }

    this.previousHash = expectedPrevious
    this.sequence = lastSequence
  }

  private async appendLine(input: AuditEventInput): Promise<void> {
    const sequence = this.sequence + 1
    const timestampUtc = new Date().toISOString()
    const payload = canonicalAuditPayload({
      version: AUDIT_LOG_VERSION,
      sequence,
      timestampUtc,
      event: input.event,
      result: input.result,
      errorCode: input.errorCode,
      requestId: input.requestId,
      authorizedCount: input.authorizedCount,
      approvalMode: input.approvalMode,
      commandRisk: input.commandRisk,
      commandRuleId: input.commandRuleId,
      previousHash: this.previousHash,
    })
    const { hash, previous_hash } = hashAuditEvent(payload, this.previousHash)
    const stored: StoredAuditEvent = {
      version: AUDIT_LOG_VERSION,
      sequence,
      timestamp_utc: timestampUtc,
      event: input.event,
      result: input.result,
      previous_hash,
      hash,
    }
    if (input.errorCode !== undefined) {
      stored.error_code = input.errorCode
    }
    if (input.requestId !== undefined) {
      stored.request_id = input.requestId
    }
    if (input.authorizedCount !== undefined) {
      stored.authorized_count = input.authorizedCount
    }
    if (input.approvalMode !== undefined) stored.approval_mode = input.approvalMode
    if (input.commandRisk !== undefined) stored.command_risk = input.commandRisk
    if (input.commandRuleId !== undefined) stored.command_rule_id = input.commandRuleId

    const line = `${JSON.stringify(stored)}\n`
    const bytes = Buffer.byteLength(line, 'utf8')
    if (bytes > this.maxSegmentBytes) throw new Error('oversize audit record')
    if (this.segmentBytes + bytes > this.maxSegmentBytes) {
      const next = path.join(path.dirname(this.segments[0]), `${String(this.segments.length + 1).padStart(6, '0')}.jsonl`)
      try {
        await this.fs.writeFile(next, '', { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') this.pendingSegment = next
        throw error
      }
      this.segments.push(next)
      this.logPath = next
      this.segmentBytes = 0
    }
    try {
      await this.fs.writeFile(this.logPath, line, {
      encoding: 'utf8',
      flag: 'a',
      mode: 0o600,
      flush: true,
    })
    if (this.platform !== 'win32') {
      await this.fs.chmod(this.logPath, 0o600)
    }
    } catch (error) {
      this.needsRecovery = true
      throw error
    }

    this.segmentBytes += bytes
    this.sequence = sequence
    this.previousHash = hash
  }
}

export async function verifyAuditSegments(paths: readonly string[], fs: AuditFileSystem = new NodeAuditFileSystem()): Promise<{ sequence: number; previousHash: string }> {
  let previousHash = AUDIT_GENESIS_HASH
  let sequence = 0
  for (const file of paths) {
    let raw = ''
    try { raw = await fs.readFile(file, 'utf8') } catch (error) {
      if (paths.length !== 1 || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_AUDIT_SEGMENT_BYTES || (raw && !raw.endsWith('\n'))) throw new Error('invalid audit segment')
    for (const line of raw.split('\n').filter(Boolean)) {
      let event: StoredAuditEvent
      try { event = JSON.parse(line) } catch { throw new Error('corrupt audit record') }
      const payload = canonicalAuditPayload({ version: event.version, sequence: event.sequence, timestampUtc: event.timestamp_utc,
        event: event.event, result: event.result, errorCode: event.error_code as AuditEventInput['errorCode'],
        requestId: event.request_id, authorizedCount: event.authorized_count,
        approvalMode: event.approval_mode, commandRisk: event.command_risk, commandRuleId: event.command_rule_id, previousHash: event.previous_hash })
      if (event.version !== AUDIT_LOG_VERSION || event.sequence !== sequence + 1 || event.previous_hash !== previousHash || hashAuditEvent(payload, previousHash).hash !== event.hash) throw new Error('broken audit chain')
      sequence = event.sequence
      previousHash = event.hash
    }
  }
  return { sequence, previousHash }
}
