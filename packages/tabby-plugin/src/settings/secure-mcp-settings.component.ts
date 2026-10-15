import { Component, Inject, OnInit } from '@angular/core'
import { ConfigService, ProfilesService } from 'tabby-core'

import {
  persistAuthorizedSshProfileIds,
  readAuthorizedSshProfileIds,
} from '../config/secure-mcp-config'
import { buildSecureMcpSettingsRows, type SecureMcpSettingsRow } from './secure-mcp-settings.view-model'
import { secureMcpSettingsTemplate } from './secure-mcp-settings.template'

@Component({
  selector: 'secure-mcp-settings',
  template: secureMcpSettingsTemplate,
})
export class SecureMcpSettingsComponent implements OnInit {
  rows: SecureMcpSettingsRow[] = []
  loading = true
  saving = false
  error: string | null = null

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(ProfilesService) private readonly profiles: ProfilesService,
  ) {}

  async ngOnInit(): Promise<void> {
    await this.reload()
  }

  async reload(): Promise<void> {
    this.loading = true
    this.error = null
    try {
      const profileList = await this.profiles.getProfiles({ includeBuiltin: false, clone: true })
      const authorizedIds = readAuthorizedSshProfileIds(this.config.store)
      this.rows = buildSecureMcpSettingsRows(profileList, authorizedIds)
    } catch {
      this.error = 'Failed to load SSH profiles.'
      this.rows = []
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
      row.selected = selected
    } catch {
      row.selected = previousSelected
      this.error =
        'Failed to save authorized profile selection to Tabby config. Changes were not persisted.'
      await this.reload()
    } finally {
      this.saving = false
    }
  }
}
