export const secureMcpSettingsTemplate = `
    <h3>Local MCP service</h3>
    <p *ngIf="!canManage" class="alert alert-info">Manage MCP from the main Tabby window. Secondary windows do not host or take over the service.</p>
    <div *ngIf="runtime">
      <p>Status: {{ runtime.status }}</p>
      <div *ngIf="runtime.error" class="alert alert-danger" role="alert">{{ runtime.error }}</div>
      <div *ngIf="runtime.credentials.hasUnpersistedRevocations" class="alert alert-danger" role="alert">Some client revocations are only applied for this run. Retry before restarting Tabby.</div>
      <label class="d-block">Port
        <input type="number" min="1024" max="65535" [value]="httpPort" [disabled]="!canManage || saving" (input)="httpPort = +$any($event.target).value" />
      </label>
      <button type="button" class="btn btn-outline-primary me-2" [disabled]="!canManage || saving" (click)="onSaveServer(true)">Enable / save service</button>
      <button type="button" class="btn btn-outline-secondary" [disabled]="!canManage || saving" (click)="onSaveServer(false)">Disable service</button>
      <h4 class="mt-3">Named client credentials</h4>
      <p>Each connection client has its own credential. Approval can last for this session, 24 hours, or permanently until revoked. SSH permissions remain separate.</p>
      <label>Credential name
        <input type="text" maxlength="160" [value]="clientName" [disabled]="!canManage || saving" (input)="clientName = $any($event.target).value" />
      </label>
      <button type="button" class="btn btn-outline-primary ms-2" [disabled]="!canManage || saving" (click)="onCreateClient()">Add client</button>
      <div *ngFor="let client of clients; trackBy: trackClient" class="border rounded p-2 mt-2">
        <label>Credential name
          <input type="text" [value]="client.name" [disabled]="!canManage || saving" (change)="onRenameClient(client.id, $any($event.target).value, $any($event.target))" />
        </label>
        <p>{{ clientPermission(client) }}</p>
        <label class="d-block">MCP access authorization (pairing)
          <select #permissionChoice [value]="clientPermissionChoice(client)" [disabled]="!canManage || saving">
            <option value="session">This session (next connection only)</option>
            <option value="24h">24 hours from now</option>
            <option value="permanent">Permanent — until revoked</option>
            <option value="none">Clear authorization — require approval</option>
          </select>
          <button type="button" class="btn btn-sm btn-outline-primary ms-2" [disabled]="!canManage || saving" (click)="onChangeClientPermission(client.id, client.generation, permissionChoice.value)">Apply authorization</button>
        </label>
        <p class="text-muted">Applying disconnects this client and keeps its token. Session-only approval allows the next connection, up to 24 hours, and is lost on restart. Clearing authorization requires approval on the next connection.</p>
        <h5>SSH connection authorization</h5>
        <p class="text-muted">Set permission before this client connects. It applies to both opening SSH tabs and running SSH commands; operation tiers remain separate. Unapproved connections show an approval dialog.</p>
        <div *ngFor="let row of rows">
          <div *ngIf="row.selected" class="mb-2">
            <label>{{ row.displayName }}
              <select #connectionChoice [value]="clientConnectionState(client, row)" [disabled]="!canManage || saving">
                <option value="ask" [selected]="clientConnectionState(client, row) === 'ask'">Ask when used</option>
                <option value="allowed" [selected]="clientConnectionState(client, row) === 'allowed'">Permanently allow</option>
                <option *ngIf="clientConnectionState(client, row) === 'stale'" value="stale" selected disabled>Profile changed — authorization required</option>
              </select>
            </label>
            <button type="button" class="btn btn-sm btn-outline-primary ms-2" [disabled]="!canManage || saving || connectionChoice.value === 'stale'" (click)="onChangeClientConnection(client, row, connectionChoice.value)">Apply connection authorization</button>
          </div>
        </div>
        <p *ngIf="!loading && rows.length === 0" class="text-muted">No eligible SSH profiles. Add a profile and enable it in the whitelist below.</p>
        <button type="button" class="btn btn-sm btn-outline-primary me-2" [disabled]="!canManage || saving" (click)="onCopyClient(client.id)">Copy MCP configuration</button>
        <button type="button" class="btn btn-sm btn-outline-secondary me-2" [disabled]="!canManage || saving" (click)="onResetClient(client.id)">Reset credential</button>
        <button type="button" class="btn btn-sm btn-outline-danger" [disabled]="!canManage || saving" (click)="onRevokeClient(client.id)">Revoke client</button>
      </div>
      <div *ngFor="let session of runtime.sessions()" class="text-muted">{{ session.clientName }}: {{ session.state }} {{ session.duration === 'permanent' ? '(permanent)' : '' }}</div>
    </div>
    <div *ngIf="notice" class="alert alert-info" role="status">{{ notice }}</div>
    <h3>Authorized SSH profiles</h3>
    <p class="text-muted">
      Select which non-built-in SSH profiles MCP may use. Profile lists return only display names
      and opaque references; stored connection fields and credentials are not included.
      Output from an existing tab is not read.
    </p>
    <p class="text-muted">
      Connection authorizations are managed separately for each named client above. Operation tiers authorize SSH commands
      and are managed only in Tabby. Low authorizes a verified subset of read-only programs and arguments;
      medium also allows the supported file-writing operations. High allows other single commands,
      including interpreters. A higher tier includes
      every lower command class. A command whose class fits the tier runs once in a new visible tab.
      POSIX remote shells are supported. Shell operators and terminal control characters are rejected,
      and returned text is capped. These command classes are not an OS sandbox. The MCP client cannot raise its own tier.
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
            [disabled]="!canManage || (saving && !row.selected)"
            (change)="onToggle(row, $any($event.target).checked)"
          />
          {{ row.displayName }}
        </label>
        <div *ngIf="row.selected" class="ms-4">
          <label>
            Operation tier
            <select
              [disabled]="!canManage || saving"
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
            [disabled]="!canManage || saving"
            (click)="onRefreshGrant(row)"
          >
            Save grant again
          </button>
        </div>
      </div>
    </div>
  `
