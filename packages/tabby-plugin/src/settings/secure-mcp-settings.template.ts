export const secureMcpSettingsTemplate = `
    <h3>Authorized SSH profiles</h3>
    <p class="text-muted">
      Select which non-built-in SSH profiles MCP may use. Credentials, hostnames, usernames, groups,
      profile options, and terminal output are never exposed outside Tabby.
    </p>
    <p class="text-muted">
      Allowing an open remembers it until you revoke it here. Operation tiers are managed only in
      Tabby: low is read-only, medium is read-write, and high is full control. Full control is not a
      remote shell. The MCP client cannot raise its own tier.
    </p>

    <div *ngIf="loading">Loading SSH profiles…</div>
    <div *ngIf="error" class="alert alert-danger" role="alert">{{ error }}</div>

    <div *ngIf="!loading">
      <div *ngIf="rows.length === 0" class="text-muted">No eligible SSH profiles found.</div>
      <div *ngFor="let row of rows" class="mb-3">
        <label class="d-block">
          <input
            type="checkbox"
            [checked]="row.selected"
            [disabled]="saving"
            (change)="onToggle(row, $any($event.target).checked)"
          />
          {{ row.displayName }}
        </label>
        <div *ngIf="row.selected" class="ms-4">
          <label>
            Operation tier
            <select
              [disabled]="saving"
              (change)="onTierChange(row, $any($event.target).value)"
            >
              <option
                *ngFor="let option of tierOptions"
                [value]="option.value"
                [selected]="option.value === row.operationTier"
              >{{ option.label }}</option>
            </select>
          </label>
          <p *ngIf="row.grantStale" class="text-warning mb-1">
            This profile changed after the grant was saved. Save the grant again to restore it.
          </p>
          <button
            *ngIf="row.grantStale"
            type="button"
            class="btn btn-sm btn-outline-warning me-2"
            [disabled]="saving"
            (click)="onRefreshGrant(row)"
          >
            Save grant again
          </button>
          <button
            *ngIf="row.openSession"
            type="button"
            class="btn btn-sm btn-outline-secondary"
            [disabled]="saving"
            (click)="onRevokeOpen(row)"
          >
            Revoke remembered open
          </button>
        </div>
      </div>
    </div>
  `
