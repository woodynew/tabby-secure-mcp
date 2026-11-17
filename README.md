# tabby-secure-mcp

A Tabby plugin hosting a local Streamable HTTP MCP service. AI clients can list explicitly whitelisted SSH profiles, open and reuse visible SSH tabs, execute approved commands, and transfer files when separately enabled. The service runs inside Tabby; there is no standalone companion process or client-side Node command.

## Quick start

1. From the repaired source workspace, install/build the plugin:

   ```bash
   npm ci
   npm run install:local
   ```

   The installer uses your platform's Tabby plugins directory. To override it, pass `-- --plugins-dir "/absolute/plugins/path"`. Only one self-contained plugin package is installed. Node is needed for building/installing from source, not for AI clients to run the installed service.

2. Restart Tabby. In the **main window → Settings → Secure MCP**, select only the SSH profiles you want to expose and choose their command approval modes. Start with a dedicated test account and **Request approval**.
3. Enter a **credential name**, click **Add client**, and copy that client's MCP configuration. Use a separate credential for each connection client; names can be edited without changing grants.
4. Enable the local service (default `127.0.0.1:50333/mcp`; port configurable). Configure an AI tool supporting Streamable HTTP and an Authorization header using the copied information. Configuration formats vary by client.
5. Preauthorize the named client in settings or approve it when prompted. Pairing supports **this session**, **24 hours**, or **permanent**. In the same client card, preauthorize each whitelisted SSH connection with **Permanently allow**, or leave **Ask when used**. Command approval modes remain separate.

Client configuration contains a private bearer token: do not commit or share it. Copying is an explicit action; the plugin does not edit AI-tool configuration files.

## Seven tools

| Tool | Result |
| --- | --- |
| list_authorized_ssh_profiles | Minimal references/display names for whitelisted SSH profiles |
| open_authorized_ssh_profile | Open a new visible Tabby SSH tab after applicable approval; returns an opaque `tab_ref` for cleanup |
| get_ssh_operation_authorization | Read the current profile grant and command approval mode policy |
| run_authorized_ssh_command | Run one authorized command; reuse an idle owned SSH tab by default, pass `tab_ref` to select one or `new_tab: true` to create one; output at most 4096 UTF-8 bytes |
| close_mcp_ssh_tab | Close one tab created for this client, using its returned `tab_ref` |
| upload_ssh_file | Upload one local file from the Tabby machine to the selected SSH host; requires separate file transfer permission |
| download_ssh_file | Download one file from the selected SSH host to the Tabby machine; requires separate file transfer permission |

### File transfer

In **Settings → Secure MCP → Named client credentials**, enable **File transfer** on the
specific client's SSH row. This is **off by default** for every client/profile pair, including
existing credentials after upgrading. It does not inherit global command rules or follow
Full access mode. SSH connection authorization is still required separately. Only Tabby settings
can enable this permission; an AI tool cannot enable it itself.

Both file tools take `profile_ref`, `local_path` and `remote_path`. Paths must be absolute;
`local_path` belongs to the machine running Tabby, using its OS account's file permissions.
Transfer supports one regular file up to **64 MiB**, with a **180-second** service deadline.
The destination must not exist and its parent directory must already exist. Directories,
overwrite and recursive transfer are unsupported. The tool uses native SFTP and automatically
reuses an eligible owned connection, or opens a visible approved SSH tab. A retained tab's
`tab_ref` can be used for subsequent command calls or explicit cleanup.

Disabling the permission or changing the credential/target invalidates active transfers.
An interrupted upload can leave a partial remote destination: `outcome_unknown` means inspect
that file and the SSH tab before deciding what to do; **do not retry automatically**. The plugin
does not delete uncertain remote files. Failed downloads remove only their own identifiable
local partial file when safe.

### Command session closing

In **Settings → Secure MCP → Service → Command sessions**, choose **Keep session open (default)** or
**Close when the command finishes**. The setting applies globally to new sessions created by
`run_authorized_ssh_command`; a change takes effect for subsequent requests.

Automatic closing happens only after the command's completion marker is received and its output
has been captured. After dispatch, timeouts, cancellations, and output limits leave the session
open when completion cannot be confirmed. Failed authorization or audit checks still clean up the
request's tab. A command that finishes with a nonzero exit status can
still close its session. Existing sessions and sessions opened manually or through
`open_authorized_ssh_profile` stay open.

