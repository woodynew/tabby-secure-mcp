import { Component, OnInit } from '@angular/core'
import type { ConfigService, ProfilesService } from 'tabby-core'

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
    private readonly config: ConfigService,
    private readonly profiles: ProfilesService,
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
    this.saving = true
    this.error = null
    try {
      const current = readAuthorizedSshProfileIds(this.config.store)
      const next = selected ? [...current, row.id] : current.filter(id => id !== row.id)
      await persistAuthorizedSshProfileIds(this.config, next)
      row.selected = selected
    } catch {
      this.error = 'Failed to save authorized profile selection.'
      await this.reload()
    } finally {
      this.saving = false
    }
  }
}
