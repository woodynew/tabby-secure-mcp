import { Component, Inject, OnInit } from '@angular/core'
import { ConfigService, ProfilesService, type PartialProfile, type Profile } from 'tabby-core'

import { stableProfileDigest } from '../approval/profile-security-snapshot'
import { isGrantedOperationTier, type GrantedOperationTier } from '../authorization/operation-tier-policy'
import { PermanentAuthorizationStore } from '../authorization/permanent-authorization-store'
import {
  persistAuthorizedSshProfileIds,
  readAuthorizedSshProfileIds,
  persistCommandSessionClosePolicy,
  readCommandSessionClosePolicy,
  type CommandSessionClosePolicy,
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
  commandSessionClosePolicy: CommandSessionClosePolicy = 'keep'
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
    this.commandSessionClosePolicy = readCommandSessionClosePolicy(this.config.store)
    try {
      this.loadedProfiles = await this.profiles.getProfiles({ includeBuiltin: false, clone: true })
      const authorizedIds = readAuthorizedSshProfileIds(this.config.store)
      this.rows = buildSecureMcpSettingsRows(
        this.loadedProfiles,
        authorizedIds,
        this.authorizations.list(),
      )
    } catch {
      this.error = 'secureMcp.errorLoadProfiles'
      this.rows = []
      this.loadedProfiles = []
    } finally {
      this.loading = false
    }
  }

  async onClosePolicyChange(rawPolicy: string, select?: Pick<HTMLSelectElement, 'value'>): Promise<void> {
    if (this.saving || (rawPolicy !== 'keep' && rawPolicy !== 'after-completion')) {
      return
    }
    const previous = this.commandSessionClosePolicy
    this.saving = true
    this.error = null
    this.commandSessionClosePolicy = rawPolicy
    try {
      await persistCommandSessionClosePolicy(this.config, rawPolicy)
    } catch {
      this.commandSessionClosePolicy = previous
      this.error = 'secureMcp.errorSaveClosePolicy'
    } finally {
      this.saving = false
      // Native selection changes can precede Angular's binding update on a rejected save.
      if (select) {
        select.value = this.commandSessionClosePolicy
      }
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
      await this.reload()
      this.error = 'secureMcp.errorSaveProfiles'
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
      await this.reload()
      this.error = 'secureMcp.errorProfileMissing'
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
      await this.reload()
      this.error = 'secureMcp.errorSaveGrant'
    } finally {
      this.saving = false
    }
  }
}
