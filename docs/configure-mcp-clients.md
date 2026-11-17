# Connect an AI tool to Tabby's MCP service

Install the single Tabby plugin, restart Tabby, and use **Settings → Secure MCP** in its main window. No companion command, npx invocation, system Node path, stdio shim or external daemon is needed by the AI client.

## Connection requirements

The AI tool must support **MCP Streamable HTTP** and a custom **Authorization** header. This local native-client service uses JSON responses, accepts POST/DELETE, and answers standalone GET with 405. Browser-origin requests and remote access are not supported. Client configuration field names vary; use its HTTP transport setup rather than a stdio command.

1. Add an SSH profile with a dedicated low-privilege test account and verify the connection manually.
2. Whitelist it and choose **Request approval** initially.
3. Add a client credential with a meaningful name, such as “Work laptop agent”. Rename it in the list whenever needed; renaming does not change its token or grants.
4. Enable the service. Copy the configuration for that client and enter its URL and header into the AI tool.
5. Before connecting, set **MCP access authorization (pairing)** and **SSH connection authorization** on that client's card. Otherwise approve the requests when prompted. The credential name is your label; the additional client-declared name is unverified.

Client and SSH-open approval prompts allow **60 seconds**. Before showing a prompt, the plugin asks Tabby to bring the main window forward. If the OS cannot activate it, check Tabby manually. Focus, Escape, cancellation and timeout never grant permission; leaving the window while approval is open still rejects it.

If the AI tool imposes a shorter request timeout, cancellation still ends approval earlier. Configure a tool-call timeout longer than 60 seconds in that client when you want the full approval window.

Typical configuration shape (replace placeholders with the copied values; do not commit the token):

```json
{
  "mcpServers": {
    "tabby-secure-mcp": {
      "url": "http://127.0.0.1:50333/mcp",
      "headers": { "Authorization": "Bearer <client-token>" }
    }
  }
}
```

A client may require an explicit HTTP transport type or different surrounding JSON. The canonical connection data are the URL and Authorization header. No particular AI product/version is a prerequisite for acceptance; record whichever supported real client is used.

## Client permission lifetime

| Choice | Behavior |
| --- | --- |
| This session | Current session only, up to 24 hours; not remembered after a reconnect/restart |
| Remember 24 hours | Persists the original deadline; reconnecting does not extend it |
| Permanent | Persists across reconnects and Tabby restarts until this credential is revoked/reset |

Use separate credentials for different connection clients. Authorization binds credential ID and generation, never the label or self-declared product name. Revoking a client makes its old token unusable and aborts its requests. Resetting it gives a new token, clears remembered permission and requires approval again. Copy the replacement configuration afterwards. Other clients remain unaffected.

### Change or clear a client's permission

In the main window, open **Settings → Secure MCP → Named client credentials**, locate its name, choose **MCP access authorization (pairing)**, then click **Apply authorization**. This also works before the client's first connection:

| Choice | Result |
| --- | --- |
| This session (next connection only) | Disconnects the current session and approves the next connection once, for up to 24 hours. Further reconnects need approval; restarting Tabby discards even an unused session grant. |
| 24 hours from now | Disconnects the current session and saves a new 24-hour deadline, starting when Apply is clicked. |
| Permanent | Disconnects the current session and saves permission until revoked, reset or changed. |
| Clear authorization | Disconnects the current session, clears remembered/unused session permission and requires approval on the next connection. |

These four actions keep the token and client name, SSH command sets, global inheritance choices and file transfer choices: reconnect the AI tool using its existing configuration. Current in-flight requests are cancelled. If persistence fails, the client remains denied for the current Tabby run and the settings page asks you to retry before restarting. A later revocation always overrides an earlier permission update.

**Revoke client** removes the credential entirely, so its old token cannot reconnect. **Reset credential** creates a new token and requires copying the updated MCP configuration. Other clients and SSH profile grants remain independent.

Permanent client permission grants access to the MCP tools, not blanket SSH control. Whitelists, effective target digests, open approvals and command approval modes apply on every request. Profile configuration changes can invalidate saved SSH grants independently of client permission.

## SSH connection authorization per client

Each named client's card lists the globally whitelisted SSH profiles under **SSH connection authorization**. Select **Permanently allow** or **Ask when used**, then click **Apply connection authorization**. A client does not need to be online, or to have connected previously, to receive this permission.

