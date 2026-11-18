# tabby-secure-mcp

A Tabby plugin hosting a local MCP service for explicitly authorized SSH access.
AI clients can open SSH tabs, execute approved commands and, when separately enabled,
transfer files. Each client has its own credential and permissions.

- [Setup and usage](https://github.com/woodynew/tabby-secure-mcp#quick-start)
- [Security policy and private vulnerability reporting](https://github.com/woodynew/tabby-secure-mcp/security/policy)
- [Security boundaries](https://github.com/woodynew/tabby-secure-mcp#security-scope-and-limitations)
- [Security checks and known dependency findings](https://github.com/woodynew/tabby-secure-mcp/blob/main/docs/security-baseline.md)

The service is restricted to IPv4 loopback. Its permissions operate within the
Tabby/OS-user trust domain; command approval is not a remote operating system sandbox.
Automated checks and package provenance are not an independent security audit or a
guarantee that the software has no vulnerabilities.
