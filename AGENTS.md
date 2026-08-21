# Repository Guidelines

## Project structure

`apps/runtime/src/index.ts` owns the personal Worker entry points. Keep runtime
product orchestration in `apps/runtime/src/application`, pure rules and schemas
in `apps/runtime/src/domain`, external APIs and storage in
`apps/runtime/src/adapters`, HTTP handlers in `apps/runtime/src/routes`, and
redacted telemetry in `apps/runtime/src/observability`. Runtime tests live under
`apps/runtime/test`; control-plane and shared-contract code keep their own
package-local tests. Canonical Chrome-extension source and extension-specific
DOM tests live in `apps/chrome-extension`; `extension/chrome` is a generated
install folder. The approved product and
technical specifications live in `docs/` and are authoritative.

## Managed-BYOC execution

For managed-BYOC work, read
`planning/managed-byoc/execution-tracker.md` completely before changing code.
That tracker is the source of truth for implementation progress, the active
stage, validation evidence, and the next-session queue. The proposed product
requirements, structural plan, and implementation plan in the same directory
define the target and sequencing; the specifications in `docs/` remain the
compatibility baseline for current behavior until the transition is accepted.

Update the execution tracker at the start and end of every managed-BYOC coding
session. Do not mark work complete without recording the validation command and
result. Preserve unrelated or pre-existing working-tree changes, and never
discard, stash, commit, or deploy them unless the user explicitly requests it.

## Commands

- `npm run types`: regenerate `apps/runtime/worker-configuration.d.ts` from the
  runtime Wrangler configuration.
- `npm run typecheck`: run strict TypeScript checks.
- `npm test`: run tests inside the Cloudflare Workers runtime.
- `npm run lint`: enforce typed ESLint rules, including no floating promises.
- `npm run check`: run generated-type, type, lint, and test gates.
- `npm run build`: validate a Wrangler production bundle without deploying.

## Conventions

Use strict TypeScript and explicit module boundaries. Validate all external inputs and KV documents with Zod. Use generated `Env` types—do not hand-write binding interfaces or use `any`. Await, return, or explicitly schedule every promise. Keep request state local to handlers. Use `URL`/`URLSearchParams`; never concatenate untrusted URL values.

## Safety and tests

Raindrop is the source of truth. Never persist bookmark content in KV or logs. Never log full URLs, titles, notes, excerpts, tokens, or MCP paths. Credentials entered in setup must be encrypted before KV storage and never returned to the browser. Onboarding and mutation paths require authenticated setup sessions, CSRF protection, explicit user action, idempotency, and fault-injection coverage. Add a regression test with every behavior change. Production-library testing is prohibited until the design's deployment gates pass.
