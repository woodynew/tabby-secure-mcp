# MCP interface reference

Tabby Secure MCP exposes a local [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/latest/basic/transports)
endpoint at `http://127.0.0.1:50333/mcp` by default. Use the URL and
`Authorization: Bearer <client-token>` header copied from **Tabby → Settings →
Secure MCP**. See the [client setup guide](configure-mcp-clients.md) for enabling
the endpoint and managing credentials.

## Transport and result format

- A native MCP client initializes over POST with `Content-Type: application/json`.
  Include the returned `Mcp-Session-Id` on subsequent requests. The endpoint
  accepts POST and session DELETE and returns JSON responses. A standalone GET
  returns 405. Requests must use IPv4 loopback and the corresponding `Host`
  header. Requests with an `Origin` header are refused.
- Each tool requires a current client credential and approved MCP session. The
  Tabby UI is where users manage whitelists, connection grants, command modes,
  and file transfer permissions.
- Send tool arguments as an object in `tools/call.params.arguments`. The tools
  reject unknown arguments. `profile_ref` and `tab_ref` are opaque strings of
  1–256 UTF-16 code units. Obtain them from results and treat them as scoped
  to the current Tabby runtime. Tab references belong to the creating client.
- Successful calls return the object below in `result.structuredContent` and
  the same object serialized as JSON text in the first `result.content` item.
  Optional fields are omitted when unavailable.

For example, after initializing and obtaining approval, an MCP request to
list profiles has this JSON body:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": { "name": "list_authorized_ssh_profiles", "arguments": {} }
}
```

## Tools

| Tool | Arguments | Success: `structuredContent` | Additional authorization and behavior |
| --- | --- | --- | --- |
| `list_authorized_ssh_profiles` | `{}` | `profiles`: array of objects with `profile_ref` and `display_name` strings. May be empty. | Lists profiles on the MCP whitelist. Being listed does not grant the client access to connect. |
| `open_authorized_ssh_profile` | `profile_ref` | `status: "opened"`, optional `tab_ref` and `tab_reusable` (boolean) | Requires a whitelisted profile and connection authorization for the client. Opens a new, visible SSH tab. |
| `get_ssh_operation_authorization` | `profile_ref` | `profile_ref`, `open_session` (boolean), `approval_mode`, `authorizes: "ssh_command"`, `policy` (array, below) | Reads current connection and command policy for the whitelisted profile. Does not grant permission. |
| `run_authorized_ssh_command` | `profile_ref`, `command`; optional `tab_ref`, `new_tab` (boolean) | `status`: `"completed"` or `"truncated"`; `command_risk`: `"low"`, `"high"` or `"unknown"`; `output` (string), `truncated` (boolean); optional `tab_ref`, `tab_reusable`, `reused_tab` | Requires current connection authorization and compliance with the command mode. Reuses an eligible idle tab by default. |
| `close_mcp_ssh_tab` | `tab_ref` | `status: "closed"` | Closes a tab created for this client through MCP. Closing a session may interrupt remote work. |
| `upload_ssh_file` | `profile_ref`, `local_path`, `remote_path` | `status: "uploaded"`, `bytes_transferred` (nonnegative integer); optional `tab_ref`, `tab_reusable` | Copies one local file to a new remote path. Requires connection authorization and separately enabled file transfer for this client and profile. |
| `download_ssh_file` | `profile_ref`, `local_path`, `remote_path` | `status: "downloaded"`, `bytes_transferred` (nonnegative integer); optional `tab_ref`, `tab_reusable` | Copies one remote file to a new local path. Requires the same separate permission as upload. |

### Policy and limits

- `open_session` reports the currently recorded connection permission.
  `approval_mode` is `none`, `ask`, `auto_edit`, or `full`. Each `policy`
  entry has `mode` (`ask`, `auto_edit`, or `full`), a display `label`, and
  `auto_approve` (`none`, `low_risk`, or `all`). See
  [SSH command approval modes](../README.md#ssh-command-approval-modes).
- `command` is a single command of 1–512 UTF-8 bytes. Shell operators and raw
  terminal control characters are rejected. `new_tab: true` always opens a
  new tab and cannot be combined with `tab_ref`. An unusable explicit
  `tab_ref` fails without opening a replacement. Output is capped at 4096 UTF-8
  bytes. `completed` indicates that completion was observed. `truncated` is
  not evidence that the remote process has stopped.
- `tab_reusable: true` indicates that the returned tab is currently eligible
  for reuse. `reused_tab` indicates that the command used a retained tab.
  A reference can be omitted, including when the tab was automatically closed.
  A returned but non-reusable tab may have been taken over manually.
- `local_path` refers to the machine running Tabby. `remote_path` is a POSIX
  path on the SSH host. Both must be absolute strings of up to 4096 UTF-16 code
  units and 8192 UTF-8 bytes, without control characters. Transfers use native
  SFTP and accept one regular file up to 64 MiB. Parent directories must exist
  and the destination must be new. Transfers do not accept a `tab_ref` argument.
- The service allows up to 60 seconds for opening a profile, 105 seconds for
  a command (approval plus collection) and 180 seconds for a transfer.
  Set the client timeout high enough to allow for any approval prompt.

## Errors and recovery

HTTP and JSON-RPC errors are separate from tool results. Common HTTP failures
are 401 (invalid credential), 403 (forbidden request), 404 (endpoint or session
missing), 405 (unsupported method), 413 (body or value exceeds a limit), 415
(JSON content type required), 429 (initialization rate limit), or 503 (service
or session capacity temporarily unavailable).

If a tool reports failure, `result.isError` is `true` and the first
`result.content` item contains a readable message. The internal identifiers
below are used by the service. They are not machine-readable fields in the
tool result. Clients should avoid branching on the precise message text.

| Situation | What the caller can do |
| --- | --- |
| Target unavailable or operation not approved (`target_unavailable`, `not_approved`, `command_disabled`) | Check the whitelist, the selected profile, and the relevant client permissions in Tabby. |
| Unsupported command or invalid path (`unsupported_command`, `invalid_path`) | Check the input format and limits above. |
| Transfer blocked (`file_transfer_disabled`, `file_exists`, `file_too_large`, `file_transfer_failed`) | Check file transfer permission, the destination and file size, and inspect Tabby before retrying. |
| Approval or audit unavailable (`approval_unavailable`, `audit_unavailable`) | Check the approval store or audit status in Tabby before trying again. |
| Busy, rate limited, expired, or cancelled | Check client and Tabby status and the outcome of the previous request. |
| Operation may have taken effect (`outcome_unknown`) | Inspect the SSH tab and any destination file. Do not automatically repeat the operation. This also applies when a disconnect leaves execution status uncertain. |

The [tool registration](../packages/companion/src/mcp/server.ts) and
[result schemas](../packages/ipc-contract/src/messages.ts) define the current
wire contract.
