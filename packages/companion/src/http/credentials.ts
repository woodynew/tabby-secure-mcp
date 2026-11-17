import { validateApprovedCommandRules, type ApprovedCommandRule } from '@tabby-secure-mcp/ipc-contract/command-policy'
import { constants, unlinkSync, type Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import type { ApprovalDuration, ClientCommandSet, CommandSetUpdate, DefaultCommandSet, ClientConnectionGrant, ClientFileTransferGrant, ClientCredentialView, ClientIdentity, ClientPermission, CredentialStorePort } from './contracts.js'

export type CredentialFileSystem = Pick<typeof fs, 'mkdir' | 'lstat' | 'open' | 'rename' | 'unlink'> & { unlinkSync: typeof unlinkSync }
type StoredCommandSet = CommandSetUpdate & { profileId: string; profileDigest: string }
type Credential = ClientCredentialView & { token: string; connections: ClientConnectionGrant[]; commandSets: StoredCommandSet[]; fileTransfers: ClientFileTransferGrant[] }
type Snapshot = { records: Map<string, Credential>; defaultCommands: ApprovedCommandRule[]; version: string }
const MAX_BYTES = 64 * 1024
const DAY = 86_400_000
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const none = (): ClientPermission => ({ kind: 'none' })
const error = () => new Error('Credential storage unavailable or invalid')
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT'
const timestamp = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function nameOf(value: string): string {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cs}]/u.test(value)) throw new Error('Invalid client name')
  const name = value.trim()
  if (!name || Array.from(name).length > 80) throw new Error('Invalid client name')
  return name
}

function validPermission(value: unknown): value is ClientPermission {
  if (object(value, ['kind']) && value.kind === 'none') return true
  if (object(value, ['kind', 'approvedAt']) && value.kind === 'permanent') return timestamp(value.approvedAt)
  return object(value, ['kind', 'approvedAt', 'expiresAt']) && value.kind === 'until'
    && timestamp(value.approvedAt) && timestamp(value.expiresAt) && value.expiresAt - value.approvedAt === DAY
}

function validConnections(value: unknown): value is ClientConnectionGrant[] {
  if (!Array.isArray(value)) return false
  const ids = new Set<string>()
  return value.every(grant => {
    if (!object(grant, ['profileId', 'profileDigest', 'updatedAt']) || typeof grant.profileId !== 'string'
      || !grant.profileId || grant.profileId.length > 1024 || /[\p{Cc}\p{Cs}]/u.test(grant.profileId) || ids.has(grant.profileId)
      || typeof grant.profileDigest !== 'string' || !/^[a-f0-9]{64}$/.test(grant.profileDigest) || !timestamp(grant.updatedAt)) return false
    ids.add(grant.profileId)
    return true
  })
}

function commandSets(value: unknown): StoredCommandSet[] {
  if (!Array.isArray(value)) throw error()
  const ids = new Set<string>()
  let count = 0
  return value.map(set => {
    if (!object(set, ['profileId', 'profileDigest', 'inheritDefaults', 'rules'])
      || !validConnections([{ profileId: set.profileId, profileDigest: set.profileDigest, updatedAt: 0 }])
      || ids.has(set.profileId as string) || typeof set.inheritDefaults !== 'boolean') throw error()
    ids.add(set.profileId as string)
    const rules = validateApprovedCommandRules(set.rules)
    count += rules.length
    if (count > 128) throw error()
    return { profileId: set.profileId as string, profileDigest: set.profileDigest as string, inheritDefaults: set.inheritDefaults, rules }
  })
}

function decode(bytes: Buffer): Omit<Snapshot, 'version'> {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!value || typeof value !== 'object') throw error()
    const v = (value as { version?: unknown }).version
    if (!object(value, v === 3 || v === 4 ? ['version', 'credentials', 'defaultCommands'] : ['version', 'credentials'])
      || (v !== 1 && v !== 2 && v !== 3 && v !== 4) || !Array.isArray(value.credentials) || value.credentials.length > 32) throw error()
    const defaults = v === 3 || v === 4 ? validateApprovedCommandRules(value.defaultCommands) : []
    if (defaults.length > 128) throw error()
    const records = new Map<string, Credential>(), tokens = new Set<string>()
    for (const record of value.credentials) {
      const keys = ['id', 'name', 'generation', 'token', 'permission']
      if (v !== 1) keys.push('connections')
      if (v === 3 || v === 4) keys.push('commandSets')
      if (v === 4) keys.push('fileTransfers')
      if (!object(record, keys)
        || typeof record.id !== 'string' || !ID.test(record.id) || records.has(record.id)
        || typeof record.name !== 'string' || nameOf(record.name) !== record.name
        || !timestamp(record.generation) || record.generation < 1
        || typeof record.token !== 'string' || !TOKEN.test(record.token)
        || Buffer.from(record.token, 'base64url').toString('base64url') !== record.token || tokens.has(record.token)
        || !validPermission(record.permission) || (v !== 1 && !validConnections(record.connections))
        || (v === 4 && !validConnections(record.fileTransfers))) throw error()
      records.set(record.id, { id: record.id, name: record.name, generation: record.generation, token: record.token,
        permission: record.permission, connections: v === 1 ? [] : record.connections as ClientConnectionGrant[],
        commandSets: v === 3 || v === 4 ? commandSets(record.commandSets) : [],
        fileTransfers: v === 4 ? record.fileTransfers as ClientFileTransferGrant[] : [] })
      tokens.add(record.token)
    }
    return { records, defaultCommands: defaults }
  } catch { throw error() } // JSON parser diagnostics may contain the bearer token.
}

