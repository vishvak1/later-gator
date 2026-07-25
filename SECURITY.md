# Security status

## Dependency audit

As of 2026-07-25, the production audit reports no high or critical findings. It reports moderate advisories in transitive Node-only dependencies of the official MCP/Agents packages, including a Windows static-file adapter that is not invoked by this Worker. The bundled production artifact and advisory status must still be rechecked before release.

The full development audit can additionally report findings through the local Cloudflare test toolchain. Do not process untrusted files with that toolchain. This note records the current assessment; it is not blanket acceptance of future advisories.

Production deployment remains subject to the Technical Design v1.4 gate requiring no unaccepted high-severity findings.
