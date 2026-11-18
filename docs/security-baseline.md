# Security evidence and dependency baseline

## What the checks mean

- [CodeQL](https://github.com/woodynew/tabby-secure-mcp/actions/workflows/codeql.yml)
  analyzes JavaScript/TypeScript using `security-extended` queries on main/dev pushes,
  PRs into those branches and a weekly schedule. A successful run means analysis
  completed; findings must still be reviewed in GitHub's security interface.
- [Dependency Review](https://github.com/woodynew/tabby-secure-mcp/actions/workflows/dependency-review.yml)
  fails a PR check when the dependency change introduces a known high or critical
  vulnerability. It does not mean existing dependencies are free of vulnerabilities.
  This check is not a branch-protection rule; maintainers must not treat a failed
  check as approval to release.
- [CI](https://github.com/woodynew/tabby-secure-mcp/actions/workflows/ci.yml)
  runs type checking, ordinary/script tests, integration tests, build and package
  checks on Ubuntu, macOS and Windows. Tests do not replace security review.
- GitHub dependency alerts, secret scanning and push protection are enabled.
  Dependency alerts and private vulnerability reports are visible to authorized
  maintainers; public workflow runs and this baseline provide public evidence
  without exposing credentials or confidential reports. Automatic dependency
  upgrades and automatic merging are not enabled by this work.

No independent third-party audit or security certification is claimed. See
[the security policy](../SECURITY.md) and [the runtime boundaries](../README.md#security-scope-and-limitations).

## Baseline: 2026-11-17 (Asia/Shanghai)

Source: `main@7f1eebf5a0c17fb12656c7d43862fd6c08732c49`, the source and lockfile
baseline for the security-preparation branch. Node `24.22.2`, npm `11.19.1`.

```sh
npm audit --package-lock-only --registry=https://registry.npmjs.org --json
```

The command exited **1**, reporting **16 affected package entries**: **3 high,
12 moderate and 1 low**, with no critical entries. These are package-entry counts,
not a count of distinct vulnerabilities or proven exploitable plugin paths.
This is a dated snapshot, not a live "zero vulnerabilities" assertion. Re-run the
command to see the current advisory database. A registry/network error is an
incomplete scan, never a clean result. The local npm mirror returned an unsupported
audit-endpoint error; the explicit official registry is required for reproduction.

After enabling GitHub vulnerability alerts on the same date, GitHub reported
**34 open alerts** (16 high, 15 medium and 3 low). GitHub's advisory-level alerts
and npm's affected-package entries use different units and advisory coverage;
neither number replaces the other. Both sets remain open for review. Private
maintainer alert details are not reproduced here.

| Severity | Affected package entry | Assessment / follow-up |
| --- | --- | --- |
| High | `@angular/common` | Host-related peer dependency; HTTP-client, cache and formatting advisories require applicability review. |
| High | `@angular/compiler` | Build dependency; template/SVG/i18n sanitization advisories require applicability review. |
| High | `@angular/core` | Host-related peer dependency; template/i18n/hydration advisories require applicability review. |
| Moderate | `@angular/animations` | Propagated Angular dependency finding. |
| Moderate | `@angular/compiler-cli` | Angular compiler / Babel dependency findings. |
| Moderate | `@angular/forms` | Propagated Angular dependency finding. |
| Moderate | `@angular/localize` | Angular compiler / Babel dependency findings. |
| Moderate | `@angular/platform-browser` | Propagated Angular dependency finding. |
| Moderate | `@angular/platform-browser-dynamic` | Propagated Angular dependency finding. |
| Moderate | `@ng-bootstrap/ng-bootstrap` | Propagated Angular dependency finding. |
| Moderate | `@vitest/mocker` | Development tooling; npm proposes Vitest `4.1.12`. |
| Moderate | `fast-uri` | URI parsing/normalization advisories; npm reports a fix is available. |
| Moderate | `tabby-core` | Propagated Angular dependency finding. |
| Moderate | `tabby-settings` | Propagated Angular/bootstrap dependency finding. |
| Moderate | `vitest` | Propagated mocker finding; npm proposes `4.1.12`. |
| Low | `@babel/core` | Development tooling; source-map file-read advisory. |

Advisory references for independent verification:

- Angular common: [HTTP-client XSRF](https://github.com/advisories/GHSA-58c5-g7wp-6w37),
  [incomplete XSRF fix](https://github.com/advisories/GHSA-jfgx-762w-99vr),
  [date-formatting DoS](https://github.com/advisories/GHSA-48r7-hpm6-gfxm),
  [number-formatting DoS](https://github.com/advisories/GHSA-p3vc-36g9-x9gr),
  [cache hashing](https://github.com/advisories/GHSA-39pv-4j6c-2g6v),
  [credentialed-response caching](https://github.com/advisories/GHSA-q6f4-qqrg-jv6x),
  [cache-key ambiguity](https://github.com/advisories/GHSA-jhpw-976m-542j),
  [parent-request cache bypass](https://github.com/advisories/GHSA-p297-fm68-3q8c).
- Angular core/compiler: [SVG scripts](https://github.com/advisories/GHSA-jrmj-c5cx-3cw6),
  [SVG/MathML](https://github.com/advisories/GHSA-v4hv-rgfq-gp49),
  [two-way binding](https://github.com/advisories/GHSA-58w9-8g37-x9v5),
  [template namespaces](https://github.com/advisories/GHSA-f3m7-gqxr-g87x),
  [dynamic components](https://github.com/advisories/GHSA-692r-grfm-v8x7),
  [hydration](https://github.com/advisories/GHSA-rgjc-h3x7-9mwg),
  [i18n](https://github.com/advisories/GHSA-prjf-86w9-mfqv),
  [i18n event handlers](https://github.com/advisories/GHSA-jj27-h5hq-8x99),
  [directive host bindings](https://github.com/advisories/GHSA-hh8m-fm6v-7cvg).
- Vitest mocker: [manual mock registration](https://github.com/advisories/GHSA-qxg6-89mg-rqv8),
  [Windows traversal](https://github.com/advisories/GHSA-xp26-3454-mjgp).
- fast-uri: [scheme decoding](https://github.com/advisories/GHSA-w74x-v6f9-j3xg),
  [path equivalence](https://github.com/advisories/GHSA-xhq7-xmqj-769h),
  [host canonicalization](https://github.com/advisories/GHSA-wjr9-j795-jxcr),
  [suffix scheme injection](https://github.com/advisories/GHSA-333x-w4r6-6crp).
- Babel: [source-map file read](https://github.com/advisories/GHSA-4x5r-pxfx-6jf8).

## Baseline disposition (2026-11-17)

All findings remain **open for applicability review**. This change does not dismiss,
accept as safe, suppress or fix them. Angular versions are constrained by the Tabby
host API and need a separate compatibility investigation before upgrading. The
tooling fixes are also deferred by the agreed no-dependency-upgrade scope.

The lockfile includes build, development and peer dependencies. Some code declared
as a development dependency is bundled into the shipped plugin; an `--omit=dev`
scan is therefore insufficient evidence about the shipped bundle. Conversely, a
lockfile advisory alone does not establish that the vulnerable feature is reachable
in the plugin. Future assessments must record evidence for each relevant path.

Before a formal release, review current CodeQL and dependency findings and record
their dispositions. This preparation work does not declare a release safe.

## Dependency fixes (2026-11-18)

Using the same official registry and audit command, the pre-update lockfile
reported **24 affected package entries** (13 high, 10 moderate, 1 low).
The updated lockfile reports **21** (13 high, 8 moderate, 0 low). No critical
entries were reported. Seven advisory IDs disappeared and none were added.

| Dependency | Resolved version | Advisories cleared from this scan |
| --- | --- | --- |
| `vitest` and `@vitest/mocker` | `4.1.12` | [GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8), [GHSA-xp26-3454-mjgp](https://github.com/advisories/GHSA-xp26-3454-mjgp) |
| `fast-uri` via `ajv` | `3.1.9` | [GHSA-w74x-v6f9-j3xg](https://github.com/advisories/GHSA-w74x-v6f9-j3xg), [GHSA-xhq7-xmqj-769h](https://github.com/advisories/GHSA-xhq7-xmqj-769h), [GHSA-wjr9-j795-jxcr](https://github.com/advisories/GHSA-wjr9-j795-jxcr), [GHSA-333x-w4r6-6crp](https://github.com/advisories/GHSA-333x-w4r6-6crp) |
| `@babel/core` via `@angular/compiler-cli` and `@angular/localize` | `7.29.6` | [GHSA-4x5r-pxfx-6jf8](https://github.com/advisories/GHSA-4x5r-pxfx-6jf8) |

- **Angular**: [Tabby 1.0.238](https://github.com/Eugeny/tabby/blob/v1.0.238/package.json)
  uses Angular 15. The plugin loads Angular framework modules from the host and
  keeps its Angular 15 compiler for compatibility. The Angular advisories above
  remain open for applicability review. The install-time deprecation warnings
  for `glob@8.1.0` and `inflight@1.0.6` come through `@angular/localize → glob → inflight`.
- **picomatch**: the latest published `4.0.7` was still affected by
  [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) and
  the advisory listed no patched version at review time. This drives build
  and test dependency findings, including the remaining Vitest entry after
  upgrading to `4.1.12`. Recheck the compatible 2.x and 4.x dependency
  paths when a supported fix is available.

The clean install resolved all target versions. The companion build input
list contained the MCP SDK's validator adapter and no direct `fast-uri`
package files, so the `fast-uri` finding is reported as a lockfile fix.
Type checking, template compilation, tests, build, and package checks passed.
An isolated macOS Tabby 1.0.238 instance loaded the rebuilt package and
displayed the Secure MCP Clients and Service settings with the service stopped.

The remaining scan results stay open. This update does not dismiss alerts or
determine whether a remaining advisory is reachable in a deployed plugin.
