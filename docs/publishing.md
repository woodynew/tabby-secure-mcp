# npm release preparation

**Preparation only:** this change does not publish a package, create a release tag,
configure an npm account or establish package provenance. The intended public package
is `tabby-secure-mcp`; the root workspace and both internal libraries remain private.

## What is prepared

The [manual publish workflow](../.github/workflows/publish.yml) uses a GitHub-hosted
Ubuntu runner, Node `24.22.2`, npm OIDC and provenance. It has no push, PR, tag-push,
schedule or GitHub-release trigger. No long-lived npm token is required or stored.

The operator must dispatch the workflow **on the release tag**, with the identical
`tag` input. The workflow checks the canonical repository, stable `vX.Y.Z` syntax,
the event/tag/checked-out commit, the plugin package version and inclusion in `main`
before installing dependencies. Dispatching on `main` and merely supplying a tag
is refused. Using the tag as the event ref also keeps provenance attached to the
actual release source commit.

Type checking, ordinary/script tests, integration tests, build, self-contained package
checks and a dry-run publication must pass before the final publish step. Only
`packages/tabby-plugin` is published. The package currently remains version `0.1.0`.
Future version changes must also update the existing package-check version constant
and its version-specific fixtures; they are not automated by this work.

## Account setup deferred until the first authorized release

At preparation time, the public npm registry returns 404 for `tabby-secure-mcp`.
An existing package is needed to configure its Trusted Publisher settings. Therefore
the workflow alone does not solve the initial package-creation/bootstrap step.
The npm owner must arrange that first authenticated publication separately, with
explicit release authorization; no bootstrap token or first publish is created here.
Before using the prepared OIDC workflow, configure these exact values on npm:

| Trusted Publisher field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `woodynew` |
| Repository | `tabby-secure-mcp` |
| Workflow filename | `publish.yml` (filename only) |
| Environment name | Leave empty; this workflow has no deployment environment |
| Allowed actions | Enable direct `npm publish`; staging permission alone is insufficient |

Check npm's [current trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/)
when performing this setup. It requires npm `11.5.1+` and Node `22.14.0+`; this
workflow checks npm's version. New trusted-publisher configurations must complete
their first successful publish within two days or be recreated. Configure the
connection close to the actual release, rather than during preparation.

Review account 2FA and token restrictions at that time. Do not add `NPM_TOKEN` or
`NODE_AUTH_TOKEN` secrets as a substitute for a working trusted-publisher connection.
Authentication failure must stop the release; do not fall back to token publishing.

## Verification without publishing

From the repository root:

```sh
npm ci --registry=https://registry.npmjs.org --no-audit
npm run typecheck
npm test
npm run test:integration
npm run build
npm run pack:check
npm publish --workspace=packages/tabby-plugin --dry-run --access=public --registry=https://registry.npmjs.org
```

These checks do not publish, authenticate an OIDC publisher or generate provenance.
Review [known dependency findings](security-baseline.md) and current scan results
before authorizing an actual release. No dependency upgrades or vulnerability
dispositions are implied by passing the build/tests.

## Actual publication: a later, explicitly authorized operation

After this workflow is merged into `main`, the npm bootstrap/setup is resolved and
the release candidate is approved, create its version tag on an included `main`
commit. Dispatch using that tag, for example:

```sh
gh workflow run publish.yml --repo woodynew/tabby-secure-mcp --ref vX.Y.Z -f tag=vX.Y.Z
```

Replace `vX.Y.Z` with the real package version. The command above **publishes** when
all checks pass; it is not a dry run. A version already published to npm cannot be
republished, including the version used for bootstrap. Do not rerun an uncertain
publish blindly; inspect the registry and workflow outcome first.

For an actual published version, inspect npm's provenance details and compare its
source commit and build workflow to the release. Consumers can verify installed
packages with `npm audit signatures`. An OIDC/dry-run test is not provenance evidence.
See [npm provenance documentation](https://docs.npmjs.com/generating-provenance-statements/).
Provenance establishes origin, not the absence of vulnerabilities or malicious code.
