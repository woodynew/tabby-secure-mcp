import { Component, Inject, NgZone, OnDestroy, OnInit, Optional } from '@angular/core'
import { ConfigService, ProfilesService, type PartialProfile, type Profile } from 'tabby-core'

import { stableProfileDigest } from '../approval/profile-security-snapshot'
import { resolveEffectiveProfile } from '../profiles/effective-profile'
import { isGrantedOperationTier, type GrantedOperationTier } from '../authorization/operation-tier-policy'
import { PermanentAuthorizationStore } from '../authorization/permanent-authorization-store'
import {
  persistAuthorizedSshProfileIds,
  readAuthorizedSshProfileIds,
  hasUnpersistedRevocations,
} from '../config/secure-mcp-config'
import {
  buildSecureMcpSettingsRows,
  SETTINGS_OPERATION_TIER_OPTIONS,
  type SecureMcpSettingsRow,
} from './secure-mcp-settings.view-model'
import { secureMcpSettingsTemplate } from './secure-mcp-settings.template'
import { PluginHttpRuntime } from '../runtime/plugin-http-runtime'
import type { ClientCredentialView } from '@tabby-secure-mcp/companion'

@Component({
  selector: 'secure-mcp-settings',
  template: secureMcpSettingsTemplate,
})
export class SecureMcpSettingsComponent implements OnInit, OnDestroy {
  rows: SecureMcpSettingsRow[] = []
  readonly tierOptions = SETTINGS_OPERATION_TIER_OPTIONS
  loading = true
  saving = false
  error: string | null = null
  private loadedProfiles: PartialProfile<Profile>[] = []
  clientName = ''
  httpPort = 50333
  notice: string | null = null
  private stopUpdates?: () => void
  private stopConfigUpdates?: () => void
  private reloadRevision = 0

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(ProfilesService) private readonly profiles: ProfilesService,
    @Inject(PermanentAuthorizationStore) private readonly authorizations: PermanentAuthorizationStore,
    @Optional() @Inject(PluginHttpRuntime) readonly runtime?: PluginHttpRuntime,
    @Optional() @Inject(NgZone) private readonly zone?: NgZone,
  ) {}

  async ngOnInit(): Promise<void> {
    if (this.runtime) {
      this.httpPort = this.runtime.serverConfig().port
      this.stopUpdates = this.runtime.onChange(() => { this.httpPort = this.runtime!.serverConfig().port })
    }
    const subscription = this.config.changed$?.subscribe(() => { void this.reload(true) })
    if (subscription) this.stopConfigUpdates = () => subscription.unsubscribe()
    await this.reload()
  }

  ngOnDestroy(): void { ++this.reloadRevision; this.stopUpdates?.(); this.stopConfigUpdates?.() }
  private updateView(work: () => void): void { if (this.zone) this.zone.run(work); else work() }
  get canManage(): boolean { return this.runtime?.isMainWindow ?? true }
  get clients(): ClientCredentialView[] { return this.runtime?.credentials.list() ?? [] }
  trackClient(_index: number, client: ClientCredentialView): string { return client.id }
  clientPermission(client: ClientCredentialView): string {
    if (client.permission.kind === 'session') return 'Next connection only — not remembered after reconnect or restart'
    if (client.permission.kind === 'permanent') return 'Permanent — until revoked'
    if (client.permission.kind === 'until') return `Until ${new Date(client.permission.expiresAt).toLocaleString()}`
    if (this.runtime?.sessions().some(session => session.clientId === client.id && session.state === 'approved' && session.duration === 'session')) return 'This session only — reconnect requires approval'
    return 'Not remembered (approval required for a new session)'
  }

  clientPermissionChoice(client: ClientCredentialView): string {
    if (client.permission.kind === 'until') return '24h'
    if (client.permission.kind === 'none' && this.runtime?.sessions().some(session => session.clientId === client.id && session.state === 'approved' && session.duration === 'session')) return 'session'
    return client.permission.kind
  }

  clientConnectionState(client: ClientCredentialView, row: SecureMcpSettingsRow): 'ask' | 'allowed' | 'stale' {
    const grant = this.runtime?.credentials.connectionGrants(client).find(item => item.profileId === row.id)
    if (!grant) return 'ask'
    try {
      const profile = this.loadedProfiles.find(item => item.id === row.id)
      return profile && grant.profileDigest === stableProfileDigest(profile) ? 'allowed' : 'stale'
    } catch { return 'stale' }
  }

  async onChangeClientConnection(client: ClientCredentialView, row: SecureMcpSettingsRow, choice: string): Promise<void> {
    if (!row.selected || (choice !== 'ask' && choice !== 'allowed')) return
    await this.clientAction(async () => {
      const credentials = this.runtime!.credentials
      const revision = credentials.connectionRevision(client)
      let digest: string | null = null
      if (choice === 'allowed') {
        const reviewed = this.loadedProfiles.find(item => item.id === row.id)
        const raw = (await this.profiles.getProfiles({ includeBuiltin: false, clone: true })).find(item => item.id === row.id)
        if (!reviewed || !raw || !readAuthorizedSshProfileIds(this.config.store, this.config).includes(row.id)) throw new Error('profile unavailable')
        digest = stableProfileDigest(resolveEffectiveProfile(raw, this.profiles))
        if (digest !== stableProfileDigest(reviewed)) {
          await this.reload(true)
          throw new Error('profile changed')
        }
      }
      await credentials.setConnectionPermission(client, row.id, digest, revision)
      this.notice = choice === 'allowed'
        ? 'SSH connection permanently allowed for this client and profile. Command operation tiers are unchanged.'
        : 'Connection authorization cleared for this client and profile. Its next connection requires approval.'
    }, 'Connection authorization was not saved. Check the refreshed profile and private storage, then retry. Failed revocations remain denied for this run.')
  }

  private async clientAction(action: () => Promise<unknown>, failure: string): Promise<void> {
    if (!this.canManage || this.saving || !this.runtime) return
    this.saving = true
    this.error = null
    this.notice = null
    try { await action() } catch { this.error = failure } finally { this.updateView(() => { this.saving = false }) }
  }

  async onSaveServer(enabled: boolean): Promise<void> {
    await this.clientAction(() => this.runtime!.setServerConfig(enabled, this.httpPort), 'MCP service settings could not be saved or started. Review the service error before restarting.')
  }

  async onCreateClient(): Promise<void> {
    await this.clientAction(async () => {
      await this.runtime!.credentials.create(this.clientName)
      this.clientName = ''
    }, 'Could not create the credential. Use a name of 1–80 characters without controls and check private storage.')
  }

  async onRenameClient(id: string, name: string, input?: HTMLInputElement): Promise<void> {
    await this.clientAction(() => this.runtime!.credentials.rename(id, name), 'Could not save the credential name. Use 1–80 characters without controls.')
    const saved = this.runtime?.credentials.list().find(client => client.id === id)
    if (input && saved) input.value = saved.name
  }

  async onResetClient(id: string): Promise<void> {
    await this.clientAction(() => this.runtime!.credentials.reset(id), 'Credential reset did not persist. The client is denied for this run; retry before restarting.')
  }

  async onRevokeClient(id: string): Promise<void> {
    await this.clientAction(() => this.runtime!.credentials.revoke(id), 'Revocation did not persist. The client is denied for this run; retry before restarting.')
  }

  async onChangeClientPermission(id: string, generation: number, duration: string): Promise<void> {
    if (duration !== 'none' && duration !== 'session' && duration !== '24h' && duration !== 'permanent') return
    await this.clientAction(async () => {
      await this.runtime!.credentials.setPermission(id, generation, duration)
      this.notice = duration === 'session'
        ? 'Token unchanged. This client was disconnected; its next connection is approved for that session only (up to 24 hours). Reconnect or restart requires approval again.'
        : duration === 'none'
          ? 'Authorization cleared. Token unchanged. This client was disconnected and must be approved on its next connection.'
          : 'Authorization updated. Token unchanged. This client was disconnected; reconnect to use the new permission lifetime.'
    }, 'Authorization update did not persist. The client is denied for this run; retry before restarting.')
  }

  async onCopyClient(id: string): Promise<void> {
    await this.clientAction(async () => {
      const value = { mcpServers: { 'tabby-secure-mcp': {
        url: `http://127.0.0.1:${this.runtime!.serverConfig().port}/mcp`,
        headers: { Authorization: `Bearer ${this.runtime!.credentials.tokenFor(id)}` },
      } } }
      await navigator.clipboard.writeText(JSON.stringify(value, null, 2))
      this.notice = 'MCP configuration copied. It contains this client’s private access credential. Configure your AI tool’s Streamable HTTP connection with this URL and Authorization header.'
    }, 'Could not copy the configuration to the clipboard.')
  }

  async reload(preserveError = false): Promise<void> {
    const revision = ++this.reloadRevision
    this.loading = true
    if (!preserveError) this.error = null
    try {
      const loadedProfiles = (await this.profiles.getProfiles({ includeBuiltin: false, clone: true }))
        .map(profile => resolveEffectiveProfile(profile, this.profiles))
      if (revision !== this.reloadRevision) return
      this.loadedProfiles = loadedProfiles
      const authorizedIds = readAuthorizedSshProfileIds(this.config.store, this.config)
      this.rows = buildSecureMcpSettingsRows(
        this.loadedProfiles,
        authorizedIds,
        this.authorizations.list(),
      )
      if (!this.error && hasUnpersistedRevocations(this.config)) this.error = 'Some revocations are only applied for this run. Retry saving before restarting Tabby.'
    } catch {
      if (revision !== this.reloadRevision) return
      this.error = 'Failed to load SSH profiles.'
      this.rows = []
      this.loadedProfiles = []
    } finally {
      if (revision === this.reloadRevision) this.updateView(() => { this.loading = false })
    }
  }

  async onToggle(row: SecureMcpSettingsRow, selected: boolean): Promise<void> {
    if (!this.canManage) return
    if (this.saving && selected) {
      return
    }
    const previousSelected = row.selected
    this.saving = true
    this.error = null
    try {
      const current = readAuthorizedSshProfileIds(this.config.store, this.config)
      const next = selected ? [...current, row.id] : current.filter(id => id !== row.id)
      const saved = await persistAuthorizedSshProfileIds(this.config, next)
      const persisted = readAuthorizedSshProfileIds(this.config.store, this.config)
      if (JSON.stringify(saved) !== JSON.stringify(persisted)) {
        throw new Error('authorized profile whitelist did not persist in Tabby config store')
      }
      this.rows = buildSecureMcpSettingsRows(
        this.loadedProfiles,
        persisted,
        this.authorizations.list(),
      )
    } catch {
      row.selected = previousSelected
      this.error =
        'Failed to save authorized profile selection to Tabby config. Changes were not persisted.'
      await this.reload(true)
    } finally {
      this.updateView(() => { this.saving = false })
    }
  }

  async onTierChange(row: SecureMcpSettingsRow, rawTier: string): Promise<void> {
    if (!this.canManage) return
    if (!isGrantedOperationTier(rawTier) || !row.selected || this.saving) {
      return
    }
    if (row.grantStale) {
      this.error = 'This profile changed. Explicitly save the grant again before changing its tier.'
      return
    }
    await this.saveManagedGrant(row, { openSession: row.openSession, operationTier: rawTier })
  }

  async onRevokeOpen(row: SecureMcpSettingsRow): Promise<void> {
    if (!this.canManage) return
    if (!row.selected) {
      return
    }
    try {
      await this.authorizations.revokeOpen(row.id)
      await this.reload()
    } catch {
      this.error = 'Open revoked for this run, but the change was not persisted. Retry saving before restarting Tabby.'
      await this.reload(true)
    }
  }

  async onRefreshGrant(row: SecureMcpSettingsRow): Promise<void> {
    if (!this.canManage) return
    if (!row.selected || this.saving) {
      return
    }
    await this.saveManagedGrant(row, { openSession: row.openSession, operationTier: row.operationTier })
  }

  private async saveManagedGrant(
    row: SecureMcpSettingsRow,
    update: { openSession: boolean; operationTier: GrantedOperationTier },
  ): Promise<void> {
    const profile = this.loadedProfiles.find(candidate => candidate.id === row.id)
    if (!profile) {
      this.error = 'Failed to save the operation grant.'
      await this.reload(true)
      return
    }
    this.saving = true
    this.error = null
    try {
      const raw = (await this.profiles.getProfiles({ includeBuiltin: false, clone: true })).find(item => item.id === row.id)
      if (!raw) throw new Error('profile unavailable')
      const fresh = resolveEffectiveProfile(raw, this.profiles)
      if (stableProfileDigest(fresh) !== stableProfileDigest(profile)) {
        this.error = 'This profile changed. Review the refreshed profile before saving the grant again.'
        await this.reload(true)
        return
      }
      await this.authorizations.setManagedGrant(row.id, fresh, update)
      const saved = this.authorizations.effectiveGrant(row.id, stableProfileDigest(fresh))
      if (saved.openSession !== update.openSession || saved.operationTier !== update.operationTier) {
        throw new Error('operation grant did not persist')
      }
      await this.reload(true)
    } catch {
      this.error = 'Failed to save the operation grant to Tabby config. Changes were not persisted.'
      await this.reload(true)
    } finally {
      this.updateView(() => { this.saving = false })
    }
  }
}
