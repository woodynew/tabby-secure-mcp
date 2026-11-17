# SSH Command Approval Modes Implementation Plan

> **For agentic workers:** Execute task-by-task with TDD; use parallel workers only for the disjoint policy and credential-store modules, then integrate and independently review the complete change.

**Goal:** Replace SSH command tiers with ask/auto_edit/full, editable client/SSH command sets, live global defaults and portable copy/paste.
**Architecture:** Extend the existing single-command parser and approval gate. Shared pure policy/rule codecs live in ipc-contract; the existing private credential file owns local sets, default rules and optimistic revisions; Tabby config keeps per-profile mode.
**Tech Stack:** Existing TypeScript, Angular 15, Node 24, Vitest, zod; no new dependencies.
**Spec:** ../specs/2026-11-16-command-approval-modes-design.md (approved by user on 2026-11-16).

## Global Constraints

- Single command, 512 UTF-8 bytes, no raw terminal controls or shell composition.
- Approval window 60 seconds; blur, Escape, cancellation and timeout deny.
- Modes ask / auto_edit / full; disabled remains none; legacy readonly/readwrite migrate to ask.
- Identity = credential ID + generation + SSH ID + digest; global defaults initially empty and inherited.
- Auto-edit high/unknown always asks; full only bypasses command approval.
- No install, commit, push, publish or personal configuration changes.
- Every shell command starts with rtk. Reuse installed Node 24.22.2 and copied workspace dependencies.

## Review Focus

- Option ordering/wrappers cannot widen a saved family into mutation or arbitrary execution (Task 1).
- Clearing inherited rules really empties the effective set; stale editors and failed saves cannot restore permission (Task 2/4).
- Approval and credential changes while SSH initializes prevent dispatch (Task 3).
- Imported exact hashes reveal no command arguments and rebind to target identity (Task 1/2/4).
- Legacy/stale grants cannot silently become automatic editing (Task 3/4).

## Task 1: Shared command policy and portable rules

Files: create ipc-contract/src/command-policy.ts and tests; export in src/index.ts; update plugin authorization/ssh-command.ts and operation-tier-policy.ts and tests.
Produces:
- ApprovalMode = 'ask' | 'auto_edit' | 'full'; CommandRisk = 'low' | 'high' | 'unknown'.
- ApprovedCommandRule = {kind:'family',version:1,argv:string[]} | {kind:'exact',version:1,program:string,hash:string}.
- analyzeSshCommand(raw): {command,program,argv,risk,reason,rule,commandClass} | null. command is safely quoted for dispatch, rule from validated known family or full normalized argv hash.
- validateApprovedCommandRules(value): ApprovedCommandRule[] (throws on invalid; canonical dedup).
- commandRuleMatches(rule, analysis): boolean; commandRuleLabel(rule): string.
- commandRuleFromText(text, kind:'family'|'exact'): ApprovedCommandRule.
- exportCommandSet(rules): string; importCommandSet(text): ApprovedCommandRule[] with versioned payload and no identity fields.
- Keep existing plugin parse/authorize export names as small delegates; GrantedOperationTier becomes 'none' | ApprovalMode. publicOperationTierPolicy reports {mode,label,auto_approve:'none'|'low_risk'|'all'}.

- [x] Write and run failing tests for the four reported queries, mutation/unknown options, quoting, wrappers, 512-byte/control boundaries, exact hashing and malformed portable data.
- [x] Implement without adding dependencies. Family matching revalidates arguments/risk; exact hash never authorizes variants. cp/mv/deletions are high.
- [x] Run relevant IPC and plugin policy tests; record RED/GREEN.

## Task 2: Credential v3 and editable command-set storage

Files: companion/src/http/contracts.ts, credentials.ts; companion credential tests.
Consumes shared rule types/validator from Task 1.
Produces required CredentialStorePort methods:
- commandRevision(): number (conservative service-wide command authorization version).
- defaultCommandSet(): {rules:ApprovedCommandRule[],revision:number}.
- commandSet(client,profileId,profileDigest): {profileId,profileDigest,inheritDefaults,rules,defaultRules,revision,stale}.
- setDefaultCommandSet(rules,expectedRevision): Promise<void>.
- setCommandSet(client,profileId,profileDigest,{inheritDefaults,rules},expectedRevision,stillCurrent?:()=>boolean): Promise<void>.
ClientConnectionPermissions may expose command methods optionally for legacy test fixtures; production CredentialStorePort requires them.

