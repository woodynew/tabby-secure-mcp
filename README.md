# tabby-secure-mcp

A Tabby plugin hosting a local Streamable HTTP MCP service. AI clients can list explicitly whitelisted SSH profiles, open a visible SSH tab, query grants, and execute one command permitted by the selected tier. The service runs inside Tabby; there is no standalone companion process or client-side Node command.

## Quick start

1. From the repaired source workspace, install/build the plugin:

   ```bash
   npm ci
   npm run install:local
   ```

   The installer uses your platform's Tabby plugins directory. To override it, pass `-- --plugins-dir "/absolute/plugins/path"`. Only one self-contained plugin package is installed. Node is needed for building/installing from source, not for AI clients to run the installed service.

2. Restart Tabby. In the **main window → Settings → Secure MCP**, select only the SSH profiles you want to expose and choose their operation tiers. Start with a dedicated test account and `readonly`.
3. Enter a **credential name**, click **Add client**, and copy that client's MCP configuration. Use a separate credential for each connection client; names can be edited without changing grants.
4. Enable the local service (default `127.0.0.1:50333/mcp`; port configurable). Configure an AI tool supporting Streamable HTTP and an Authorization header using the copied information. Configuration formats vary by client.
5. Preauthorize the named client in settings or approve it when prompted. Pairing supports **this session**, **24 hours**, or **permanent**. In the same client card, preauthorize each whitelisted SSH connection with **Permanently allow**, or leave **Ask when used**. Command tiers remain separate.

Client configuration contains a private bearer token: do not commit or share it. Copying is an explicit action; the plugin does not edit AI-tool configuration files.

## Four tools

| Tool | Result |
| --- | --- |
| list_authorized_ssh_profiles | Minimal references/display names for whitelisted SSH profiles |
| open_authorized_ssh_profile | Open a new visible Tabby SSH tab after applicable approval |
| get_ssh_operation_authorization | Read the current profile grant and tier policy |
| run_authorized_ssh_command | Run one authorized command in a dedicated new tab; output at most 4096 UTF-8 bytes |

## Architecture and delivery

AI client HTTP request → plugin-local MCP session → approval/authorization gate → Tabby SSH APIs. The service binds IPv4 loopback only. Only the main Tabby window hosts it; secondary windows do not take over and show read-only settings. Closing the main window stops the service and cancels pending work. A busy port is reported instead of being reclaimed.

The three source workspaces remain: `tabby-plugin`, `companion` (now a private build library bundled into the plugin), and `ipc-contract` (shared schemas). The user installs only `tabby-secure-mcp`; the internal library and MCP SDK are bundled, with no additional runtime package installation.

## Security scope and limitations

- Every client has independent random credentials. A copied credential identifies an authorization principal, not a verified executable; client-declared names can be forged and never select a remembered grant.
- Client approval defaults to **this session (up to 24 hours)**. Remembered 24-hour permission keeps its original expiry across reconnect/restart. **Permanent** has no hidden 24-hour expiry. Revoking/resetting one client's credential invalidates its requests and remembered permission without affecting other clients.
- A permanent connection grant does not bypass SSH whitelist, profile changes, open approvals, command tiers or final execution checks. Existing profile digest v1 grants remain stale until explicitly reauthorized under v2.
- Missing/wrong bearer tokens, unexpected Host and any Origin header are refused. This initial native-client endpoint does not support browser clients, CORS, remote access or OAuth discovery.
- Protection is application-level least privilege in the Tabby/OS-user trust domain, not kernel isolation from other plugins or same-user processes. POSIX remote shells are required; command tiers are not a remote OS sandbox.
- Client and connection approvals allow 60 seconds. The plugin asks Tabby to bring its main window forward before showing approval; focus never grants permission. Connection permission binds the named credential and effective profile, applies to both open and command tools, and can be granted or cleared in settings before use. Legacy profile-wide open grants are not inherited. Command tiers are managed only in Tabby.
- Commands reject raw terminal controls and direct shell composition. Full permission permits other single programs, including interpreters, and therefore carries the remote account's power.
- `audit_unavailable`: required pre-effect audit failed; the operation was not dispatched. `outcome_unknown`: it may have happened; never automatically retry. Truncation/disconnect does not prove a remote task stopped.
- Audit writers use independent hash-chained segments, rotate at 10 MiB and preserve old audit.jsonl. Whole-log replacement or tail deletion cannot be detected without an external anchor.

### Restricted command policy

| Tier | Accepted program/arguments |
| --- | --- |
| Low | `pwd`, `whoami`, `id`, `uptime` without arguments; `uname` with only `-a/-s/-n/-r/-v/-m` |
| Low | `ls` with short flags `aAlhdFnrtR` and paths; `cat` with paths; `wc` with short flags `clmw` and paths |
| Medium | `mkdir [-p] paths`, `touch paths`, `cp [-R] sources target`, `mv sources target` |

Options may be combined into short flags. `--` separates options from paths. Paths are passed as literal, quoted operands; shell globbing and expansion are not performed. Input remains limited to 512 UTF-8 bytes. Raw terminal controls, including controls inside quotes, are rejected.

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
