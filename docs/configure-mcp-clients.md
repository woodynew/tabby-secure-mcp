# Configure MCP clients for tabby-secure-mcp

Use the local stdio companion installed by `npm run install:local`. Do not use `npx`, `@latest`, shell wrappers, or HTTP transports for this server.

## Prerequisites

- **Node.js** `>= 20.19` on the same machine as Tabby and your MCP client.
- **Tabby** running with the `tabby-secure-mcp` plugin loaded (restart Tabby after installing the plugin).
- Install packages into Tabby’s plugins directory and capture the companion command:

```bash
npm run install:local -- --plugins-dir "/absolute/path/to/tabby/plugins"
```

The script prints two lines: the resolved plugins directory, then the **absolute path** to the `tabby-secure-mcp` companion binary. Use that path verbatim in client configuration.

Default Tabby plugins locations (override with `--plugins-dir`):

| OS | Default plugins directory |
| --- | --- |
| Linux | `~/.config/tabby/plugins` |
| macOS | `~/Library/Application Support/tabby/plugins` |
| Windows | `%APPDATA%\tabby\plugins` (falls back to `%USERPROFILE%\AppData\Roaming\tabby\plugins`) |

Companion binary after install:

| OS | Example absolute command |
| --- | --- |
| Linux / macOS | `/home/you/.config/tabby/plugins/node_modules/.bin/tabby-secure-mcp` |
| Windows | `C:\Users\you\AppData\Roaming\tabby\plugins\node_modules\.bin\tabby-secure-mcp.cmd` |

## Behavior you should expect

- The server exposes **only two tools**: list authorized SSH profiles (read-only) and open one authorized profile in a visible Tabby SSH tab. There is **no command execution or output streaming** tool.
- The **first** tool call from a new MCP client triggers **pairing** in Tabby (approve or deny the client).
- Every **open** request shows a **30 second** approval modal in Tabby; timeout, Escape, closing the modal, or Tabby losing focus results in denial.
- Profile listing is **read-only**; whitelisting happens only in Tabby settings.
- **Tabby must be running** with the plugin active and the main window holding the companion lease for operations to succeed.

Whitelist profiles under Tabby **Settings → Secure MCP** (authorized SSH profiles). Only non-template SSH profiles you explicitly enable appear in MCP list results.

## Cursor

- **User/global config:** `~/.cursor/mcp.json` on Linux and macOS (`%USERPROFILE%\.cursor\mcp.json` on Windows).
- **Project config:** `.cursor/mcp.json` in the repository.

```json
{
  "mcpServers": {
    "tabby-secure-mcp": {
      "command": "/absolute/path/to/tabby/plugins/node_modules/.bin/tabby-secure-mcp",
      "args": []
    }
  }
}
```

On Windows, use the `.cmd` shim with escaped backslashes in JSON:

```json
{
  "mcpServers": {
    "tabby-secure-mcp": {
      "command": "C:\\Users\\you\\AppData\\Roaming\\tabby\\plugins\\node_modules\\.bin\\tabby-secure-mcp.cmd",
      "args": []
    }
  }
}
```

Restart Cursor or reload MCP servers after saving.

## Claude Code (CLI)

Add a user-scoped stdio server (replace the command with your install output):

```bash
claude mcp add --transport stdio --scope user tabby-secure-mcp -- \
  /absolute/path/to/tabby/plugins/node_modules/.bin/tabby-secure-mcp
```

Inspect configured servers:

```bash
claude mcp list
```

Remove when needed:

```bash
claude mcp remove tabby-secure-mcp --scope user
```

Use the Windows `.cmd` path as the command argument on Windows.

## Claude Desktop

Edit the Claude Desktop MCP config file for your OS and add:

| OS | Config path |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Linux native Claude Desktop config paths are not documented here; use Claude Code or another supported client on Linux if Desktop is unavailable.

```json
{
  "mcpServers": {
    "tabby-secure-mcp": {
      "command": "/absolute/path/to/tabby/plugins/node_modules/.bin/tabby-secure-mcp",
      "args": []
    }
  }
}
```

Fully quit and restart Claude Desktop after changes.

## Windsurf

Edit the Windsurf MCP config file (create it if missing):

| OS | Config path |
| --- | --- |
| Linux / macOS | `~/.codeium/windsurf/mcp_config.json` |
| Windows | `%USERPROFILE%\.codeium\windsurf\mcp_config.json` |

```json
{
  "mcpServers": {
    "tabby-secure-mcp": {
      "command": "/absolute/path/to/tabby/plugins/node_modules/.bin/tabby-secure-mcp",
      "args": []
    }
  }
}
```

On Windows, use the `.cmd` path with JSON escaping as in the Cursor example.

## Troubleshooting

### Companion runtime directories

The stdio companion stores IPC metadata outside the Tabby plugins directory. Only remove files you recognize as stale **after** stopping every MCP client and confirming no `tabby-secure-mcp` companion process is running. Do not delete artifacts belonging to a live companion PID.

| OS | Runtime directory | Typical files |
| --- | --- | --- |
| Linux | `$XDG_RUNTIME_DIR/tabby-secure-mcp` or `/tmp/tabby-secure-mcp` | `descriptor.json`, `companion.lock`, `companion.sock` |
| macOS | `$TMPDIR/tabby-secure-mcp` (for example `/var/folders/.../tabby-secure-mcp`) | `descriptor.json`, `companion.lock`, `companion.sock` |
| Windows | `%LOCALAPPDATA%\tabby-secure-mcp` | `descriptor.json`, `companion.lock` (named pipe endpoint; do not delete pipes manually) |

### Fail-closed installer safety

`install:local` refuses to modify runtime artifacts when the descriptor or lock is a symbolic link, malformed, oversize, or paired with a live companion PID (including lock-only startup). **Rerunning the installer does not automatically repair corruption** in those cases. Stop all companion clients, end stray `tabby-secure-mcp` processes, manually inspect the runtime directory above, remove only the known stale files when no live PID holds them, then rerun install.

When cleanup is allowed (dead PIDs only), the installer may remove stale `descriptor.json`, `companion.lock`, and the Unix socket. It never deletes Windows named pipes.

| Symptom | What to try |
| --- | --- |
| Installer refuses to run | Follow **Fail-closed installer safety** above. Quit MCP clients, stop companion processes, inspect the runtime directory manually, then rerun `install:local`. |
| Pairing never appears | Confirm Tabby is open, the plugin is installed under the plugins directory Tabby loads, and you restarted Tabby after install. |
| Opens always denied | Check the 30s modal in Tabby, whitelist the profile in Secure MCP settings, and ensure you are approving the correct client. |
| Stale IPC after crashes | Only when the installer reports a cleanable stale state: rerun `npm run install:local`. Otherwise use manual runtime cleanup (see above). On Windows, named pipes are not deleted by the installer. |
| Wrong server version | Reinstall with `npm run install:local` so `tabby-secure-mcp` and `@tabby-secure-mcp/companion` stay at the same pinned version (`0.1.0`). |

## Validation scope

Client JSON shapes above follow published MCP stdio configuration patterns. **macOS and Windows** builds are exercised in CI (unit, integration, pack checks); **Linux GUI validation in real Tabby is pending Task 8**. Automated CI does not certify a specific Cursor, Claude, or Windsurf client version—retest after client upgrades.