export class CredentialStore implements CredentialStorePort {
  private readonly fs: CredentialFileSystem
  private readonly now: () => number
  private readonly filePath: string
  private readonly pendingPath: string
  private pending?: { dev: number; ino: number }
  private committedVersion: string | null = null
  private pendingWrite?: { before: string | null; after: string }
  private stale = false
  private records = new Map<string, Credential>()
  private defaultCommands: ApprovedCommandRule[] = []
  private commandVersion = 0
  private pendingDefaults?: number
  private readonly pendingCommandDigests = new Map<string, Map<string, string>>()
  private readonly pendingCommandSets = new Map<string, Map<string, number>>()
  private fileVersion = 0
  private readonly pendingFileTransfers = new Map<string, Map<string, number>>()
  private queue: Promise<unknown> = Promise.resolve()
  private loaded = false
  private revision = 0
  private readonly denied = new Map<string, number>()
  private readonly unpersisted = new Map<string, number>()
  private readonly permissionUpdates = new Map<string, number>()
  private readonly invalidPermissions = new Set<string>()
  private readonly invalidated = new Set<(id: string) => void>()
  private readonly changed = new Set<() => void>()
  private readonly highWater = new Map<string, number>()
  private readonly sessionPermissions = new Map<string, number>()
  private readonly connectionRevisions = new Map<string, number>()
  private readonly pendingConnections = new Map<string, Map<string, number>>()

  constructor(filePath: string, options: { now?: () => number; fs?: Partial<CredentialFileSystem> } = {}) {
    this.filePath = path.resolve(filePath)
    this.pendingPath = `${this.filePath}.pending`
    this.now = options.now ?? Date.now
    this.fs = { ...fs, unlinkSync, ...options.fs }
  }

  get hasUnpersistedRevocations(): boolean { return this.unpersisted.size > 0 || this.permissionUpdates.size > 0 || this.pendingConnections.size > 0 || this.pendingDefaults !== undefined || this.pendingCommandSets.size > 0 || this.pendingFileTransfers.size > 0 }

  load(): Promise<void> {
    return this.serial(async () => {
      if (this.stale) throw error()
      if (this.loaded) return
      await this.directory()
      await this.pendingStat()
      if (this.pending) await this.persist(new Map(this.records))
      else {
        const snapshot = await this.read(true)
        if (snapshot) {
          this.records = snapshot.records
          this.defaultCommands = snapshot.defaultCommands
          this.committedVersion = snapshot.version
        }
        else await this.persist(new Map())
      }
      this.loaded = true
      for (const id of this.records.keys()) this.permission(id)
      this.notify()
    })
  }

  list(): ClientCredentialView[] {
    return [...this.records.values()].map(record => ({ ...this.identity(record), permission: this.permission(record.id) }))
  }

  create(name: string): Promise<ClientCredentialView> {
    return this.serial(async () => {
      this.requireLoaded()
      name = nameOf(name)
      const candidate = new Map(this.records)
      for (const [id, revision] of this.denied) if (this.permissionUpdates.get(id) !== revision) candidate.delete(id)
      if (candidate.size >= 32) throw new Error('Client credential limit reached')
      const record: Credential = { id: randomUUID(), name, generation: 1, token: randomBytes(32).toString('base64url'), permission: none(), connections: [], commandSets: [], fileTransfers: [] }
      candidate.set(record.id, record)
      await this.persist(candidate)
      return { ...this.identity(record), permission: none() }
    })
  }

  rename(id: string, name: string): Promise<void> {
    return this.serial(async () => {
      const record = this.active(id)
      const candidate = new Map(this.records)
      candidate.set(id, { ...record, name: nameOf(name) })
      await this.persist(candidate)
      this.active(id, record.generation)
    })
  }

