# Security baseline implementation plan

Goal: provide verifiable security checks and npm release preparation without
publishing, merging or changing dependencies or runtime behavior.

Approved scope: CodeQL security-extended for JS/TS; PR dependency review blocking
new high/critical findings; GitHub dependency alerts and private reporting; public
security policy and dated dependency baseline; package metadata and README; manual
OIDC publishing with provenance. Existing dependency findings stay open.

- [x] Confirm clean `main` baseline and create `codex/security-baseline` in an isolated worktree.
- [x] Enable and read back GitHub vulnerability alerts and private reporting; retain secret scanning and push protection.
- [x] Add pinned CodeQL/dependency-review workflows and security documentation.
- [x] Extend existing package tests RED → GREEN for README and publication metadata.
- [x] Implement and test tag/version/source/main validation RED → GREEN for manual publishing.
- [x] Run workflow lint, typecheck, full tests, integration, build, pack and publish dry run.
- [x] Obtain independent review: no confirmed actionable findings.

Delivery: commit and push this branch, open a PR to `main`, and verify real
security/three-platform CI checks. Remote acceptance is recorded in the PR so that
updating this plan does not itself retrigger all checks.

Implementation decision: manual publishing must be dispatched on the supplied
release tag, rather than dispatching on `main` and checking out another commit.
This keeps the workflow event/source provenance aligned with the release artifact.
The registry currently has no package; bootstrap and npm account configuration remain
explicitly deferred to a later authorized release. No npm token is added.

Verification notes and actual remote check links are recorded in the PR. The dated
dependency baseline is evidence of known findings, not a clean scan or audit.
