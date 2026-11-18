# Security policy

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/woodynew/tabby-secure-mcp/security/advisories/new)
to report suspected security issues. Do not put exploit details, bearer tokens, SSH
credentials, private keys, host configuration or sensitive command output in a public issue.

Include the plugin version or source commit, Tabby and OS versions, reproduction
steps, expected and observed behavior, and the affected permission boundary. Use a
low-privilege test host and redact private information. The maintainer will assess
the report and coordinate remediation and disclosure; no fixed response time is promised.

Public issues are appropriate for ordinary bugs and questions that contain no
security-sensitive information.

## Supported versions

There is currently no formal published release covered by this policy. After the
first formal release, security maintenance covers only the latest formal release.
Development branches and older versions are not supported release lines. Update to
the latest formal release when one is available.

## Security boundaries

The plugin exposes authorized SSH operations through a native-client MCP endpoint
inside Tabby. See the [documented boundaries and limitations](https://github.com/woodynew/tabby-secure-mcp#security-scope-and-limitations),
including the Tabby/OS-user trust domain, credential handling, command approval,
file-transfer permissions and uncertain execution outcomes.

CodeQL and dependency checks provide ongoing evidence, not a certification of
safety. [Known dependency findings and the scan baseline](docs/security-baseline.md)
are public. No independent third-party security audit is claimed. npm provenance,
when available for a published version, establishes its source/build origin; it
does not establish that its source is free of vulnerabilities.
