# Contributing to tabby-secure-mcp

Use [GitHub Issues](https://github.com/woodynew/tabby-secure-mcp/issues) for
questions, feature proposals, and ordinary bugs. For bug reports, include the
plugin version or commit, Tabby and OS versions, and the expected and observed
behavior. Use the [security policy](SECURITY.md) for suspected vulnerabilities.

1. Fork the repository and create a branch from `main`. For substantial changes,
   open an issue first to discuss the intended behavior.
2. Open a pull request against `main`. Explain the change, how you verified it,
   and any impact on Tabby compatibility or on existing permissions.
3. Follow the conventions in the code you are changing. Add automated tests
   for major new functionality and regression tests for behavior you fix.

Install dependencies and run the project checks from the repository root with
Node.js 20.19.0 or newer:

```sh
npm ci
npm run typecheck
npm test
npm run test:integration
npm run build
npm run pack:check
```

Use an isolated Tabby configuration and a low-privilege test host if your change
needs a real SSH session. Use test credentials and redact real host details from
reports and fixtures.
