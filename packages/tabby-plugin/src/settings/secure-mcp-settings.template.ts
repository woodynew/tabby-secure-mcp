export const secureMcpSettingsTemplate = `
      <h3>{{ 'secureMcp.commandSessions' | translate }}</h3>
      <label for="command-session-close-policy">{{ 'secureMcp.afterCommand' | translate }}</label>
      <select
        id="command-session-close-policy"
        class="form-select mb-2"
        [value]="commandSessionClosePolicy"
        [disabled]="saving || loading"
        (change)="onClosePolicyChange($any($event.target).value, $any($event.target))"
      >
        <option value="keep">{{ 'secureMcp.keepSession' | translate }}</option>
        <option value="after-completion">{{ 'secureMcp.closeWhenFinished' | translate }}</option>
      </select>
      <p class="text-muted">
        {{ 'secureMcp.commandSessionsHelp' | translate }}
      </p>

    <h3>{{ 'secureMcp.authorizedProfiles' | translate }}</h3>
    <p class="text-muted">
      {{ 'secureMcp.authorizedProfilesHelp' | translate }}
    </p>
    <p class="text-muted">
      {{ 'secureMcp.operationTiersHelp' | translate }}
    </p>

    <div *ngIf="loading">{{ 'secureMcp.loadingProfiles' | translate }}</div>
    <div *ngIf="error" class="alert alert-danger" role="alert">{{ error | translate }}</div>

    <div *ngIf="!loading">
      <div *ngIf="rows.length === 0" class="text-muted">{{ 'secureMcp.noProfiles' | translate }}</div>
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
            {{ 'secureMcp.operationTier' | translate }}
            <select
              [disabled]="saving"
              (change)="onTierChange(row, $any($event.target).value)"
            >
              <option
                *ngFor="let option of tierOptions"
                [value]="option.value"
                [selected]="option.value === row.operationTier"
              >{{ option.labelKey | translate }}</option>
            </select>
          </label>
          <p *ngIf="row.grantStale" class="text-warning mb-1">
            {{ 'secureMcp.staleGrant' | translate }}
          </p>
          <button
            *ngIf="row.grantStale"
            type="button"
            class="btn btn-sm btn-outline-warning me-2"
            [disabled]="saving"
            (click)="onRefreshGrant(row)"
          >
            {{ 'secureMcp.saveGrantAgain' | translate }}
          </button>
          <button
            *ngIf="row.openSession"
            type="button"
            class="btn btn-sm btn-outline-secondary"
            [disabled]="saving"
            (click)="onRevokeOpen(row)"
          >
            {{ 'secureMcp.revokeOpen' | translate }}
          </button>
        </div>
      </div>
    </div>
  `
