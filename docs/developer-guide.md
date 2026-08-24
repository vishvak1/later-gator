# Later Gator — Developer Guide

**Product version:** 1.0.0
**Status:** current implementation guide

## 1. Start here

Later Gator is a strict TypeScript monorepo containing a management control
plane, a personal data-plane runtime, a Chrome extension, and strict shared
contracts. Personal D1 owns the bookmark library and application state; KV/R2
contains only thumbnail bytes; Queues carry small validated job messages;
Vectorize contains derived embeddings.

Read these files before changing behavior:

1. `docs/product-requirements.md` — user-visible contract.
2. `docs/technical-design.md` — architecture and invariants.
3. `docs/developer-guide.md` — implementation workflow.

Those are the only authoritative documents in `docs/`.

## 2. Install and validate

Use a supported Node release from `package.json`, then:

```bash
npm install
npm run db:init:local
npm run check
npm run check:managed-byoc
npm run build
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Build assets and start local Wrangler development |
| `npm run build:extensions` | Generate the Chrome install folder |
| `npm run build:web` | Generate content-hashed dashboard assets |
| `npm run types` | Regenerate `apps/runtime/worker-configuration.d.ts` |
| `npm run typecheck` | Strict Worker TypeScript check |
| `npm run typecheck:web` | Strict dashboard TypeScript check |
| `npm run check:function-docs` | Require JSDoc on named production functions |
| `npm run lint` | Typed ESLint, including floating Promise checks |
| `npm test` | Worker-runtime tests |
| `npm run test:web` | Browser DOM tests |
| `npm run check` | All local gates |
| `npm run check:managed-byoc` | Shared-contract and control-plane gates plus dry-run bundle |
| `npm run build:release` | Build the runtime and immutable release artifact |
| `npm run build` | Wrangler production dry run |
| `npm run db:init:remote` | Initialize an empty/current remote D1 database |
| `npm run deploy` | Initialize schema, then deploy |

Do not deploy while investigating or testing unless the owner explicitly asks.
Workers AI and remote Vectorize bindings may incur usage even from local tests;
use the existing mocks and fixtures whenever the behavior does not require a
live provider.

## 3. Module rules

- `apps/runtime/src/domain`: pure normalization, schemas, fixed data, and presentation
  constants. No network or database calls.
- `apps/runtime/src/application`: use-case orchestration across repositories and providers.
- `apps/runtime/src/adapters`: D1 queries, provider calls, remote fetches, rendering, and live
  event integration.
- `apps/runtime/src/routes`: HTTP transport, status codes, and server-rendered page output.
- `apps/runtime/src/security`: cryptography, sessions, and scoped credentials.
- `apps/runtime/src/worker.ts`: routing only; extract substantial behavior into the proper
  boundary.
- `apps/runtime/web/src`: dashboard behavior. Reuse domain constants when safe for browser
  bundling.
- `apps/chrome-extension`: canonical browser-extension source, Chrome manifest,
  icons, and extension-specific DOM tests. Never edit generated browser packages
  as a source of truth.
- `apps/control-plane/src`: identity, installer, release, pairing, and
  content-free management modules. It must not import runtime repositories or
  accept private application payloads.
- `packages/contracts`: strict, bounded payloads shared across trust boundaries.
- `releases` and `apps/control-plane/release-artifacts`: immutable release
  descriptors and generated artifacts; never edit published bytes in place.

Keep request state local. Never place a request, session, URL, bookmark, or
credential in module-level mutable state. Use generated `Env` types. Do not
hand-write binding interfaces or use `any` to bypass binding checks.

## 4. Function documentation

Every named production function—including named nested helpers and Worker
methods—has a JSDoc comment that states its responsibility. Anonymous one-use
callbacks do not require comments when their enclosing call is self-explanatory.

The documentation gate scans:

- `apps/runtime/src`;
- `apps/runtime/web/src`;
- `apps/chrome-extension/src`; and
- `scripts`.

When adding a function, describe the observable job it performs, not merely its
name or implementation syntax. Keep comments synchronized when responsibility
changes. Use inline comments for non-obvious invariants, races, privacy rules,
and provider quirks; avoid narrating routine statements.

## 5. D1 workflow

`apps/runtime/schema.sql` is the single current source schema. There is no
numbered application source tree. Initialize local D1 with `npm run db:init:local`.

For a schema change:

1. Update `apps/runtime/schema.sql` directly.
2. Update every affected query and row type.
3. Update tests that initialize or assert the schema.
4. Add behavior and failure-path coverage.
5. Run `npm run check` and `npm run build`.
6. Add an ordered, checksum-stable managed release migration when an existing
   installation must move to the new schema.
7. Update all three documents if the data or behavior contract changed.

Use parameterized D1 statements. Prefer a D1 batch when several statements must
be applied as one logical write. Rely on constraints for uniqueness and valid
states, then convert expected constraint failures into safe product outcomes.

`apps/runtime/schema.sql` is repeatable for a fresh or already-current database. Do not add
request-time schema alteration, old-state repair, or hidden data transformation.
Destructive or contract-phase changes are never automatic: stop, obtain an
explicit backup/release decision, define maintenance and rollback behavior, and
test from a supported prior release.

## 6. Bookmark write lifecycle

### Create

1. Validate the request with a Zod schema.
2. Normalize and safety-check the URL.
3. Check active normalized-URL uniqueness.
4. Insert the bookmark in Unsorted unless an explicit manual folder disables AI.
5. Normalize tags once and maintain usage counts.
6. Create organization and thumbnail jobs as applicable.
7. Attempt Queue dispatch; leave `pending_dispatch` on failure.
8. Notify open dashboard tabs after the visible write.

### Edit

Clients send `expectedRevision`. The D1 update matches both bookmark ID and
revision, increments the revision, and updates the job expectation where the job
remains eligible. If the row count is zero, return a conflict and reload rather
than overwriting another write.

Moving a bookmark out of Unsorted cancels active organization work. Moving it
into Unsorted creates or refreshes eligible work. Editing one bookmark does not
pause automation for any other bookmark.

### Delete and restore

Soft deletion sets `deleted_at`, cancels active work, and attempts vector cleanup.
Restore clears deletion state and recreates eligible work. Permanent deletion
requires the explicit destructive UI flow. D1 cascades relationships and
bookmark tags; thumbnail KV deletion remains best effort and recoverable.

## 7. Queue development

Queue messages are strict and contain only a type plus an opaque
job ID when required. Never include bookmark URLs, titles, page content,
credentials, or provider responses.

Assume at-least-once delivery:

- claim work from D1 with state conditions;
- treat completed/cancelled/missing work as an acknowledgement;
- compare `expected_revision` before applying output;
- leave recoverable work represented in D1;
- retry transport and temporary provider failures;
- never cancel stale work without refreshing or replacing it.

The background Queue is sequential. Do not increase its concurrency without a
provider-pressure and ordering review. Thumbnail work is deliberately separate
so image latency cannot block organization.

Every Promise must be awaited, returned, passed to an execution context, or
handled with an intentional catch. A bare Queue send or fetch is a bug.

## 8. Organization provider development

Provider adapters return one common organization shape or throw
`OrganizationProviderError` with a safe category, safe code, and optional retry
time. They must:

- bound request and response sizes;
- avoid logging bodies or secrets;
- distinguish authentication/configuration errors from temporary allocation,
  throttling, timeout, and transport failures;
- preserve provider-specific required headers;
- validate every response with Zod; and
- route Workers AI through the configured Gateway ID only when present.

Structured output does not replace application validation. Refusals, truncation,
model changes, and malformed envelopes remain possible.

Prompt changes must preserve:

- Unsorted-only eligibility;
- deterministic Social Posts routing for X/Twitter status URLs;
- preserve-mode descriptions and imported tags;
- current active/retired vocabulary guidance;
- avoidance of synonym and abbreviation duplicates; and
- personal instructions as preferences, never permission to violate security or
  output schema.

## 9. Safe page retrieval

All remote URL work goes through the safe-remote adapter. Never concatenate a
URL string or call unrestricted `fetch` from a new feature.

Required controls:

- only HTTP and HTTPS;
- no URL credentials;
- block loopback, private, link-local, and unsafe IPv6 ranges;
- validate every redirect;
- omit cookies and authorization;
- bound redirects, bytes, and response time;
- cancel streams after the limit; and
- parse only the content needed for the feature.

Browser Rendering is a last fallback, not a default fetch path. Respect the
per-job attempt field and daily blocked-until latch.

## 10. Thumbnail development

Candidate discovery and byte ingestion are separate responsibilities. Preserve
the ordered candidate strategy and placeholder rejection. Before KV storage:

1. fetch through safe-remote;
2. enforce byte and content constraints;
3. validate a supported raster signature;
4. transform to bounded WebP through Images; and
5. store metadata in D1 only after KV succeeds.

The authenticated delivery route must match the bookmark's current thumbnail
ID. It must never become a public KV proxy.

## 11. Import development

CSV parsing is bounded to 10 MiB and 5,000 rows. Keep parsing deterministic for
quoted fields and embedded line breaks. Validate headers before writing.

Imports write valid bookmarks directly in chunks and update one import session;
do not add a second staging table or migration workflow. Preserve and reorganize
are distinct contracts:

- preserve keeps normalized tags and the imported excerpt as description;
- reorganize discards them for AI generation;
- both begin in Unsorted; and
- AI chooses only the folder for preserve-mode bookmarks.

Duplicate and invalid rows are counted, not silently discarded. The dashboard
polls status until the direct commit promise completes.

## 12. Search development

FTS is the reliable baseline. Add filter clauses through parameterized SQL and
keep cursor encoding/decoding deterministic with the selected sort and direction.

Semantic search is derived and optional. Join Vectorize IDs back to D1 and apply
the same deletion, folder, tag, date, favorite, and pagination conditions.
Never treat a vector as authoritative bookmark data. Incrementing a bookmark
revision must make `embedded_revision != revision` so backlog processing can
refresh it.

## 13. Dashboard development

Server-rendered pages live in `apps/runtime/src/routes/pages.ts`; interactive behavior lives
in `apps/runtime/web/src/main.ts`; styles live in `apps/runtime/web/src/app.css`. Shared folder icons,
how-to panels, and provider-status text come from domain modules so server and
browser do not drift.

For every UI change verify:

- setup topic controls remain clickable and selected state is visible;
- text does not overlap at supported widths;
- padding and gaps remain consistent;
- light and dark themes have sufficient contrast;
- dialogs trap the intended action and restore sensible focus;
- status text uses `role=status` or an alert only when appropriate;
- selection checkboxes and destructive confirmation remain present; and
- keyboard and pointer behavior agree.

Live notifications are hints. Refresh on notification, visibility, and focus,
and compare the library fingerprint before repainting. Do not introduce a
constant polling loop.

## 14. Extension development

Edit Chrome-extension behavior only in:

- `apps/chrome-extension/src/background.js`;
- `apps/chrome-extension/src/common.js`;
- `apps/chrome-extension/src/popup.js`;
- `apps/chrome-extension/src/popup.html`;
- `apps/chrome-extension/src/popup.css`;
- `apps/chrome-extension/assets/icons`; or
- `apps/chrome-extension/manifest.json`.

Run `npm run build:extensions` afterward. The generated `extension/chrome`
directory is ignored and may be safely regenerated.

Keep WebExtension code compatible with both browser APIs through the existing
`browser ?? chrome` adapter. New permissions require a privacy and UX review.
Pairing codes contain the origin and token but must never appear in links, query
strings, logs, or analytics. Validate the deployment origin before requesting a
host permission.

The X-link popover is also the authoritative selection state. Do not re-read
and union new page links during submission: that would save a link the owner did
not choose. Duplicate confirmation must remain non-mutating until the explicit
Save post and connect action; Go back preserves checkbox state and Cancel writes
nothing.

## 15. Control-plane and release development

Cloudflare Access protects the control plane's `/auth/access` path and uses
Cloudflare as its identity provider with **Restrict to account members** off.
The Worker validates `Cf-Access-Jwt-Assertion` against the team issuer,
application audience, and rotating JWKS, then creates its own opaque session.
The confidential Cloudflare OAuth client is installer-only. Installer requests
include `user-details.read` to bind consent to the Access email, then add
`offline_access`, `d1.write`,
`workers-kv-storage.write`, `vectorize.write`, and `workers-scripts.write`; R2
install/migration additionally requests `workers-r2.write`.

The registered development OAuth callback is the control-plane development
origin plus `/install/cloudflare/callback`; production uses the corresponding
path on `https://latergator.app`. Chrome opens the same Access-protected login
handoff and returns to the exact
`https://<extension-id>.chromiumapp.org/cloudflare` callback.

