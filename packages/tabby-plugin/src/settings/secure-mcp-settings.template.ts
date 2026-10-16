export const secureMcpSettingsTemplate = `
    <h3>Authorized SSH profiles</h3>
    <p class="text-muted">
      Select which non-built-in SSH profiles MCP may use. Credentials, hostnames, usernames, groups,
      profile options, and terminal output are never exposed outside Tabby.
    </p>

    <div *ngIf="loading">Loading SSH profiles…</div>
    <div *ngIf="error" class="alert alert-danger" role="alert">{{ error }}</div>

    <div *ngIf="!loading">
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
  `