  reset(id: string): Promise<void> {
    let record: Credential, revision: number
    try {
      this.requireLoaded()
      record = this.records.get(id)!
      if (!record || record.generation >= Number.MAX_SAFE_INTEGER) throw error()
      revision = this.invalidate(id)
    } catch (e) { return Promise.reject(e) }
    return this.serial(async () => {
      if (this.denied.get(id) !== revision) throw new Error('Client credential changed')
      const candidate = new Map(this.records)
      candidate.set(id, { ...record, generation: record.generation + 1, token: randomBytes(32).toString('base64url'), permission: none(), connections: [], commandSets: [], fileTransfers: [] })
      await this.persist(candidate, { id, revision })
      if (this.denied.get(id) !== revision) throw new Error('Client credential changed')
      this.denied.delete(id)
      this.invalidPermissions.delete(id)
      this.highWater.delete(id)
      this.notify()
    })
  }

  revoke(id: string): Promise<void> {
    let revision: number
    try {
      this.requireLoaded()
      if (!this.records.has(id)) throw error()
      revision = this.invalidate(id)
    } catch (e) { return Promise.reject(e) }
    return this.serial(async () => {
      const candidate = new Map(this.records)
      candidate.delete(id)
      await this.persist(candidate)
      if (this.denied.get(id) === revision) this.denied.delete(id)
      this.invalidPermissions.delete(id)
      this.highWater.delete(id)
    })
  }

  setPermission(id: string, generation: number, duration: ApprovalDuration | 'none'): Promise<void> {
    let revision: number
    let token: string
    const approvedAt = this.now()
    try {
      this.requireLoaded()
      const record = this.records.get(id)
      if (!record || !timestamp(generation) || generation < 1 || record.generation !== generation
        || generation >= Number.MAX_SAFE_INTEGER || !['none', 'session', '24h', 'permanent'].includes(duration)
        || !timestamp(approvedAt) || (duration === '24h' && !timestamp(approvedAt + DAY))) throw error()
      token = record.token
      revision = this.invalidate(id, true)
    } catch (e) { return Promise.reject(e) }
    return this.serial(async () => {
      const record = this.records.get(id)
      if (!record || record.token !== token || record.generation >= Number.MAX_SAFE_INTEGER || this.denied.get(id) !== revision) throw error()
      // An older, superseded edit may commit a generation while this edit waits in the queue.
      const nextGeneration = record.generation + 1
      const permission: ClientPermission = duration === 'permanent' ? { kind: 'permanent', approvedAt }
        : duration === '24h' ? { kind: 'until', approvedAt, expiresAt: approvedAt + DAY } : none()
      const candidate = new Map(this.records)
      candidate.set(id, { ...record, generation: nextGeneration, permission })
      await this.persist(candidate, { id, revision })
      if (this.denied.get(id) !== revision) throw error()
      this.denied.delete(id)
      this.permissionUpdates.delete(id)
      this.invalidPermissions.delete(id)
      this.highWater.set(id, approvedAt)
      // Session approval is consumed by one connection and never enters the credential file.
      if (duration === 'session') this.sessionPermissions.set(id, nextGeneration)
      this.notify()
    })
  }

  consumeSessionPermission(id: string, generation: number): boolean {
    if (!this.loaded || this.denied.has(id) || this.records.get(id)?.generation !== generation
      || this.sessionPermissions.get(id) !== generation) return false
    this.sessionPermissions.delete(id)
    this.notify()
    return true
  }

  tokenFor(id: string): string { return this.active(id).token }

  connectionGrants(client: ClientIdentity): ClientConnectionGrant[] {
    if (!this.isCurrent(client)) return []
    const pending = this.pendingConnections.get(client.id)
    return this.records.get(client.id)!.connections.filter(grant => !pending?.has(grant.profileId)).map(grant => ({ ...grant }))
  }

  connectionRevision(client: ClientIdentity): number {
    this.active(client.id, client.generation)
    return this.connectionRevisions.get(client.id) ?? 0
  }

  hasConnectionPermission(client: ClientIdentity, profileId: string, profileDigest: string): boolean {
    return this.connectionGrants(client).some(grant => grant.profileId === profileId && grant.profileDigest === profileDigest)
  }