The AI can explicitly clean up a retained tab with
`close_mcp_ssh_tab({"tab_ref":"<reference returned by open or run>"})`.
This needs no additional SSH approval: the reference is restricted to the creating credential
identity and current service run. It cannot target manual tabs, another client's tabs, native tab
IDs, split groups or the Tabby window. The tool returns `{"status":"closed"}`.
Already closed, foreign or expired references return `target_unavailable` without closing anything.
References are invalid after credential identity changes or a service restart; retained tabs then
need manual cleanup. Closing a tab may disconnect SSH and interrupt remote processes, so finish
the task before closing it. Incomplete/truncated output does not prove the remote command finished.
Automatically closed command tabs do not return `tab_ref`.

### Reusing SSH connections

`open_authorized_ssh_profile` always creates a fresh visible tab and returns its `tab_ref`.
Subsequent command calls reuse an eligible idle tab for the same client and current SSH profile
by default. Pass the returned `tab_ref` to select a particular tab, or use `new_tab: true` to
force a new tab; combining those two options is rejected. Results include `tab_reusable` and,
for command calls, `reused_tab` when a retained reference is available.

Each command still validates the current whitelist, target configuration and approval policy.
Explicit invalid references fail without opening a replacement. Busy, disconnected, changed
transports and commands without confirmed completion are not reused. Typing in an MCP-created
terminal takes it out of automatic reuse and automatic closing; the AI should leave it open
unless the user asks to close it. Reuse applies only to
MCP-created tabs and never reads historical terminal output. Commands still run in isolated
subshells, so this is connection reuse, not persistent shell working-directory state.
Automatic closing applies only to command tabs created by that call; borrowed tabs remain open
until the client closes them explicitly.

In **Request approval** mode, choose **Always allow (add to command set)** to persist the
displayed command family or exact fingerprint for this client and SSH profile. Connection-only
approval is labeled **Always allow this SSH connection** and does not invent a command rule.
**Auto edit** continues to ask for every high-risk or unknown command.

### Interface language

Secure MCP follows Tabby's language setting. Simplified Chinese (`zh-CN`) and English are supported;
other languages, including Traditional Chinese, fall back to English. Open settings pages and
approval dialogs update when the Tabby language changes, including existing errors and countdowns.
There is no separate plugin language setting. Profile names, client identities, tool identifiers,
and the original operation JSON remain unchanged.

## Architecture and delivery

AI client HTTP request → plugin-local MCP session → approval/authorization gate → Tabby SSH APIs. The service binds IPv4 loopback only. Only the main Tabby window hosts it; secondary windows do not take over and show read-only settings. Closing the main window stops the service and cancels pending work. A busy port is reported instead of being reclaimed.

The three source workspaces remain: `tabby-plugin`, `companion` (now a private build library bundled into the plugin), and `ipc-contract` (shared schemas). The user installs only `tabby-secure-mcp`; the internal library and MCP SDK are bundled, with no additional runtime package installation.

## Security scope and limitations

- Every client has independent random credentials. A copied credential identifies an authorization principal, not a verified executable; client-declared names can be forged and never select a remembered grant.
- Client approval defaults to **this session (up to 24 hours)**. Remembered 24-hour permission keeps its original expiry across reconnect/restart. **Permanent** has no hidden 24-hour expiry. Revoking/resetting one client's credential invalidates its requests and remembered permission without affecting other clients.
- A permanent connection grant does not bypass SSH whitelist, profile changes, open approvals, command approval modes or final execution checks. Existing profile digest v1 grants remain stale until explicitly reauthorized under v2.
- Missing/wrong bearer tokens, unexpected Host and any Origin header are refused. This initial native-client endpoint does not support browser clients, CORS, remote access or OAuth discovery.
- Protection is application-level least privilege in the Tabby/OS-user trust domain, not kernel isolation from other plugins or same-user processes. POSIX remote shells are required; command approval modes are not a remote OS sandbox.
- Client and connection approvals allow 60 seconds. The plugin asks Tabby to bring its main window forward before showing approval; focus never grants permission. Connection permission binds the named credential and effective profile, applies to both open and command tools, and can be granted or cleared in settings before use. Legacy profile-wide open grants are not inherited. Command approval modes are managed only in Tabby.
- Commands reject raw terminal controls and direct shell composition. Full permission permits other single programs, including interpreters, and therefore carries the remote account's power.
- `audit_unavailable`: required pre-effect audit failed; the operation was not dispatched. `outcome_unknown`: it may have happened; never automatically retry. Truncation/disconnect does not prove a remote task stopped.
- Audit writers use independent hash-chained segments, rotate at 10 MiB and preserve old audit.jsonl. Whole-log replacement or tail deletion cannot be detected without an external anchor.

### SSH command approval modes

Choose a mode for each whitelisted SSH profile in **Settings → Secure MCP**:

