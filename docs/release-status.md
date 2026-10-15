# Release status

| Area | Status |
| --- | --- |
| IPC contract, companion, plugin code | Implemented; CI runs typecheck, unit tests, integration tests, build, and pack checks on Ubuntu, macOS, and Windows. |
| Local install script | `npm run install:local` packs and installs pinned `0.1.0` tarballs into Tabby’s plugins directory (Task 7). End-to-end install against a live Tabby instance is **Task 8**. |
| Linux Tabby GUI | **Pending Task 8** — manual smoke test (pairing, approval modal, visible SSH tab) not yet recorded for this milestone. |
| macOS Tabby GUI | **Not GUI-certified** — automated cross-platform tests only. |
| Windows Tabby GUI | **Not GUI-certified** — automated cross-platform tests only. |

Do not treat CI green on macOS/Windows as proof of Tabby UI behavior until the corresponding GUI validation tasks complete.
