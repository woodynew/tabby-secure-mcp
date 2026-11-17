# Release status

Updated 2026-11-15. **Embedded Streamable HTTP repair candidate**, based on main@49a9797, maintained on `codex/secure-mcp-remediation`; unpushed and unpublished. This replaces the standalone stdio delivery design.

The current source adds foreground activation requests for approval, a shared 60-second approval window, per-client pairing lifetime editing/clearing, and independent per-client SSH connection preauthorization for both open and command tools. See [approval controls](remediation/APPROVAL-CONTROLS.md), [client connection authorization](remediation/CLIENT-CONNECTION-AUTHORIZATION.md) and [client setup](configure-mcp-clients.md). Rebuild/reinstall the plugin to use these changes; personal installation/configuration was not modified automatically.

Current follow-up verification on macOS / Node 24.22.2: typecheck, workspace build, 345 ordinary/script tests, 4 integration tests and pack check passed. Independent review identified a stale settings snapshot issue; it was reproduced and fixed with regression coverage. Native Tabby UI access was blocked by the computer-use tool, and the isolated plugin endpoint was not confirmed running; no new real GUI / AI / SSH acceptance is claimed. Foreground OS behavior, Node 20 and remote CI were not rerun for this follow-up.

The table and hashes below record the **2026-11-08 baseline**. Its actual AI/SSH evidence is for that older artifact; it does not certify the new approval-controls build.

| Area | Status |
| --- | --- |
| Single-plugin MCP | Implemented inside the main Tabby window. One self-contained plugin package; no standalone companion process/client-side Node command. |
| Named client credentials | Implemented: create, edit name, copy generic connection configuration, reset and revoke independently. Names never select authorization. |
| Client approval lifetime | Session /24 hours /permanent. Permanent survives reconnect and Tabby restart until revoked/reset. SSH grants remain independent. |
| Local macOS automation | Node 20.19.0 and 24.22.2: all ordinary/script groups: 314 tests; integration: 2; typecheck/build/pack passed. Final presenter-only fix reran plugin 150 and relevant checks. |
| Independent Linux automation | Debian 12 arm64 / Node 20.19.0: same 314 ordinary/script and 2 integration tests, clean CI order, typecheck/build/pack passed. Snapshot/delta evidence retained. |
| Generic actual AI acceptance | Passed with a real AI tool calling all four tools once against an owned low-privilege localhost SSH fixture. The client/version used is recorded as evidence, not a product-specific requirement. |
| macOS Tabby 1.0.238 | Actual install/settings, named credentials, permanent restart recovery, first-frame approval identity, real SSH output, truncation, cancellation, audit refusal/recovery and credential reset/revoke validated. |
| Remaining GUI certification | Physical OS focus loss, full multiwindow matrix and long-running GUI rotation not certified; full controlled macOS trial certification remains pending. |
| Ubuntu/macOS/Windows remote CI | Node 20.19.0 workflow retained. This unpushed candidate did not trigger a remote run; Debian does not establish Ubuntu/Windows success. |
| Linux /Windows GUI | Not certified for this candidate. |

No runtime dependencies or versions were upgraded. Internal source workspace companion is a private bundled build library. Installer preserves unrelated registered plugins and legacy runtime evidence, and never starts/removes an old companion automatically.

Only one active Tabby instance per credential directory is supported; secondary windows are read-only. Separate instances must isolate credential/config roots. Pending credential updates and failed revocations fail closed; recover only after an offline state check.

Candidate tarball SHA256: `c402b5ef355d1f8394d78cae5e67ac84ecbdae4b0952e19017be607fa88fe832`.
Entry SHA256: `35d9b5487d964d64a729856c48d7198a1f0feeb32c35c6feb6fab507961790a2`.

See [implementation and test evidence](remediation/HTTP-IMPLEMENTATION.md), [actual acceptance](remediation/HTTP-ACCEPTANCE.md), and [generic client setup](configure-mcp-clients.md). Historical stdio reports remain as history and do not certify this HTTP architecture.