- **Permanently allow** remembers permission for this credential and profile, including across Tabby restarts. Both opening an SSH tab and running a command that creates a tab check it. Command approval modes remain separately enforced.
- **Ask when used** clears the saved permission. The next applicable tool call shows the connection approval dialog; Allow saves permission only for that client and profile. Reject, cancellation, blur and timeout do not grant permission.
- **Profile changed — authorization required** means its saved security digest no longer matches. Review the profile, select Permanently allow, and apply again, or approve its next request.

Clients with identical names remain independent. Renaming a client or editing its pairing lifetime retains its SSH connection permissions. Resetting its credential clears both pairing and connection permissions; revoking it deletes them. Revocation prevents pending requests from opening connections or sending commands, but cannot undo a command already sent to the remote machine.

The former profile-wide remembered-open grants are not inherited by clients. Existing whitelist selections remain; legacy readonly/readwrite command grants migrate to Request approval; set the new per-client permissions or use the next approval dialog. The private credential format upgrades from version 1, 2 or 3 to version 4 on the next successful save without rotating tokens. All migrated credentials have file transfer disabled. Older plugin versions cannot read version 4; preserve a private backup before attempting a downgrade.

`get_ssh_operation_authorization` reports `open_session` for the authenticated client and target. It never changes permission. Failed persistence remains visible in settings, and failed revocations remain denied for the running instance until safely saved.

## First calls

Ask the AI tool to call these in order:

1. `list_authorized_ssh_profiles` — only explicitly whitelisted names/references should appear.
2. `get_ssh_operation_authorization` for the returned reference.
3. `open_authorized_ssh_profile` — approve the visible Tabby prompt if required; save its `tab_ref`.
4. `run_authorized_ssh_command` with `whoami`, `id` or `pwd`, passing that `tab_ref` to reuse the connection.
5. `close_mcp_ssh_tab` with the same `tab_ref` when finished.

Command calls reuse this client's eligible idle tab for the same current SSH target by default. An explicit `tab_ref` selects a tab; `new_tab: true` forces creation and cannot be combined with a reference. Check `tab_reusable` and `reused_tab` in results. Busy, disconnected, changed transports or commands with unconfirmed completion cannot be reused. No historical terminal output is read; only the current command's marked output is collected. Output is capped at 4096 UTF-8 bytes and execution collection at 45 seconds. Shell expansion/globbing is not performed.

## File transfer authorization per client and SSH profile

In **Settings → Secure MCP → Named client credentials**, find the client and its SSH profile,
then check **File transfer**. Saving takes effect immediately. Each client/profile pair starts
disabled and is independent of pairing lifetime, SSH connection authorization, command mode,
local command sets and global inheritance. Full access does not enable file transfer. Resetting
the credential clears it; changing the target configuration requires enabling it again after review.

This permission lets the AI read/upload and create/download files using Tabby's OS account.
`local_path` refers to the Tabby machine, even if the AI client runs elsewhere. Both paths must
be absolute and the remote path must be POSIX-style. Only single regular files up to 64 MiB are
supported; destination files must not exist, and parent directories must already exist.
The service deadline is 180 seconds; configure the AI client's timeout accordingly.

After explicitly enabling the pair, use a disposable source and new destinations:

```json
{"name":"upload_ssh_file","arguments":{"profile_ref":"<returned profile_ref>","local_path":"/absolute/local/source.txt","remote_path":"/absolute/remote/new-upload.txt"}}
```

```json
{"name":"download_ssh_file","arguments":{"profile_ref":"<returned profile_ref>","local_path":"/absolute/local/new-download.txt","remote_path":"/absolute/remote/source.txt"}}
```

Results include `status` (`uploaded` or `downloaded`), `bytes_transferred`, and, when retained,
`tab_ref`/`tab_reusable`. Transfer reuses an eligible idle owned connection, otherwise opens a
visible SSH tab after the usual connection authorization. It does not execute shell commands.
Close an unused retained tab with `close_mcp_ssh_tab`.

Turning the checkbox off cancels ongoing transfers. Cancellation cannot undo bytes already
written. A failed upload may leave a partial remote file; `outcome_unknown` also covers a lost
remote creation response. Inspect the file and tab before retrying; the plugin never deletes
uncertain remote destinations or automatically retries them. A failed download removes its
own partial local destination only when it can still identify that file safely.

## Approved command sets

Open Settings → Secure MCP → Named client credentials → SSH profile → Command set. Each client/profile pair is independent. The global default set is initially empty; enabling inheritance applies its future saved changes immediately. The editor marks inherited and local sources. Editing a global rule affects every inheriting pair.

