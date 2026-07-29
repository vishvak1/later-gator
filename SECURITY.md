# Security status

Later Gator v6 treats D1 as the authoritative bookmark library and Workers KV as private
thumbnail storage. Dashboard mutations require an authenticated HTTP-only
session, same-origin validation, and CSRF. Browser, iOS, and MCP connections use
separate revocable credentials with the minimum required scopes.

Password-wrapped keys use PBKDF2-SHA256 with the hosted Workers maximum of
100,000 iterations. Deployments accept the existing 10-character compatibility
minimum, but users should choose 16 or more characters. Login attempts are
rate-limited, and an unsupported stored KDF configuration fails closed with a
controlled response.

Provider keys are encrypted before D1 storage and never returned to the browser.
Logs and Queue messages must not contain bookmark URLs, titles, notes, content,
provider keys, capture tokens, session values, or MCP paths.

## Dependency audit

As of 2026-07-28, `npm audit --omit=dev --audit-level=high` reports no high or
critical findings. It reports three instances of one moderate advisory in the
transitive Node-only Hono static-file adapter used by the official MCP/Agents
packages. Later Gator runs the Web-standard Worker transport and does not invoke
that Windows static-file adapter. The only automated audit remediation offered
is a breaking downgrade, so the dependency is documented and must be rechecked
before release.

The full development audit can additionally report findings through the local Cloudflare test toolchain. Do not process untrusted files with that toolchain. This note records the current assessment; it is not blanket acceptance of future advisories.

Production deployment remains subject to the Technical Design v2 release gates,
including no unaccepted high-severity production finding.
