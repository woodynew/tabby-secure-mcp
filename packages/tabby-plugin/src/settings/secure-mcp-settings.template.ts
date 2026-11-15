export const secureMcpSettingsTemplate = `
    <h3>{{ 'secureMcp.localService' | translate }}</h3>
    <p *ngIf="!canManage" class="alert alert-info">{{ 'secureMcp.mainWindowOnly' | translate }}</p>
    <div *ngIf="runtime">
      <p>{{ 'secureMcp.status' | translate }}: {{ (serviceStatuses[runtime.status] || 'secureMcp.serviceError') | translate }}</p>
      <div *ngIf="runtime.error" class="alert alert-danger" role="alert">{{ (serviceErrors[runtime.error] || runtime.error) | translate }}</div>
      <div *ngIf="runtime.credentials.hasUnpersistedRevocations" class="alert alert-danger" role="alert">{{ 'secureMcp.clientRevocationsPending' | translate }}</div>
      <label class="d-block">{{ 'secureMcp.port' | translate }}
        <input type="number" min="1024" max="65535" [value]="httpPort" [disabled]="!canManage || saving" (input)="httpPort = +$any($event.target).value" />
      </label>
      <button type="button" class="btn btn-outline-primary me-2" [disabled]="!canManage || saving" (click)="onSaveServer(true)">{{ 'secureMcp.enableService' | translate }}</button>
      <button type="button" class="btn btn-outline-secondary" [disabled]="!canManage || saving" (click)="onSaveServer(false)">{{ 'secureMcp.disableService' | translate }}</button>
      <h4 class="mt-3">{{ 'secureMcp.namedCredentials' | translate }}</h4>
      <p>{{ 'secureMcp.namedCredentialsHelp' | translate }}</p>
      <label>{{ 'secureMcp.credentialName' | translate }}
        <input type="text" maxlength="160" [value]="clientName" [disabled]="!canManage || saving" (input)="clientName = $any($event.target).value" />
      </label>
      <button type="button" class="btn btn-outline-primary ms-2" [disabled]="!canManage || saving" (click)="onCreateClient()">{{ 'secureMcp.addClient' | translate }}</button>
      <div *ngFor="let client of clients; trackBy: trackClient" class="border rounded p-2 mt-2">
        <label>{{ 'secureMcp.credentialName' | translate }}
          <input type="text" [value]="client.name" [disabled]="!canManage || saving" (change)="onRenameClient(client.id, $any($event.target).value, $any($event.target))" />
        </label>
        <p>{{ clientPermission(client) | translate:{ expiresAt: $any(client.permission).expiresAt | date:'medium' } }}</p>
        <label class="d-block">{{ 'secureMcp.pairingAuthorization' | translate }}
          <select #permissionChoice [value]="clientPermissionChoice(client)" [disabled]="!canManage || saving">
            <option value="session">{{ 'secureMcp.nextSession' | translate }}</option>
            <option value="24h">{{ 'secureMcp.next24Hours' | translate }}</option>
            <option value="permanent">{{ 'secureMcp.permanentPermission' | translate }}</option>
            <option value="none">{{ 'secureMcp.clearAuthorization' | translate }}</option>
          </select>
          <button type="button" class="btn btn-sm btn-outline-primary ms-2" [disabled]="!canManage || saving" (click)="onChangeClientPermission(client.id, client.generation, permissionChoice.value)">{{ 'secureMcp.applyAuthorization' | translate }}</button>
        </label>
        <p class="text-muted">{{ 'secureMcp.applyAuthorizationHelp' | translate }}</p>
        <h5>{{ 'secureMcp.connectionAuthorization' | translate }}</h5>
        <p class="text-muted">{{ 'secureMcp.connectionAuthorizationHelp' | translate }}</p>
        <div *ngFor="let row of rows">
          <div *ngIf="row.selected" class="mb-2">
            <label>{{ row.displayName }}
              <select #connectionChoice [value]="clientConnectionState(client, row)" [disabled]="!canManage || saving">
                <option value="ask" [selected]="clientConnectionState(client, row) === 'ask'">{{ 'secureMcp.askWhenUsed' | translate }}</option>
                <option value="allowed" [selected]="clientConnectionState(client, row) === 'allowed'">{{ 'secureMcp.permanentlyAllow' | translate }}</option>
                <option *ngIf="clientConnectionState(client, row) === 'stale'" value="stale" selected disabled>{{ 'secureMcp.connectionStale' | translate }}</option>
              </select>
            </label>
            <button type="button" class="btn btn-sm btn-outline-primary ms-2" [disabled]="!canManage || saving || connectionChoice.value === 'stale'" (click)="onChangeClientConnection(client, row, connectionChoice.value)">{{ 'secureMcp.applyConnectionAuthorization' | translate }}</button>
          </div>
        </div>
        <p *ngIf="!loading && rows.length === 0" class="text-muted">{{ 'secureMcp.noClientProfiles' | translate }}</p>
        <button type="button" class="btn btn-sm btn-outline-primary me-2" [disabled]="!canManage || saving" (click)="onCopyClient(client.id)">{{ 'secureMcp.copyConfiguration' | translate }}</button>
        <button type="button" class="btn btn-sm btn-outline-secondary me-2" [disabled]="!canManage || saving" (click)="onResetClient(client.id)">{{ 'secureMcp.resetCredential' | translate }}</button>
        <button type="button" class="btn btn-sm btn-outline-danger" [disabled]="!canManage || saving" (click)="onRevokeClient(client.id)">{{ 'secureMcp.revokeClient' | translate }}</button>
      </div>
      <div *ngFor="let session of runtime.sessions()" class="text-muted">{{ session.clientName }}: {{ (session.state === 'approved' ? 'secureMcp.sessionApproved' : 'secureMcp.sessionPending') | translate }} {{ (session.duration === 'permanent' ? 'secureMcp.permanentPermission' : '') | translate }}</div>
    </div>
    <div *ngIf="notice" class="alert alert-info" role="status">{{ notice | translate }}</div>
    <h3>{{ 'secureMcp.commandSessions' | translate }}</h3>
    <label for="command-session-close-policy">{{ 'secureMcp.afterCommand' | translate }}</label>
    <select
      id="command-session-close-policy"
      class="form-select mb-2"
      [value]="commandSessionClosePolicy"
      [disabled]="!canManage || saving || loading"
      (change)="onClosePolicyChange($any($event.target).value, $any($event.target))"
    >
      <option value="keep">{{ 'secureMcp.keepSession' | translate }}</option>
      <option value="after-completion">{{ 'secureMcp.closeWhenFinished' | translate }}</option>
    </select>
    <p class="text-muted">
      {{ 'secureMcp.commandSessionsHelp' | translate }}
    </p>

    <h3>{{ 'secureMcp.authorizedProfiles' | translate }}</h3>
    <p class="text-muted">{{ 'secureMcp.authorizedProfilesHelp' | translate }}</p>
    <p class="text-muted">{{ 'secureMcp.operationTiersHelp' | translate }}</p>

    <div *ngIf="loading">{{ 'secureMcp.loadingProfiles' | translate }}</div>
    <div *ngIf="error" class="alert alert-danger" role="alert">{{ error | translate }}</div>

    <div *ngIf="!loading">
      <div *ngIf="rows.length === 0" class="text-muted">{{ 'secureMcp.noProfiles' | translate }}</div>
      <div *ngFor="let row of rows" class="mb-3">
        <label class="d-block">
          <input
            type="checkbox"
            [checked]="row.selected"
            [disabled]="!canManage || (saving && !row.selected)"
            (change)="onToggle(row, $any($event.target).checked)"
          />
          {{ row.displayName }}
        </label>
        <div *ngIf="row.selected" class="ms-4">
          <label>
            {{ 'secureMcp.operationTier' | translate }}
            <select
              [disabled]="!canManage || saving"
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
            [disabled]="!canManage || saving"
            (click)="onRefreshGrant(row)"
          >
            {{ 'secureMcp.saveGrantAgain' | translate }}
          </button>
        </div>
      </div>
    </div>
  `