Release workflow:

1. change the one current runtime source and `apps/runtime/schema.sql`;
2. add regression/fault tests and any compatible upgrade statements;
3. run `npm run check`, `npm run build`, and `npm run check:managed-byoc`;
4. create a new immutable release with `npm run build:release`;
5. verify descriptors, digests, schema ranges, bindings, and health contract;
6. deploy the control plane without changing `ACTIVE_RUNTIME_RELEASE`;
7. select the new release and expand cohorts only after live canary health;
8. never replace an already-published release directory.

Control-plane commits deploy the management Worker only. Personal runtimes
change only when a newer active runtime release is selected and the scheduler
finds an authorized installation in the active cohort.

## 16. Security checklist

- Validate every external input and stored JSON boundary with Zod or an equally
  strict parser.
- Use `URL` and `URLSearchParams`; never concatenate untrusted URL components.
- Use Web Crypto random values and constant-time comparisons for secrets.
- Never log URL, title, note, description, excerpt, page body, token, credential,
  ciphertext, OAuth code, grant, or MCP request content.
- Require session, origin, and CSRF checks for dashboard mutations.
- Require scoped bearer credentials for capture routes.
- Keep MCP read-only and require the `library:read` OAuth scope.
- Verify MCP with DCR, S256 PKCE consent, code exchange, initialize, and
  tools/list against `/mcp`. The scan must expose exactly the intended read-only
  tools; a missing or revoked bearer token returns 401.