  setConnectionPermission(client: ClientIdentity, profileId: string, profileDigest: string | null, expectedRevision?: number, stillCurrent?: () => boolean): Promise<void> {
    client = { ...client }
    let revision: number
    const valid = () => {
      try { return this.connectionRevisions.get(client.id) === revision && this.isCurrent(client) && (!stillCurrent || stillCurrent()) }
      catch { return false }
    }
    const updatedAt = this.now()
    try {
      const current = this.connectionRevision(client)
      if ((expectedRevision !== undefined && expectedRevision !== current) || (stillCurrent && !stillCurrent())
        || !validConnections([{ profileId, profileDigest: profileDigest ?? '0'.repeat(64), updatedAt }])) throw error()
      revision = ++this.revision
      const old = this.records.get(client.id)!.connections.find(grant => grant.profileId === profileId)
      const oldFile = this.records.get(client.id)!.fileTransfers.find(grant => grant.profileId === profileId)
      if (profileDigest === null || (old && old.profileDigest !== profileDigest) || (oldFile && oldFile.profileDigest !== profileDigest)) {
        const pending = this.pendingFileTransfers.get(client.id) ?? new Map<string, number>()
        pending.set(profileId, ++this.fileVersion)
        this.pendingFileTransfers.set(client.id, pending)
      }
      if (profileDigest === null || (old && old.profileDigest !== profileDigest)) {
        const pending = this.pendingCommandSets.get(client.id) ?? new Map<string, number>()
        pending.set(profileId, ++this.commandVersion)
        this.pendingCommandSets.set(client.id, pending)
        const digests = this.pendingCommandDigests.get(client.id) ?? new Map<string, string>()
        digests.set(profileId, profileDigest ?? old?.profileDigest ?? '0'.repeat(64))
        this.pendingCommandDigests.set(client.id, digests)
      }
      this.connectionRevisions.set(client.id, revision)
      const pending = this.pendingConnections.get(client.id) ?? new Map<string, number>()
      pending.set(profileId, revision)
      this.pendingConnections.set(client.id, pending)
      this.notify()
    } catch (e) { return Promise.reject(e) }
    return this.serial(async () => {
      const record = this.active(client.id, client.generation)
      if (!valid()) throw error()
      const connections = record.connections.filter(grant => grant.profileId !== profileId)
      if (profileDigest !== null) connections.push({ profileId, profileDigest, updatedAt })
      const candidate = new Map(this.records)
      candidate.set(client.id, { ...record, connections })
      await this.persist(candidate, undefined, { id: client.id, profileId, revision, current: valid })
      this.active(client.id, client.generation)
      if (this.connectionRevisions.get(client.id) !== revision) throw error()
    })
  }

  fileTransferRevision(): number { return this.fileVersion }

  hasFileTransferPermission(client: ClientIdentity, profileId: string, profileDigest: string): boolean {
    if (!this.isCurrent(client) || this.pendingFileTransfers.get(client.id)?.has(profileId)
      || this.pendingConnections.get(client.id)?.has(profileId)) return false
    const record = this.records.get(client.id)!
    const connection = record.connections.find(grant => grant.profileId === profileId)
    if (connection && connection.profileDigest !== profileDigest) return false
    return record.fileTransfers.some(grant => grant.profileId === profileId && grant.profileDigest === profileDigest)
  }

  setFileTransferPermission(client: ClientIdentity, profileId: string, profileDigest: string | null, expectedRevision: number, stillCurrent?: () => boolean): Promise<void> {
    const identity = { ...client }
    let revision: number, connectionRevision: number
    const updatedAt = this.now()
    const current = () => {
      try { return this.fileVersion === revision && this.isCurrent(identity)
        && this.connectionRevision(identity) === connectionRevision && (!stillCurrent || stillCurrent()) }
      catch { return false }
    }
    try {
      const record = this.active(identity.id, identity.generation)
      connectionRevision = this.connectionRevision(identity)
      if (expectedRevision !== this.fileVersion || (stillCurrent && !stillCurrent())
        || !validConnections([{ profileId, profileDigest: profileDigest ?? '0'.repeat(64), updatedAt }])) throw error()
      const fileTransfers = record.fileTransfers.filter(grant => grant.profileId !== profileId)
      if (profileDigest !== null) fileTransfers.push({ profileId, profileDigest, updatedAt })
      const candidate = new Map(this.records)
      candidate.set(identity.id, { ...record, fileTransfers })
      this.checkCommandSize(candidate, this.defaultCommandSet().rules)
      revision = ++this.fileVersion
      const pending = this.pendingFileTransfers.get(identity.id) ?? new Map<string, number>()
      pending.set(profileId, revision)
      this.pendingFileTransfers.set(identity.id, pending)
      this.notify()
    } catch (e) { return Promise.reject(e) }
    return this.serial(async () => {
      if (!current()) throw error()
      const record = this.active(identity.id, identity.generation)
      const fileTransfers = record.fileTransfers.filter(grant => grant.profileId !== profileId)
      if (profileDigest !== null) fileTransfers.push({ profileId, profileDigest, updatedAt })
      const candidate = new Map(this.records)
      candidate.set(identity.id, { ...record, fileTransfers })
      await this.persist(candidate, undefined, undefined, undefined, { id: identity.id, profileId, revision, current })
      if (!current()) throw error()
    })
  }

  commandRevision(): number { return this.commandVersion }

  defaultCommandSet(): DefaultCommandSet {
    this.requireLoaded()
    return { rules: structuredClone(this.pendingDefaults === undefined ? this.defaultCommands : []), revision: this.commandVersion }
  }

