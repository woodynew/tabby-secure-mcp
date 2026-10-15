import { Component, OnInit } from '@angular/core'
import type { ConfigService, ProfilesService } from 'tabby-core'

import {
  persistAuthorizedSshProfileIds,
  readAuthorizedSshProfileIds,
} from '../config/secure-mcp-config'
import { buildSecureMcpSettingsRows, type SecureMcpSettingsRow } from './secure-mcp-settings.view-model'

@Component({
  selector: 'secure-mcp-settings',
  template: `
    <h3>Authorized SSH profiles</h3>
    <p class="text-muted">
      Select which non-built-in SSH profiles MCP may use. Credentials, hostnames, usernames, groups,
      profile options, and terminal output are never exposed outside Tabby.
    </p>

    <div *ngIf="loading">Loading SSH profiles…</div>
    <div *ngIf="error" class="text-danger">{{ error }}</div>

    <div *ngIf="!loading && !error">
      <div *ngIf="rows.length === 0" class="text-muted">No eligible SSH profiles found.</div>
      <label *ngFor="let row of rows" class="d-block">
        <input
          type="checkbox"
          [checked]="row.selected"
          [disabled]="saving"
          (change)="onToggle(row, $any($event.target).checked)"
        />
        {{ row.displayName }}
      </label>
    </div>
  `,
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
