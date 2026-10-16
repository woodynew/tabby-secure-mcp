# Release status

| Area | Status |
| --- | --- |
| IPC contract, companion, plugin code | Implemented; CI runs typecheck, unit tests, integration tests, build, and pack checks on Ubuntu, macOS, and Windows. |
| Local install script | `npm run install:local` packs and installs pinned `0.1.0` tarballs; verified end to end against the local Tabby plugins directory. |
| Linux Tabby GUI | **Manually validated on Tabby 1.0.238** — plugin discovery, settings whitelist persistence, delayed pairing approval, minimal list projection, 30-second open approval, visible SSH tab, and `whoami` output `env`. |
| macOS Tabby GUI | **Not GUI-certified** — automated cross-platform tests only. |
| Windows Tabby GUI | **Not GUI-certified** — automated cross-platform tests only. |

Do not treat CI green on macOS/Windows as proof of Tabby UI behavior until the corresponding GUI validation tasks complete.

The npm host API peers remain pinned to the latest published compatible packages,
`tabby-core` and `tabby-settings` `1.0.231-nightly.0`; the Linux GUI smoke test above
is the compatibility evidence for the Tabby 1.0.238 application build.
