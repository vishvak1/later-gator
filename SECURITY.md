# Security status

Later Gator 1.0.0 treats D1 as the authoritative bookmark library and Workers KV as private
thumbnail storage. Dashboard mutations require an authenticated HTTP-only
session, same-origin validation, and CSRF. Browser, iOS, and MCP connections use
separate revocable credentials with the minimum required scopes.

The owner signs in directly with a Worker-secret password of at least 16
characters. Login requires a same-origin POST and applies a per-client hashed-IP
throttle after five failures within fifteen minutes. Session and CSRF credentials
are random; only their hashes are stored in D1. Password comparison uses
constant-time comparison of fixed-length SHA-256 digests.

Provider keys are encrypted under `INSTANCE_MASTER_KEY` before D1 storage.
Password rotation does not re-encrypt provider credentials. Preserve the master
key during upgrades; revoke existing sessions when rotating a compromised password.
There is no external installer authorization or identity assertion exchange.
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

Production deployment remains subject to the consolidated Technical Design
release gates, including no unaccepted high-severity production finding, disposable-instance
checks for storage, password sign-in, capture and MCP, and verified backup and
rollback procedures before touching the production library.
