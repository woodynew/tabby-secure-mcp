import { Component, Inject, OnInit } from '@angular/core'
import { ConfigService, ProfilesService, type PartialProfile, type Profile } from 'tabby-core'

import { stableProfileDigest } from '../approval/profile-security-snapshot'
import { isGrantedOperationTier, type GrantedOperationTier } from '../authorization/operation-tier-policy'
import { PermanentAuthorizationStore } from '../authorization/permanent-authorization-store'
import {
  persistAuthorizedSshProfileIds,
  readAuthorizedSshProfileIds,
} from '../config/secure-mcp-config'
import {
  buildSecureMcpSettingsRows,
  SETTINGS_OPERATION_TIER_OPTIONS,
  type SecureMcpSettingsRow,
} from './secure-mcp-settings.view-model'
import { secureMcpSettingsTemplate } from './secure-mcp-settings.template'

@Component({
  selector: 'secure-mcp-settings',
  template: secureMcpSettingsTemplate,
})
export class SecureMcpSettingsComponent implements OnInit {
  rows: SecureMcpSettingsRow[] = []
  readonly tierOptions = SETTINGS_OPERATION_TIER_OPTIONS
  loading = true
  saving = false
  error: string | null = null
  private loadedProfiles: PartialProfile<Profile>[] = []

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(ProfilesService) private readonly profiles: ProfilesService,
    @Inject(PermanentAuthorizationStore) private readonly authorizations: PermanentAuthorizationStore,
  ) {}

  async ngOnInit(): Promise<void> {
    await this.reload()
  }

  async reload(): Promise<void> {
    this.loading = true
    this.error = null
    try {
      this.loadedProfiles = await this.profiles.getProfiles({ includeBuiltin: false, clone: true })
      const authorizedIds = readAuthorizedSshProfileIds(this.config.store)
      this.rows = buildSecureMcpSettingsRows(
        this.loadedProfiles,
        authorizedIds,
        this.authorizations.list(),
      )
    } catch {
      this.error = 'Failed to load SSH profiles.'
      this.rows = []
      this.loadedProfiles = []
    } finally {
      this.loading = false
    }
  }

  async onToggle(row: SecureMcpSettingsRow, selected: boolean): Promise<void> {
    if (this.saving) {
      return
    }
    const previousSelected = row.selected
    this.saving = true
    this.error = null
    try {
      const current = readAuthorizedSshProfileIds(this.config.store)
      const next = selected ? [...current, row.id] : current.filter(id => id !== row.id)
      const saved = await persistAuthorizedSshProfileIds(this.config, next)
      const persisted = readAuthorizedSshProfileIds(this.config.store)
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
      await this.reload()
    } finally {
      this.saving = false
    }
  }

  async onTierChange(row: SecureMcpSettingsRow, rawTier: string): Promise<void> {
    if (!isGrantedOperationTier(rawTier) || !row.selected || this.saving) {
      return
    }
    await this.saveManagedGrant(row, { openSession: row.openSession, operationTier: rawTier })
  }

  async onRevokeOpen(row: SecureMcpSettingsRow): Promise<void> {
    if (!row.selected || this.saving) {
      return
    }
    await this.saveManagedGrant(row, { openSession: false, operationTier: row.operationTier })
  }

  async onRefreshGrant(row: SecureMcpSettingsRow): Promise<void> {
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
      await this.reload()
      return
    }
    this.saving = true
    this.error = null
    try {
      await this.authorizations.setManagedGrant(row.id, profile, update)
      const saved = this.authorizations.effectiveGrant(row.id, stableProfileDigest(profile))
      if (saved.openSession !== update.openSession || saved.operationTier !== update.operationTier) {
        throw new Error('operation grant did not persist')
      }
      await this.reload()
    } catch {
      this.error = 'Failed to save the operation grant to Tabby config. Changes were not persisted.'
      await this.reload()
    } finally {
      this.saving = false
    }
  }
}