Use Always allow (add to command set) in a command prompt to approve only the displayed family for the current client/profile. The approval is persisted in that client's local SSH command set, not the global set. A connection-only prompt uses Always allow this SSH connection and does not add a command rule. Wrappers and unrecognized forms fall back to exact argv hashes; their original arguments are never stored or exported. An editor can replace an exact rule by entering the new complete command.

Copy exports local draft rules as portable text without inherited rules, tokens, client IDs or SSH grants. Paste it into another target's editor, preview, then choose Merge or Replace and save. Replace and Clear preserve inheritance; turn it off explicitly if the target should use only local rules. Clearing global defaults does not clear local grants. Saved changes and stale-editor conflicts are reported; failed revocations remain denied for the running instance.

Request approval uses these sets to skip repeated prompts. Auto edit still asks for every high-risk or unknown operation even when a matching local/global rule exists. Full access skips command approval, while connection and client authorization continue separately. Clearing a command set does not change these mode-level behaviors.

## Command sessions and interface language

Command sessions stay open by default. In **Settings → Secure MCP → Service → Command sessions**, choose to close a newly created command tab after its completion marker has been received and output captured. This applies to subsequent requests only; reused tabs and tabs created by `open_authorized_ssh_profile` remain open for explicit cleanup.

Secure MCP follows Tabby’s language setting: Simplified Chinese for `zh-CN`, English otherwise. Open settings and approval dialogs update when the language changes. MCP tool names, protocol fields, client/profile names, and command output remain unchanged.

## Errors and recovery

- `file_transfer_disabled`: enable File transfer for this client and SSH profile in Tabby settings.
- `file_exists`: choose a new destination; transfers never overwrite existing files.
- `file_too_large`: the file exceeds the 64 MiB limit.
- `invalid_path`: use absolute paths to regular files; directories and symlinks are unsupported.
- `file_transfer_failed`: check the file, parent directory, permissions and SFTP availability.
- `command_disabled`: enable a command approval mode for this SSH profile in Tabby.
- `unsupported_command`: use one command without shell operators or terminal controls.
- `approval_unavailable`: the authorization could not be saved or validated; the command was not sent. Check Tabby and retry.
- `not_approved`: approve the client or applicable open request, or review its command approval mode. Denial, Escape, blur and timeout do not grant permission.
- `audit_unavailable`: required audit failed before dispatch; repair storage before trying again.
- `outcome_unknown`: the operation may already have happened. Inspect the newly created tab and remote state; do not automatically retry.
- Session 404 after restart: reconnect using the same credential. Permanent/unexpired 24-hour permission is restored; a session-only grant requires a new approval.
- Re-list authorized profiles after reconnect/restart; opaque profile references are not a persistent identifier.
- A connection with an operation still in flight cannot be replaced by another session for that credential; finish/cancel it first.
- Main window closed or port busy: reopen the main window or choose an available port and copy updated client configuration. No automatic window takeover or process killing occurs.
- Private credential storage failure: preserve evidence and restore safe storage/permissions; retry failed revocations before restart. Do not delete a pending update marker without an offline ownership/state check.

Old `command`/`args` stdio entries must be disabled manually. Stop any old companion before installation; the installer does not reclaim its locks. Keep unrelated MCP servers and plugins intact.

## Acceptance evidence

A real AI client must actually invoke all seven tools against the isolated test target. Record client/version, agreed protocol, expected results, reconnect/permanent restoration, revoke/cancel and audit-refusal evidence. Include file transfer default denial, explicit enablement, upload/download content verification, another client's denial and disablement during transfer. Include closing the returned `tab_ref`, refusing another credential's reference and verifying manual tabs remain open. SDK tests supplement this with protocol and failure cases. They do not alone certify AI-tool acceptance or every client on every platform.

### AI-initiated tab cleanup

Save the `tab_ref` returned by `open_authorized_ssh_profile` or by a retained
`run_authorized_ssh_command` session. When finished, call:

```json
{"name":"close_mcp_ssh_tab","arguments":{"tab_ref":"<returned tab_ref>"}}
```

The success result is `{"status":"closed"}`. The client can close only tabs created for its
current credential identity during the current service run; references are not native Tabby tab
or window IDs. Resetting/changing the credential identity or restarting the service invalidates
old references. Manual tabs and other clients' tabs cannot be closed with this tool.
Automatic command-session cleanup remains in effect; an already auto-closed tab has no reference.
Explicit closure disconnects SSH and can interrupt remaining processes; do not assume a truncated
response means the task finished. `outcome_unknown` means closure may have happened; inspect the
tab rather than automatically retrying.