  commandSet(client: ClientIdentity, profileId: string, profileDigest: string): ClientCommandSet {
    const record = this.active(client.id, client.generation)
    if (!validConnections([{ profileId, profileDigest, updatedAt: 0 }])) throw error()
    const local = record.commandSets.find(set => set.profileId === profileId)
    const connection = record.connections.find(grant => grant.profileId === profileId)
    const stale = !!((local && local.profileDigest !== profileDigest) || (connection && connection.profileDigest !== profileDigest))
    const blocked = stale || this.pendingCommandSets.get(client.id)?.has(profileId)
    const inheritDefaults = !blocked && (local?.inheritDefaults ?? true)
    return { profileId, profileDigest, inheritDefaults, stale, revision: this.commandVersion,
      rules: structuredClone(blocked ? [] : local?.rules ?? []),
      defaultRules: inheritDefaults ? this.defaultCommandSet().rules : [] }
  }

  setDefaultCommandSet(rules: ApprovedCommandRule[], expectedRevision: number): Promise<void> {
    let captured: ApprovedCommandRule[], revision: number
    try {
      this.requireLoaded()
      if (expectedRevision !== this.commandVersion) throw error()
      captured = structuredClone(validateApprovedCommandRules(rules))
      if (captured.length > 128) throw error()
      this.checkCommandSize(this.records, captured)
      revision = ++this.commandVersion
      this.pendingDefaults = revision
      this.notify()
    } catch (e) { return Promise.reject(e) }
    return this.serial(async () => {
      if (this.commandVersion !== revision) throw error()
      await this.persist(new Map(this.records), undefined, undefined, { revision, defaults: captured, current: () => this.commandVersion === revision })
      if (this.commandVersion !== revision) throw error()
    })
  }

  setCommandSet(client: ClientIdentity, profileId: string, profileDigest: string, update: CommandSetUpdate, expectedRevision: number, stillCurrent?: () => boolean, beforeCommit?: () => Promise<void>): Promise<void> {
    let captured: StoredCommandSet, revision: number
    // Capture identity too: UI objects must not retarget a queued grant.
    const identity = { ...client }
    const current = () => {
      try { return this.commandVersion === revision && this.isCurrent(identity) && (!stillCurrent || stillCurrent()) }
      catch { return false }
    }
    try {
      const record = this.active(identity.id, identity.generation)
      if (expectedRevision !== this.commandVersion || (stillCurrent && !stillCurrent())
        || !object(update, ['inheritDefaults', 'rules']) || typeof update.inheritDefaults !== 'boolean'
        || !validConnections([{ profileId, profileDigest, updatedAt: 0 }])) throw error()
      captured = { profileId, profileDigest, inheritDefaults: update.inheritDefaults, rules: structuredClone(validateApprovedCommandRules(update.rules)) }
      const sets = commandSets([...record.commandSets.filter(set => set.profileId !== profileId), captured])
      const candidate = new Map(this.records)
      candidate.set(identity.id, { ...record, commandSets: sets })
      this.checkCommandSize(candidate, this.defaultCommandSet().rules)
      revision = ++this.commandVersion
      const pending = this.pendingCommandSets.get(identity.id) ?? new Map<string, number>()
      pending.set(profileId, revision)
      this.pendingCommandSets.set(identity.id, pending)
      const digests = this.pendingCommandDigests.get(identity.id) ?? new Map<string, string>()
      digests.set(profileId, profileDigest)
      this.pendingCommandDigests.set(identity.id, digests)
      this.notify()
    } catch (e) { return Promise.reject(e) }
    return this.serial(async () => {
      if (!current()) throw error()
      const record = this.active(identity.id, identity.generation)
      const candidate = new Map(this.records)
      candidate.set(identity.id, { ...record, commandSets: commandSets([...record.commandSets.filter(set => set.profileId !== profileId), captured]) })
      await this.persist(candidate, undefined, undefined, { revision, id: identity.id, profileId, current, beforeCommit })
      // Request cancellation after the atomic commit is compensated by the caller using this owned revision.
      if (this.commandVersion !== revision || !this.isCurrent(identity)) throw error()
    })
  }

  private checkCommandSize(records: Map<string, Credential>, defaults: ApprovedCommandRule[]): void {
    if (Buffer.byteLength(JSON.stringify({ version: 4, defaultCommands: defaults, credentials: [...records.values()] })) > MAX_BYTES) throw error()
  }

  authenticate(token: string): ClientIdentity | undefined {
    if (!this.loaded || typeof token !== 'string' || !TOKEN.test(token)) return undefined
    const supplied = Buffer.from(token)
    let match: ClientIdentity | undefined
    for (const record of this.records.values()) {
      if (timingSafeEqual(supplied, Buffer.from(record.token)) && !this.denied.has(record.id)) match = this.identity(record)
    }
    return match
  }

