# Repository Guidelines

## Project structure

`apps/runtime/src/index.ts` owns the personal Worker entry points. Keep runtime
product orchestration in `apps/runtime/src/application`, pure rules and schemas
in `apps/runtime/src/domain`, external APIs and storage in
`apps/runtime/src/adapters`, HTTP handlers in `apps/runtime/src/routes`, and
redacted telemetry in `apps/runtime/src/observability`. Runtime tests live under
`apps/runtime/test`. Canonical Chrome-extension source and extension-specific
DOM tests live in `apps/chrome-extension`; `extension/chrome` is a generated
install folder. The approved product and
technical specifications live in `docs/` and are authoritative. Historical
plans live only in Git history.

## Single-owner architecture

One personal runtime owns authentication, bookmarks, thumbnails, provider
configuration, capture, MCP, and logs inside the owner's Cloudflare account.
There is no publishing service, control plane, shared-contract package, or
managed provisioning/update service. Deploy the runtime directly with Wrangler.
Keep provider credentials encrypted under the existing instance master key.

Preserve unrelated or pre-existing working-tree changes, and never discard,
stash, commit, or deploy them unless the user explicitly requests it.

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

D1 in the personal runtime is the bookmark source of truth; Raindrop is CSV
import-only. Never persist bookmark content in KV or logs. Never log full URLs,
titles, notes, excerpts, tokens, or MCP paths. Provider credentials must be
encrypted before personal D1 storage and never leave the personal runtime.
Mutation paths require authenticated runtime sessions, CSRF protection,
explicit user action, idempotency, and fault-injection coverage. Add a regression
test with every behavior change. Production-library testing is prohibited until
the documented release gates pass.
