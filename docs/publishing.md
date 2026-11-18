# npm release preparation

The first planned public release is **`tabby-secure-mcp@0.1.0`**, with Git tag
**`v0.1.0`**. Use the [v0.1.0 release notes](releases/v0.1.0.md) when publishing
the matching GitHub Release. The root workspace and the two internal libraries are
private.

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
An existing package is needed to configure its Trusted Publisher settings.
The [release script](../scripts/release.sh) handles that first authenticated
publication. From a clean `main` that matches the official remote, run
`npm login --registry=https://registry.npmjs.org` if needed. After reviewing
the first release candidate, run `bash scripts/release.sh --publish`. It verifies
that the package name is still unregistered, publishes the checked tarball, and
checks the registry version, `latest` tag, and tarball integrity. This initial
publication uses the local npm account. The Trusted Publisher workflow supplies
provenance for later versions.

### First publication checklist

1. Confirm that `main` contains the reviewed candidate, CI is green, and the
   checked-in [release notes](releases/v0.1.0.md) describe that candidate. Review
   the current [security findings](security-baseline.md) and host acceptance.
2. Verify the account with `npm whoami --registry=https://registry.npmjs.org`.
   Sign in with the intended npm publisher account and complete its 2FA if prompted.
3. Run `bash scripts/release.sh` on a clean `main`, then run
   `bash scripts/release.sh --publish` when the first public release is authorized.
   Record the exact source commit and the registry integrity that the script prints.
4. Create `v0.1.0` on that source commit and publish the matching GitHub Release
   with the release notes above. Verify that npm lists `0.1.0` as `latest` and
   that Tabby discovers or can install the package.

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
bash scripts/release.sh
```

Check mode runs a clean install, type checking, template compilation, tests,
integration tests, build, and a lockfile-wide npm audit. It validates the one
plugin tarball and runs an npm publish dry run on that exact file. Check mode
runs without npm login. A failed audit request stops the script. Audit findings
are reported separately so the maintainer can evaluate
[known dependency findings](security-baseline.md) before authorizing publication.

## Subsequent publication through GitHub Actions

After the npm bootstrap and Trusted Publisher setup are complete and
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