  isCurrent(client: ClientIdentity): boolean {
    const record = this.records.get(client.id)
    return this.loaded && !!record && !this.denied.has(client.id) && record.generation === client.generation
  }

  permission(id: string): ClientPermission {
    const record = this.records.get(id)
    if (!this.loaded || !record || this.denied.has(id)) return none()
    if (this.sessionPermissions.get(id) === record.generation) return { kind: 'session' }
    const permission = record.permission
    if (permission.kind === 'until') {
      const now = this.now()
      const wasInvalid = this.invalidPermissions.has(id)
      if (!timestamp(now) || now < (this.highWater.get(id) ?? 0) || now < permission.approvedAt || now >= permission.expiresAt) this.invalidPermissions.add(id)
      if (timestamp(now)) this.highWater.set(id, Math.max(this.highWater.get(id) ?? 0, now))
      if (!wasInvalid && this.invalidPermissions.has(id)) this.notify()
      if (this.invalidPermissions.has(id)) return none()
    }
    return { ...permission }
  }

  grant(id: string, generation: number, duration: '24h' | 'permanent'): Promise<void> {
    const approvedAt = this.now()
    return this.serial(async () => {
      if (!timestamp(generation) || generation < 1) throw new Error('Client credential changed')
      const record = this.active(id, generation)
      if (!timestamp(approvedAt) || (duration !== '24h' && duration !== 'permanent')
        || (duration === '24h' && !timestamp(approvedAt + DAY))) throw error()
      const permission: ClientPermission = duration === 'permanent' ? { kind: 'permanent', approvedAt }
        : { kind: 'until', approvedAt, expiresAt: approvedAt + DAY }
      const candidate = new Map(this.records)
      candidate.set(id, { ...record, permission })
      await this.persist(candidate)
      this.active(id, generation)
      this.invalidPermissions.delete(id)
      this.sessionPermissions.delete(id)
      this.highWater.set(id, approvedAt)
      this.notify()
    })
  }

  onInvalidated(listener: (id: string) => void): () => void {
    this.invalidated.add(listener)
    return () => { this.invalidated.delete(listener) }
  }

  onChange(listener: () => void): () => void {
    this.changed.add(listener)
    return () => { this.changed.delete(listener) }
  }

