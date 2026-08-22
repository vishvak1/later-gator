# Security status

Later Gator 1.0.0 treats D1 as the authoritative bookmark library and Workers KV as private
thumbnail storage. Dashboard mutations require an authenticated HTTP-only
session, same-origin validation, and CSRF. Browser, iOS, and MCP connections use
separate revocable credentials with the minimum required scopes.

Cloudflare identity is the only owner-login path. The control plane issues a
short-lived, installation-bound ES256 assertion; the personal runtime verifies
issuer, audience, owner subject, nonce, expiry, and one-time JTI before creating
its own local session. There is no Later Gator password or recovery fallback.

Provider keys are encrypted under the per-installation `INSTANCE_MASTER_KEY`
before personal D1 storage and never enter the control plane. Renewable
Cloudflare installer tokens are independently encrypted in control-plane D1.
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
release gates, including no unaccepted high-severity production finding, clean
KV/R2 install tests, supported update/rollback, external authorization-loss
recovery, and control-plane outage drills.
