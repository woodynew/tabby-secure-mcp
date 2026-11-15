# Connect an AI tool to Tabby's MCP service

Install the single Tabby plugin, restart Tabby, and use **Settings → Secure MCP** in its main window. No companion command, npx invocation, system Node path, stdio shim or external daemon is needed by the AI client.

## Connection requirements

The AI tool must support **MCP Streamable HTTP** and a custom **Authorization** header. This local native-client service uses JSON responses, accepts POST/DELETE, and answers standalone GET with 405. Browser-origin requests and remote access are not supported. Client configuration field names vary; use its HTTP transport setup rather than a stdio command.

1. Add an SSH profile with a dedicated low-privilege test account and verify the connection manually.
2. Whitelist it and choose `readonly` initially.
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

These four actions keep the token and client name: reconnect the AI tool using its existing configuration. Current in-flight requests are cancelled. If persistence fails, the client remains denied for the current Tabby run and the settings page asks you to retry before restarting. A later revocation always overrides an earlier permission update.

**Revoke client** removes the credential entirely, so its old token cannot reconnect. **Reset credential** creates a new token and requires copying the updated MCP configuration. Other clients and SSH profile grants remain independent.

Permanent client permission grants access to the MCP tools, not blanket SSH control. Whitelists, effective target digests, open approvals and command tiers apply on every request. Profile configuration changes can invalidate saved SSH grants independently of client permission.

## SSH connection authorization per client

Each named client's card lists the globally whitelisted SSH profiles under **SSH connection authorization**. Select **Permanently allow** or **Ask when used**, then click **Apply connection authorization**. A client does not need to be online, or to have connected previously, to receive this permission.

- **Permanently allow** remembers permission for this credential and profile, including across Tabby restarts. Both opening an SSH tab and running a command that creates a tab check it. Command tiers remain separately enforced.
- **Ask when used** clears the saved permission. The next applicable tool call shows the connection approval dialog; Allow saves permission only for that client and profile. Reject, cancellation, blur and timeout do not grant permission.
- **Profile changed — authorization required** means its saved security digest no longer matches. Review the profile, select Permanently allow, and apply again, or approve its next request.

Clients with identical names remain independent. Renaming a client or editing its pairing lifetime retains its SSH connection permissions. Resetting its credential clears both pairing and connection permissions; revoking it deletes them. Revocation prevents pending requests from opening connections or sending commands, but cannot undo a command already sent to the remote machine.

The former profile-wide remembered-open grants are not inherited by clients. Existing whitelist selections and command tiers remain; set the new per-client permissions or use the next approval dialog. The private credential format upgrades from version 1 to version 2 on the next successful save without rotating tokens. Older plugin versions cannot read version 2; preserve a private backup before attempting a downgrade.

`get_ssh_operation_authorization` reports `open_session` for the authenticated client and target. It never changes permission. Failed persistence remains visible in settings, and failed revocations remain denied for the running instance until safely saved.

## First calls

Ask the AI tool to call these in order:

1. `list_authorized_ssh_profiles` — only explicitly whitelisted names/references should appear.
2. `get_ssh_operation_authorization` for the returned reference.
3. `open_authorized_ssh_profile` — approve the visible Tabby prompt if required.
4. `run_authorized_ssh_command` with `whoami`, `id` or `pwd`.

Commands use a new visible tab and never read an existing terminal. Output is capped at 4096 UTF-8 bytes and execution collection at 45 seconds. See the README for allowed low/medium argument combinations; shell expansion/globbing is not performed.

## Command sessions and interface language

Command sessions stay open by default. In **Settings → Secure MCP → Command sessions**, choose to close a dedicated command tab after its completion marker has been received and output captured. This applies to subsequent requests only; existing tabs and tabs created by `open_authorized_ssh_profile` remain open.

Secure MCP follows Tabby’s language setting: Simplified Chinese for `zh-CN`, English otherwise. Open settings and approval dialogs update when the language changes. MCP tool names, protocol fields, client/profile names, and command output remain unchanged.

## Errors and recovery

- `not_approved`: approve the client or applicable open request, or review the SSH tier. Denial, Escape, blur and timeout do not grant permission.
- `audit_unavailable`: required audit failed before dispatch; repair storage before trying again.
- `outcome_unknown`: the operation may already have happened. Inspect the newly created tab and remote state; do not automatically retry.
- Session 404 after restart: reconnect using the same credential. Permanent/unexpired 24-hour permission is restored; a session-only grant requires a new approval.
- Re-list authorized profiles after reconnect/restart; opaque profile references are not a persistent identifier.
- A connection with an operation still in flight cannot be replaced by another session for that credential; finish/cancel it first.
- Main window closed or port busy: reopen the main window or choose an available port and copy updated client configuration. No automatic window takeover or process killing occurs.
- Private credential storage failure: preserve evidence and restore safe storage/permissions; retry failed revocations before restart. Do not delete a pending update marker without an offline ownership/state check.

Old `command`/`args` stdio entries must be disabled manually. Stop any old companion before installation; the installer does not reclaim its locks. Keep unrelated MCP servers and plugins intact.

## Acceptance evidence

A real AI client must actually invoke all four tools against the isolated test target. Record client/version, agreed protocol, expected results, reconnect/permanent restoration, revoke/cancel and audit-refusal evidence. SDK tests supplement this with protocol and failure cases. They do not alone certify AI-tool acceptance or every client on every platform.