- Keep thumbnail delivery authenticated and content-addressed.
- Never let the control plane accept, proxy, store, or log bookmark content,
  thumbnails, provider credentials, prompts, responses, capture tokens, or MCP
  traffic.
- Encrypt renewable installer authorization, bind it to owner/account, validate
  granted scopes, and stop using it immediately after revocation.
- Do not expose raw provider errors to users.
- Do not persist bookmark content in KV.
- Retrieval diagnostics may log only the approved structured counts and
  booleans from `apps/runtime/src/observability/retrieval.ts`, plus opaque IDs
  and safe codes.

## 17. Testing expectations

Worker tests use the Cloudflare runtime and the complete
`apps/runtime/schema.sql`. Browser
tests use a DOM environment and import the shared extension source.

Every behavior change needs a regression test at the narrowest useful layer.
High-risk changes also need fault injection for:

- Queue-send failure and duplicate delivery;
- stale revision and edit/AI races;
- provider timeout, malformed output, and allocation wait;
- import duplicates, invalid rows, chunk boundaries, and dispatch failure;
- SSRF redirects, oversized bodies, and invalid image signatures;
- authentication, CSRF, idempotency, and credential revocation;
- reset continuation and storage failure; and
- destructive selection and confirmation UI.

Managed installation/release changes also require mocked Cloudflare API
contracts and fault coverage for refresh/revocation, idempotent resume,
propagation delay, artifact/checksum failure, schema interruption, candidate
health, promotion, rollback, cohort pause, and control-plane outage boundaries.

Do not weaken or delete a test merely to make a refactor pass. If a deliberately
removed historical state is the subject of the test, replace it with coverage of
the current invariant.

## 18. Definition of done

A change is done when:

1. behavior matches the product requirements;
2. module boundaries and DRY ownership remain clear;
3. named functions have accurate JSDoc;
4. current schema and queries agree;
5. regression and fault tests cover the change;
6. `npm run check` passes;
7. `npm run build` and `npm run check:managed-byoc` pass without deploying;
8. generated extension and release artifacts match canonical source;
9. `git diff --check` is clean; and
10. all three documents remain authoritative and mutually consistent.
