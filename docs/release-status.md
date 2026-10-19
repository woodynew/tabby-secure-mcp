# Release status

| Area | Status |
| --- | --- |
| IPC contract, companion, plugin code | Implemented; CI runs typecheck, unit tests, integration tests, build, and pack checks on Ubuntu, macOS, and Windows. |
| Local install script | `npm run install:local` packs and installs pinned `0.1.0` tarballs; verified end to end against the local Tabby plugins directory. |
| Linux Tabby GUI | **Manually validated on Tabby 1.0.238** for the original whitelist, pairing, and open flow. The later permanent-grant settings have automated coverage and have not been re-certified in the Tabby window. |
| macOS Tabby GUI | **Not GUI-certified** — automated cross-platform tests only. Real Tabby window acceptance is deferred. |
| Windows Tabby GUI | **Not GUI-certified** — automated cross-platform tests only. Real Tabby window acceptance is deferred. |
| Permanent open memory and SSH command tiers | Implemented. Approving an open stores a permanent open grant. Settings manage none / readonly / readwrite / full as SSH command classes. `get_ssh_operation_authorization` reports that grant. Per-command execution is not in this phase. |

Do not treat CI green on macOS/Windows as proof of Tabby UI behavior until the corresponding GUI validation tasks complete.

The npm host API peers remain pinned to the latest published compatible packages,
`tabby-core` and `tabby-settings` `1.0.231-nightly.0`; the Linux GUI smoke test above
is the compatibility evidence for the Tabby 1.0.238 application build.
