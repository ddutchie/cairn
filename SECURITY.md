# Security Policy

## Supported versions

Security fixes are applied to the **latest release** only. We recommend always running the most recent version.

| Version | Supported |
|---------|-----------|
| Latest  | ✅        |
| Older   | ❌        |

## Reporting a vulnerability

**Please do not report security vulnerabilities via public GitHub issues.**

Instead, report them privately via [GitHub Security Advisories](https://github.com/ddutchie/cairn/security/advisories/new). This keeps the details confidential until a fix is ready.

Include:

- A clear description of the vulnerability and its impact
- Steps to reproduce (a minimal proof of concept if possible)
- The version of Cairn you're running

You should receive an acknowledgement within **72 hours**. We aim to publish a fix within **14 days** for critical issues.

## Scope

Cairn is a **local-first desktop app** — it never transmits your notes or project data to any server. Potential security concerns include:

- **XSS in the dashboard iframe** — dashboards render in a sandboxed `<iframe srcdoc>` with no `allow-same-origin` and no network access
- **Path traversal in the Agent workspace** — all file IPC calls validate paths against registered `code_directory` values via `assertWithinCodeDirectory`
- **MCP server access control** — the MCP server connects directly to your local SQLite database; it should only be exposed to agents you trust

Out of scope: issues requiring physical access to the machine, or issues in third-party dependencies that have no direct impact on Cairn users.

## Disclosure policy

We follow [coordinated disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure). Once a fix is released we'll publish a security advisory crediting the reporter (unless you prefer to remain anonymous).
