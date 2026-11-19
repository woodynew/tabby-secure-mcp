#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'HELP'
Usage:
  bash scripts/release.sh            Check, build, and dry-run the plugin package.
  bash scripts/release.sh --publish  Publish the first version to npm.

The first publish requires a clean main equal to the official remote main,
an authenticated npm account, and a package name still unregistered on npm.
Before running --publish, sign in to the official npm registry and verify your account.
  npm login --registry=https://registry.npmjs.org
  npm whoami --registry=https://registry.npmjs.org

Subsequent versions use the GitHub Actions Trusted Publisher workflow.
See docs/publishing.md for the setup and security review.
HELP
}

fail() {
  printf 'Release failed: %s\n' "$*" >&2
  exit 1
}

[[ $# -le 1 ]] || { usage >&2; exit 2; }
case "${1:-}" in
  ''|--check) mode=check ;;
  --publish) mode=publish ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

cd "$(dirname "${BASH_SOURCE[0]}")/.."
registry=https://registry.npmjs.org
workspace=packages/tabby-plugin
package_name=tabby-secure-mcp

version="$(node <<'NODE'
const fs = require('node:fs')
const pkg = require('./packages/tabby-plugin/package.json')
const locked = require('./package-lock.json').packages?.['packages/tabby-plugin']
const server = fs.readFileSync('packages/companion/src/mcp/server.ts', 'utf8')
if (pkg.name !== 'tabby-secure-mcp' || pkg.private === true ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg.version) ||
    pkg.version !== locked?.version || !server.includes("version: '" + pkg.version + "'")) {
  throw new Error('The public plugin manifest, lockfile and MCP server must agree on a stable release version.')
}
process.stdout.write(pkg.version)
NODE
)"
package_id="$package_name@$version"

if [[ "$mode" == publish ]]; then
  release_head="$(git rev-parse --verify HEAD)"
fi

verify_main() {
  [[ "$(git branch --show-current)" == main ]] || fail 'Run --publish from main.'
  [[ -z "$(git status --porcelain --untracked-files=normal)" ]] || fail 'The working tree must be clean.'
  local remote_main
  remote_main="$(git ls-remote --exit-code https://github.com/woodynew/tabby-secure-mcp.git refs/heads/main)" ||
    fail 'Could not verify the official remote main.'
  [[ "$(git rev-parse HEAD)" == "$release_head" && "${remote_main%%$'\t'*}" == "$release_head" ]] ||
    fail 'The checked-out commit must equal the official remote main.'
}

tmp="$(mktemp -d "${TMPDIR:-/tmp}/tabby-release.XXXXXX")"
trap 'rm -rf -- "$tmp"' EXIT

registry_status() {
  local status
  status="$(curl -sS --max-time 15 -o "$tmp/registry.json" -w '%{http_code}' "$registry/$package_name")" ||
    fail 'Could not contact the official npm registry.'
  case "$status" in
    404) printf 'missing\n' ;;
    200)
      node - "$tmp/registry.json" "$package_name" "$version" "${integrity:-}" <<'NODE'
const fs = require('node:fs')
const [file, name, version, integrity] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
if (pkg.name !== name || !pkg.versions) throw new Error('Unexpected npm registry metadata.')
const published = pkg.versions[version]
console.log(!published ? 'other-version' : published.dist?.integrity !== integrity ? 'different'
  : pkg['dist-tags']?.latest === version ? 'match-latest' : 'match')
NODE
      ;;
    *) fail "Unexpected npm registry status: $status." ;;
  esac
}

printf 'Release mode: %s\nPackage: %s\n' "$mode" "$package_id"
if [[ "$mode" == publish ]]; then
  verify_main
  printf 'Release source: %s\n' "$release_head"
  state="$(registry_status)"
  [[ "$state" == missing ]] || fail "$package_name is already registered. Use the Trusted Publisher workflow."
  npm whoami --registry="$registry" >/dev/null || fail "Sign in to the official npm registry before first publication.
  npm login --registry=$registry
  npm whoami --registry=$registry
After npm whoami prints your username, rerun bash scripts/release.sh --publish."
fi

git diff --check
git diff --cached --check
npm ci --no-audit --registry="$registry"
npm run typecheck
npm run test:templates --workspace="$workspace"
npm test
npm run test:integration
npm run build

# npm audit exits 1 for findings. Distinguish those from an incomplete scan.
audit_exit=0
npm audit --package-lock-only --json --registry="$registry" > "$tmp/audit.json" || audit_exit=$?
[[ "$audit_exit" -le 1 ]] || fail "npm audit exited with status $audit_exit."
node - "$tmp/audit.json" <<'NODE'
const fs = require('node:fs')
const audit = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (audit.error || !audit.metadata?.vulnerabilities) throw new Error('npm audit did not complete.')
const { critical, high, moderate, low } = audit.metadata.vulnerabilities
console.log(`npm audit (lockfile): ${critical} critical, ${high} high, ${moderate} moderate, ${low} low`)
NODE

npm pack --workspace="$workspace" --ignore-scripts --pack-destination="$tmp" --registry="$registry" >/dev/null
node --input-type=module - "$tmp" <<'NODE'
import { inspectPackedTarball } from './scripts/pack-check-core.mjs'
await inspectPackedTarball({ packDir: process.argv[2], runPack: false })
console.log('Pack check passed.')
NODE

archive="$tmp/$package_name-$version.tgz"
integrity="$(node -e 'const { createHash } = require("node:crypto"); const fs = require("node:fs"); console.log("sha512-" + createHash("sha512").update(fs.readFileSync(process.argv[1])).digest("base64"))' "$archive")"
npm publish "$archive" --dry-run --ignore-scripts --access=public --tag=latest --registry="$registry"

if [[ "$mode" == check ]]; then
  existing="$(registry_status)"
  [[ "$existing" != different ]] || fail "$package_id already exists with different contents. Bump the version."
  printf 'Release checks passed for %s. Registry: %s.\n' "$package_id" "$existing"
  exit 0
fi

verify_main
state="$(registry_status)"
[[ "$state" == missing ]] || fail "$package_name became registered during the checks. Inspect npm before continuing."
npm publish "$archive" --ignore-scripts --access=public --tag=latest --registry="$registry"
for attempt in 1 2 3 4 5 6; do
  state="$(registry_status)"
  case "$state" in
    match-latest) printf 'Published and verified: %s\nIntegrity: %s\n' "$package_id" "$integrity"; exit 0 ;;
    different) fail 'The registry integrity does not match the checked tarball. Inspect npm before retrying.' ;;
  esac
  [[ "$attempt" == 6 ]] || sleep 5
done
fail "Could not verify $package_id and the latest tag. Inspect npm before retrying."
