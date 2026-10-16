import { Injectable } from '@angular/core'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
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

export interface AuditFileSystem {
  mkdir(dir: string, options: { recursive: boolean; mode?: number }): Promise<void>
  chmod(target: string, mode: number): Promise<void>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(
    path: string,
    data: string,
    options: { encoding: 'utf8'; flag?: string; mode?: number },
  ): Promise<void>
  rename(from: string, to: string): Promise<void>
}

export interface AuditServiceOptions {
  logPath?: string
  fs?: AuditFileSystem
  platform?: NodeJS.Platform
}

export class NodeAuditFileSystem implements AuditFileSystem {
  async mkdir(dir: string, options: { recursive: boolean; mode?: number }): Promise<void> {
    await mkdir(dir, options)
  }

  async chmod(target: string, mode: number): Promise<void> {
    await chmod(target, mode)
  }

  readFile = readFile
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

  constructor() {
    this.applyOptions({})
  }

  static forTests(options: AuditServiceOptions = {}): AuditService {
    const audit = new AuditService()
    audit.applyOptions(options)
    return audit
  }

  private applyOptions(options: AuditServiceOptions): void {
    this.logPath = options.logPath ?? resolveAuditLogPath()
    this.fs = options.fs ?? new NodeAuditFileSystem()
    this.platform = options.platform ?? process.platform
  }

  async append(input: AuditEventInput): Promise<void> {
    await this.ensureInitialized()
    const task = this.writeChain.then(() => this.appendLine(input))
    this.writeChain = task.catch(() => undefined)
    await task
  }

  async safeAppend(input: AuditEventInput): Promise<void> {
    try {
      await this.append(input)
    } catch {
      this.writeChain = Promise.resolve()
    }
  }

  getChainHead(): { sequence: number; previousHash: string } {
    return { sequence: this.sequence, previousHash: this.previousHash }
  }

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
      await this.fs.chmod(dir, 0o700).catch(() => undefined)
    }

    let raw = ''
    try {
      raw = await this.fs.readFile(this.logPath, 'utf8')
    } catch {
      return
    }

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
        await this.rotateCorruptLog('malformed_line')
        return
      }
      if (event.previous_hash !== expectedPrevious) {
        await this.rotateCorruptLog('broken_chain')
        return
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
        previousHash: event.previous_hash,
      })
      const { hash } = hashAuditEvent(payload, event.previous_hash)
      if (hash !== event.hash || event.sequence <= lastSequence) {
        await this.rotateCorruptLog('hash_mismatch')
        return
      }
      expectedPrevious = event.hash
      lastSequence = event.sequence
    }

    this.previousHash = expectedPrevious
    this.sequence = lastSequence
  }

  private async rotateCorruptLog(reason: string): Promise<void> {
    const rotated = `${this.logPath}.corrupt.${Date.now()}.${reason}`
    try {
      await this.fs.rename(this.logPath, rotated)
    } catch {
      await this.fs.writeFile(this.logPath, '', { encoding: 'utf8', flag: 'w', mode: 0o600 })
    }
    this.sequence = 0
    this.previousHash = AUDIT_GENESIS_HASH
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

    const line = `${JSON.stringify(stored)}\n`
    await this.fs.writeFile(this.logPath, line, {
      encoding: 'utf8',
      flag: 'a',
      mode: 0o600,
    })
    if (this.platform !== 'win32') {
      await this.fs.chmod(this.logPath, 0o600).catch(() => undefined)
    }

    this.sequence = sequence
    this.previousHash = hash
  }
}