- [x] Add/run failing tests for live defaults, per-client/profile isolation, clear/replace semantics, version conflicts, revoke/reset, v1/v2 load and v3 save, file/count limits, queued reductions and failed-save denial.
- [x] Extend the same private snapshot/serial persistence, top-level defaultCommands and credential commandSets. Legacy records initialize empty; absent local set inherits defaults, mismatched digest returns stale and no effective rules.
- [x] Revision changes at request time invalidate pending execution. Reductions fail closed before disk write; failed reductions remain disabled; increases activate after successful save. Capture input and optimistic revision before queueing; callbacks stop expired/cancelled grants.
- [x] Canonical rules at most 128/client across sets and 128 global, existing 64 KiB total file limit; export never includes credential identity.
- [x] Run companion credential regression tests and typecheck.

## Task 3: Modes, command approval and MCP integration

Files: plugin config/permanent-authorization-store, approval gatekeeper/presenter/modal, runtime; IPC messages; companion MCP server/dispatcher/errors.
Consumes Task 1 analysis/policy and Task 2 store API.

- [x] Add/run failing tests for migrated grants, ask once/remember, merged connection+command prompt, auto-edit high always asks, full, cancellation/clear/mode changes before send.
- [x] Keep internal legacy operationTier property for storage compatibility but accept new values and migrate old reads conservatively. MCP output becomes approval_mode (none/ask/auto_edit/full), policy modes and command_risk; four input tools unchanged.
- [x] Add presentCommand(viewModel,context): Promise<'deny'|'allow'|'remember'> with command/risk/reason/rule label and remember availability. Reuse modal deadline, focus and 60-second lifecycle.
- [x] Capture config + credential command revisions, enforce before opening and before sending, and commit remembered permissions only while request current. Preserve per-client connection grants and avoid duplicate prompts.
- [x] Add distinct safe error codes for command disabled, unsupported syntax and approval persistence failure; preserve cancellation/expiry/outcome-unknown.
- [x] Run affected plugin/IPC/MCP tests and typecheck.

## Task 4: Settings, command-set editing and copy/paste

Files: plugin settings component/view-model/template, i18n/messages, related tests.
Consumes Tasks 1-3 APIs.

- [x] Add/run failing settings tests for modes, local/global editor snapshots, validation, duplicate merge, replace/clear disabling inheritance, version conflict and clipboard failure.
- [x] Display modes and command-set sources; editors use human-readable family/exact inputs and record labels. Exact hash editable by replacing with newly entered full command, never restore old arguments.
- [x] Copy effective rules (global + local dedup); paste into preview and explicitly save merge/replace. Global editor targets global only. No clipboard reads; browser writeText only on explicit copy action.
- [x] Preserve sets across mode switches, refresh settings on runtime/config changes without overwriting dirty editor data.
- [x] Update Chinese and English text and regression tests.

## Task 5: Complete verification and review

- [x] Update README, client setup and release/migration evidence.
- [x] Run npm run typecheck; npm test; npm run test:integration; npm run build; npm run pack:check; git diff --check.
- [x] Independently review whole diff including new/untracked files, fix consequential findings with regression checks.
- [x] If real Tabby/SSH validation cannot run without touching personal installation, report it separately; do not equate fixtures with real acceptance.

## Execution Record

User authorized implementation; no extra plan approval round. Worktree codex/command-approval-modes from dev@b172cc9. Product changes remain uncommitted; source workspace draft preserved. Parent owns integration; worker changes are disjoint.

Final: all five tasks complete. Verification Node24.22.2: typecheck, 478 unit/script tests (IPC46 + companion139 + plugin247 + scripts46), 4 HTTP integration tests, full workspace build via npm test, pack check and diff check passed. Independent reviewers identified command-version absorption, cancelled connection persistence and cancellation rollback evidence; regression tests observed RED and passed GREEN after fixes. No unaddressed consequential findings reported; fixes verified by the implementer, not a second independent review.
Ruling: portable export/import may contain 256 effective rules; each stored local/global set retains its 128-rule bound. Oversized target merges reject atomically; explicit imports are not silently reclassified as inherited-only rules.

Review correction 2026-11-16: request-scoped memory remains durably guarded while execution runs, synchronous final marker commit, owned-revision compensation preserves existing/operator rules, and dynamic approval details localized. RED/GREEN regression plus 507 unit/script tests and 4 HTTP integration tests passed; typecheck/build/pack/diff passed. Bounded independent recheck found no new confirmed issue. Replacement candidate and hashes in docs/remediation/COMMAND-APPROVAL-MODES.md. No commit, push, publication or personal installation.