| Mode | Behavior |
| --- | --- |
| Request approval | Ask before a command unless its validated family or exact command is already approved. Choose Allow once or Allow and remember. |
| Auto edit | Automatically run recognized low-risk queries and constrained edits. High-risk and unknown operations always ask, regardless of saved rules. |
| Full access | Skip command approval. Client authentication, connection grants, whitelist, syntax and audit checks still apply. |
| Disabled | Do not execute commands. |

Low-risk queries include `docker ps`, `ip -4 rule show`, `uci get openclash.config.en_mode`, and `nft list table inet fw4`. The existing constrained reads remain supported. Deletion, cp/mv overwrite risk, interpreters, system modification and unknown arguments require approval in Auto edit. Path screening is lexical and cannot resolve remote symlinks or verify the remote working directory; it is not a remote OS sandbox.

Each named client's SSH profile has its own editable command set. Global default rules start empty and are inherited live by default; each set can disable inheritance. Allow and remember changes only that client's target set. Clearing a target set clears its local rules and disables inheritance; clearing global defaults leaves local rules intact. Mode changes preserve the sets.

The command-set editor shows inherited and local sources, supports add/edit/delete, and copies a portable effective set without credentials or target identity. Paste first previews validated rules, then merges or replaces on explicit save; replacing a target set disables inheritance. Exact rules store only a program name and argv hash, so changing them requires entering a new complete command. Invalid, conflicting, oversized or unsupported imports leave the saved set intact. Limits are 128 local rules per client across profiles, 128 global rules, and a 64-KiB credential file; no silent eviction.

Legacy readonly/readwrite grants migrate to Request approval, full remains Full access, and none remains disabled. The private credential file upgrades from v1/v2 to v3 on its next successful save; older plugins cannot read v3. Preserve private state before a planned downgrade. MCP inputs and tool names remain unchanged; output fields are now approval_mode and command_risk instead of operation_tier and command_class.

Command input remains a single command of at most 512 UTF-8 bytes. Shell operators and raw terminal controls are rejected; shell expansion/globbing is not performed and arguments are quoted before dispatch, including in Full access. All approval windows are 60 seconds; cancellation, blur and Escape never grant permission. Command calls budget up to 60 seconds for approval plus 45 seconds for execution collection; configure the AI client's timeout accordingly.

Effective profile snapshots include provider/global/group defaults and use digest version 2. Existing version-1 grants remain stored but stale until explicitly reauthorized. Revocation never refreshes an unrelated grant. A failed revocation remains denied for the running configuration service, including config reloads, and the settings page reports that disk persistence failed.

`audit_unavailable` means a required audit write failed before execution. `outcome_unknown` means the operation may already have happened: inspect the request's new Tabby tab and do not automatically retry. A truncated result is not proof that the remote command ended. Closing SSH cannot guarantee termination of detached remote jobs.

Each plugin runtime writes its own numbered audit segments under the audit directory; historical `audit.jsonl` is preserved. Segments rotate at 10 MiB with a continuous hash chain. Critical writes are flushed before side effects. Corrupt segments and failed rotations are preserved and block critical operations. `verifyAuditSegments` verifies an ordered segment list without modifying evidence.

MCP-created SSH tabs request a fresh transport without changing the stored profile's reuse setting. This prevents Tabby's transport multiplexer from inheriting a connection authenticated with older credentials.

## Installation and recovery

The installer retains checksum-named tarballs in `.secure-mcp-artifacts` and registers the plugin as a stable root `file:` dependency. Keep the artifacts for later npm maintenance. Registered unrelated dependencies are preserved; unregistered existing plugins cause a preflight refusal. Old registered companion packages may remain inert, but old stdio client entries must be disabled manually. The installer never deletes runtime locks or automatically uninstalls unrelated packages.

Private named credentials live beside the audit root in `http-credentials.json`, using existing XDG_CONFIG_HOME / LOCALAPPDATA overrides. Do not edit it manually or relax its permissions. Failed revocations stay denied for the running instance; retry persistence before restarting. Corrupt files, unsafe permissions or unresolved credential updates fail closed and preserve evidence.

## Verification and status

```bash
npm run typecheck
npm test
npm run test:integration
npm run build
npm run pack:check
```

See [client connection guide](docs/configure-mcp-clients.md), [release status](docs/release-status.md), and the approved [HTTP design](docs/superpowers/specs/2026-11-08-plugin-streamable-http-design.md). Actual AI-tool acceptance is product-neutral and records the client/version used; SDK-only success is not end-to-end AI acceptance. No publication is implied by local tests.
