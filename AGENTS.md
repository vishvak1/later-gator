# Repository Guidelines

## Project structure

`src/index.ts` owns the Worker entry points. Keep product orchestration in `src/application`, pure rules and schemas in `src/domain`, external APIs and storage in `src/adapters`, HTTP handlers in `src/routes`, and redacted telemetry in `src/observability`. Tests mirror those boundaries under `test/unit`, `test/contract`, and `test/integration`. The approved product and technical specifications live in `docs/` and are authoritative.

## Commands

- `npm run types`: regenerate `worker-configuration.d.ts` from `wrangler.jsonc`.
- `npm run typecheck`: run strict TypeScript checks.
- `npm test`: run tests inside the Cloudflare Workers runtime.
- `npm run lint`: enforce typed ESLint rules, including no floating promises.
- `npm run check`: run generated-type, type, lint, and test gates.
- `npm run build`: validate a Wrangler production bundle without deploying.

## Conventions

Use strict TypeScript and explicit module boundaries. Validate all external inputs and KV documents with Zod. Use generated `Env` types—do not hand-write binding interfaces or use `any`. Await, return, or explicitly schedule every promise. Keep request state local to handlers. Use `URL`/`URLSearchParams`; never concatenate untrusted URL values.

## Safety and tests

Raindrop is the source of truth. Never persist bookmark content in KV or logs. Never log full URLs, titles, notes, excerpts, tokens, or MCP paths. Credentials entered in setup must be encrypted before KV storage and never returned to the browser. Onboarding and mutation paths require authenticated setup sessions, CSRF protection, explicit user action, idempotency, and fault-injection coverage. Add a regression test with every behavior change. Production-library testing is prohibited until the design's deployment gates pass.