  private identity(record: Credential): ClientIdentity { return { id: record.id, name: record.name, generation: record.generation } }
  private requireLoaded(): void { if (!this.loaded) throw error() }
  private active(id: string, generation?: number): Credential {
    this.requireLoaded()
    const record = this.records.get(id)
    if (!record || this.denied.has(id) || (generation !== undefined && generation !== record.generation)) throw new Error('Client credential changed')
    return record
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => undefined)
    return result
  }
  private invalidate(id: string, permissionUpdate = false): number {
    const revision = ++this.revision
    this.commandVersion++
    this.fileVersion++
    this.denied.set(id, revision)
    this.unpersisted.set(id, revision)
    if (permissionUpdate) this.permissionUpdates.set(id, revision)
    else this.permissionUpdates.delete(id)
    this.sessionPermissions.delete(id)
    for (const listener of this.invalidated) { try { listener(id) } catch { /* One observer cannot prevent other sessions being aborted. */ } }
    this.notify()
    return revision
  }
  private notify(): void {
    for (const listener of this.changed) { try { listener() } catch { /* UI observers do not own persistence. */ } }
  }

  private safe(stat: Stats, directory: boolean): void {
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
      || (process.platform !== 'win32' && ((stat.mode & 0o7777) !== (directory ? 0o700 : 0o600)
        || (process.getuid && stat.uid !== process.getuid())))) throw error()
    if (!directory && stat.size > MAX_BYTES) throw error()
  }

  private async directory(): Promise<Stats> {
    const parent = path.dirname(this.filePath)
    const root = path.parse(parent).root
    let current = root
    for (const part of parent.slice(root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part)
      let stat: Stats
      try { stat = await this.fs.lstat(current) }
      catch (e) {
        if (!missing(e)) throw error()
        try { await this.fs.mkdir(current, { mode: 0o700 }) }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw error() }
        stat = await this.fs.lstat(current)
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw error()
    }
    const stat = await this.fs.lstat(parent)
    this.safe(stat, true)
    return stat
  }

  private async fileStat(): Promise<Stats | undefined> {
    try { const stat = await this.fs.lstat(this.filePath); this.safe(stat, false); return stat }
    catch (e) { if (missing(e)) return undefined; throw error() }
  }

  private async read(committed = false): Promise<Snapshot | undefined> {
    const before = await this.fileStat()
    if (!before) return undefined
    const handle = await this.fs.open(this.filePath, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
    try {
      const stat = await handle.stat()
      this.safe(stat, false)
      if (stat.dev !== before.dev || stat.ino !== before.ino) throw error()
      const bytes = Buffer.alloc(MAX_BYTES + 1)
      let size = 0
      while (size < bytes.length) {
        const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size)
        if (!bytesRead) break
        size += bytesRead
      }
      if (size > MAX_BYTES) throw error()
      const snapshot = decode(bytes.subarray(0, size))
      if (committed) {
        await this.pendingStat()
        const current = await this.fileStat()
        if (current?.dev !== stat.dev || current?.ino !== stat.ino) throw error()
      }
      return { ...snapshot, version: createHash('sha256').update(bytes.subarray(0, size)).digest('hex') }
    } finally { await handle.close() }
  }

  private async pendingStat(): Promise<Stats | undefined> {
    let stat: Stats
    try { stat = await this.fs.lstat(this.pendingPath) }
    catch (e) {
      if (missing(e) && !this.pending) return undefined
      throw error()
    }
    this.safe(stat, false)
    if (!this.pending || stat.dev !== this.pending.dev || stat.ino !== this.pending.ino || stat.size !== 0) throw error()
    return stat
  }

  private async syncDirectory(directory: Stats): Promise<void> {
    if (process.platform === 'win32') return
    const parent = await this.fs.open(path.dirname(this.filePath), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await parent.stat()
      this.safe(stat, true)
      if (stat.dev !== directory.dev || stat.ino !== directory.ino) throw error()
      await parent.sync()
    } finally { await parent.close() }
  }

  private async preparePending(directory: Stats): Promise<void> {
    const existing = await this.pendingStat()
    const handle = await this.fs.open(this.pendingPath, constants.O_WRONLY
      | (existing ? 0 : constants.O_CREAT | constants.O_EXCL)
      | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW), 0o600)
    try {
      const stat = await handle.stat()
      this.safe(stat, false)
      if (stat.size !== 0 || (existing && (stat.dev !== existing.dev || stat.ino !== existing.ino))) throw error()
      this.pending = { dev: stat.dev, ino: stat.ino }
      await handle.sync()
    } finally { await handle.close() }
    // A durable, secret-free marker blocks reload before any data replacement.
    await this.syncDirectory(directory)
  }

  private async releasePending(): Promise<void> {
    await this.pendingStat()
    await this.fs.unlink(this.pendingPath)
    this.pending = undefined
    this.pendingWrite = undefined
  }

  private async persist(candidate: Map<string, Credential>, reset?: { id: string; revision: number }, connectionUpdate?: { id: string; profileId: string; revision: number; current?: () => boolean }, commandUpdate?: { revision: number; id?: string; profileId?: string; defaults?: ApprovedCommandRule[]; current?: () => boolean; beforeCommit?: () => Promise<void> }, fileUpdate?: { id: string; profileId: string; revision: number; current: () => boolean }): Promise<void> {
    if (this.stale) throw error()
    const current = () => {
      try { return (!commandUpdate?.current || commandUpdate.current()) && (!connectionUpdate?.current || connectionUpdate.current()) && (!fileUpdate || fileUpdate.current()) }
      catch { return false }
    }
    for (const [id, revision] of this.denied) {
      if (reset?.id === id && reset.revision === revision) continue
      const record = candidate.get(id)
      // Unrelated saves may clear a failed edit's old grants, but must retain its token for retry.
      if (record && this.permissionUpdates.get(id) === revision) candidate.set(id, { ...record, permission: none() })
      else candidate.delete(id)
    }
    const invalidations = new Map(this.unpersisted)
    const connectionInvalidations = new Map([...this.pendingConnections].map(([id, pending]) => [id, new Map(pending)]))
    for (const [id, pending] of connectionInvalidations) {
      const record = candidate.get(id)
      if (record) candidate.set(id, { ...record, connections: record.connections.filter(grant => !pending.has(grant.profileId)
        || (connectionUpdate?.id === id && connectionUpdate.profileId === grant.profileId && connectionUpdate.revision === pending.get(grant.profileId))) })
    }
    const commandInvalidations = new Map([...this.pendingCommandSets].map(([id, pending]) => [id, new Map(pending)]))
    for (const [id, pending] of commandInvalidations) {
      const record = candidate.get(id)
      if (record) candidate.set(id, { ...record, commandSets: record.commandSets.map(set => pending.has(set.profileId)
        && !(commandUpdate?.id === id && commandUpdate.profileId === set.profileId && commandUpdate.revision === pending.get(set.profileId))
        ? { ...set, inheritDefaults: false, rules: [] } : set) })
    }
    // Persist explicit empty sets too: an absent set would re-enable inherited defaults.
    for (const [id, pending] of commandInvalidations) {
      const record = candidate.get(id), committed = this.records.get(id)
      if (!record || this.denied.has(id)) continue
      for (const profileId of pending.keys()) {
        if (!record.commandSets.some(set => set.profileId === profileId)) {
          const old = committed?.commandSets.find(set => set.profileId === profileId)
          const profileDigest = this.pendingCommandDigests.get(id)?.get(profileId) ?? old?.profileDigest
          if (profileDigest) record.commandSets = [...record.commandSets, { profileId, profileDigest, inheritDefaults: false, rules: [] }]
        }
      }
    }
    const defaultsRevision = this.pendingDefaults
    const fileInvalidations = new Map([...this.pendingFileTransfers].map(([id, pending]) => [id, new Map(pending)]))
    for (const [id, pending] of fileInvalidations) {
      const record = candidate.get(id)
      if (record) candidate.set(id, { ...record, fileTransfers: record.fileTransfers.filter(grant => !pending.has(grant.profileId)
        || (fileUpdate?.id === id && fileUpdate.profileId === grant.profileId && fileUpdate.revision === pending.get(grant.profileId))) })
    }
    const defaults = commandUpdate?.defaults ?? (defaultsRevision === undefined ? this.defaultCommands : [])
    const bytes = Buffer.from(JSON.stringify({ version: 4, defaultCommands: defaults, credentials: [...candidate.values()] }))
    if (bytes.length > MAX_BYTES) throw error()
    const version = createHash('sha256').update(bytes).digest('hex')
    const temporary = path.join(path.dirname(this.filePath), `.credentials-${randomUUID()}.tmp`)
    let handle: fs.FileHandle | undefined
    let created = false, renamed = false
    try {
      const directory = await this.directory()
      await this.pendingStat()
      await this.read() // Refuse to overwrite damaged evidence, including after initial load.
      const before = await this.fileStat()
      handle = await this.fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW), 0o600)
      created = true
      this.safe(await handle.stat(), false)
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.close()
      handle = undefined
      const afterDirectory = await this.directory(), after = await this.fileStat()
      if (directory.dev !== afterDirectory.dev || directory.ino !== afterDirectory.ino
        || before?.dev !== after?.dev || before?.ino !== after?.ino) throw error()
      if (!current()) throw error()
      await this.preparePending(directory)
      const currentVersion = (await this.read())?.version ?? null
      // Compare under the exclusive marker; an earlier check cannot protect sequential writers.
      if (currentVersion !== this.committedVersion && currentVersion !== this.pendingWrite?.before && currentVersion !== this.pendingWrite?.after) {
        this.stale = true
        this.loaded = false
        for (const id of this.records.keys()) {
          for (const listener of this.invalidated) { try { listener(id) } catch {} }
        }
        this.notify()
        if (!this.pendingWrite) await this.releasePending()
        throw error()
      }
      // Only owned retry evidence, never a committed authorization baseline.
      this.pendingWrite = { before: currentVersion, after: version }
      await this.fs.rename(temporary, this.filePath)
      renamed = true
      await this.syncDirectory(directory)
      if (!current()) throw error()
      // Request-scoped approval stays guarded while its operation runs; an aborted operation cannot publish it.
      await commandUpdate?.beforeCommit?.()
      await this.pendingStat()
      if (!current()) throw error()
      // This short synchronous commit cannot yield to cancellation after removing the only durable guard.
      this.fs.unlinkSync(this.pendingPath)
      this.pending = undefined
      this.pendingWrite = undefined
    } catch {
      // Keep pending evidence; cleanup errors cannot turn the failed transaction into success.
      try { if (handle) await handle.close() } catch {}
      try { if (created && !renamed) await this.fs.unlink(temporary) } catch {}
      throw error()
    }
    // A synchronous invalidation during the write survives this older transaction.
    this.committedVersion = version
    this.records = candidate
    this.defaultCommands = defaults
    for (const [id, pending] of fileInvalidations) {
      const current = this.pendingFileTransfers.get(id)
      for (const [profileId, revision] of pending) if (current?.get(profileId) === revision) current.delete(profileId)
      if (!current?.size) this.pendingFileTransfers.delete(id)
    }
    if (this.pendingDefaults === defaultsRevision) this.pendingDefaults = undefined
    for (const [id, pending] of commandInvalidations) {
      const current = this.pendingCommandSets.get(id)
      for (const [profileId, revision] of pending) if (current?.get(profileId) === revision) current.delete(profileId)
      if (!current?.size) {
        this.pendingCommandSets.delete(id)
        this.pendingCommandDigests.delete(id)
      }
    }
    for (const [id, revision] of invalidations) {
      if (this.unpersisted.get(id) === revision) this.unpersisted.delete(id)
    }
    for (const [id, pending] of connectionInvalidations) {
      const current = this.pendingConnections.get(id)
      for (const [profileId, revision] of pending) if (current?.get(profileId) === revision) current.delete(profileId)
      if (!current?.size) this.pendingConnections.delete(id)
    }
    this.notify()
  }
}
