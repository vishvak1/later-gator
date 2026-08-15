# Later Gator — Technical Design

**Product version:** 1.0.0
**Status:** implemented and authoritative

## 1. Architecture

Later Gator is one Cloudflare Worker with five entry surfaces:

1. authenticated dashboard pages and JSON APIs;
2. scoped browser-extension and iOS capture APIs;
3. a read-only Streamable HTTP MCP endpoint;
4. a sequential background Queue for organization, embedding, and reset work;
5. an independent Queue for thumbnail work.

D1 is authoritative for application state and the bookmark library. Workers KV
stores only optimized thumbnail bytes. Vectorize stores derived embeddings.
Workers AI, OpenAI, or Anthropic supplies organization inference. Cloudflare
Images performs bounded preview transformation. Browser Rendering is a fallback
for script-rendered pages. A Durable Object holds live dashboard WebSockets so a
Queue consumer can notify open tabs without storing bookmark content.

## 2. Repository boundaries

```text
src/
├── index.ts                 Worker export surface
├── worker.ts                HTTP and Queue routing
├── application/             product orchestration
├── domain/                  pure rules, schemas, and presentation constants
├── adapters/                D1, providers, remote fetch, browser, live events
├── routes/                  HTTP handlers and server-rendered pages
├── security/                sessions, credentials, crypto, capture auth
└── generated/               content-hashed web asset manifest
web/src/                     dashboard browser code and styles
extension/shared/            one browser-extension implementation
extension/manifests/         Chrome and Firefox manifest differences
test/                        Worker-runtime tests
web/test/                    browser DOM tests
schema.sql                   complete current D1 schema
docs/                        exactly three authoritative documents
```

Imports follow those boundaries. Domain modules do not perform I/O. Routes
validate transport input and delegate behavior. Adapters own external systems.
Request-scoped values stay inside handlers; no module-level mutable request
state is permitted.

## 3. Cloudflare bindings

| Binding | Type | Responsibility |
| --- | --- | --- |
| `DB` | D1 | Bookmark library, jobs, sessions, settings, metadata |
| `THUMBNAILS` | Workers KV | Private optimized thumbnail bytes |
| `BACKGROUND_QUEUE` | Queue | Organization, embedding, dispatch, reset |
| `THUMBNAIL_QUEUE` | Queue | Independent thumbnail discovery and ingest |
| `AI` | Workers AI | Organization and embedding inference |
| `VECTORS` | Vectorize | 1,024-dimensional bookmark embeddings |
| `IMAGES` | Images | Aspect-preserving WebP transformation |
| `BROWSER` | Browser Rendering | Bounded dynamic-page fallback |
| `LIBRARY_EVENTS` | Durable Object | Live WebSocket fan-out to dashboards |
| `ASSETS` | Static Assets | Content-hashed dashboard assets |
| `PASSWORD` | Secret | Initial and service credential wrapping input |

`ENVIRONMENT` and `TIMEZONE` are non-secret configuration values. Observability
is enabled with sampling. There is no Cron trigger; authenticated bootstrap and
Queue continuation messages repair bounded backlogs.

The Durable Object is declared in Wrangler's current `exports` map with SQLite
storage. This declarative class lifecycle has no tagged history and does not
transform Later Gator data.

## 4. Entry points and routing

`src/index.ts` exports the Worker and `LibraryEvents`. `src/worker.ts` exposes an
`ExportedHandler<Env>` with `fetch` and `queue` methods.

Important page routes:

- `GET /` login or dashboard redirect
- `GET /setup`
- `GET /dashboard`
- `GET /settings`
- `GET /extension/chrome`
- `GET /extension/firefox`
- `GET /shortcut/ios`

Important authenticated APIs:

- setup, bootstrap, bookmarks, relationships, tags, folders, search filters;
- import status, CSV import, JSON/CSV export;
- automation pause/resume and reset;
- provider test, activation, credential removal, and usage links;
- capture credential issuance/revocation and MCP OAuth connection management;
- authenticated thumbnail delivery and live-event WebSocket setup.

Scoped capture routes authenticate bearer credentials separately from dashboard
sessions. The stable MCP route accepts only OAuth bearer grants with the
`library:read` scope and exposes only read tools.

## 5. D1 schema

`schema.sql` is the complete schema for a fresh or already-current database. It
uses `CREATE ... IF NOT EXISTS` and `INSERT OR IGNORE` so initialization is
repeatable. There is no numbered application migration directory or runtime
data-migration path.

Core tables:

- `app_state`, `profile`, `provider_settings`, `provider_candidates`;
- `folders`, `bookmarks`, `tags`, `bookmark_tags`,
  `bookmark_relationships`;
- `background_jobs`, `thumbnail_jobs`, `thumbnails`;
- `auth_config`, `sessions`, `encrypted_credentials`, `login_attempts`;
- `capture_credentials`, `mcp_connections`, `idempotency_records`;
- `import_sessions`, `audit_events`, and `bookmarks_fts`.

The FTS virtual table is maintained by insert, update, and delete triggers.
Partial unique indexes enforce one active normalized URL and one active
organization job per bookmark. Foreign keys cascade dependent relationships
and tags while preventing deletion of referenced fixed folders.

The integer `revision` on a bookmark is concurrency state, not a product
version. Cryptographic `schema_version` values identify the stored encryption
format so unsupported key material fails closed; they do not select application
code or database migrations.

## 6. Database initialization

Local initialization:

```bash
npm run db:init:local
```

Remote initialization is an explicit deployment step:

```bash
npm run db:init:remote
```

`npm run deploy` runs remote initialization before `wrangler deploy`. Schema
changes modify `schema.sql` directly because the project has one current schema.
Any destructive schema change requires an explicit backup and release decision;
it must never be hidden in request handling.

Tests read `schema.sql`, compact each complete statement to the one-line format
expected by `D1Database.exec`, and initialize their isolated D1 binding before
the suite.

## 7. Authentication and credentials

### Dashboard password

PBKDF2-SHA256 derives an AES-GCM wrapping key from `PASSWORD`, a random salt,
and the stored iteration count. The wrapping key decrypts a random data key.
An encrypted verifier distinguishes a valid password from corrupt or unsupported
state. Comparisons use constant-time helpers where appropriate.

### Sessions

A login creates a random token. D1 stores only its hash plus the encrypted data
key, CSRF hash, and expiry timestamps. Cookies are `HttpOnly`, `Secure`,
`SameSite=Strict`, and scoped to `/`. Mutations require matching origin and CSRF
token. Logout and expiry revoke or expire the session.

### Provider credentials

OpenAI and Anthropic credentials have two encrypted representations: one under
the unlocked dashboard data key and one under a service key derived from the
deployment secret so Queue consumers can call the provider without a browser
session. Plaintext credentials are never stored or logged.

### Capture and MCP

Capture tokens are random and stored as hashes with narrow JSON scopes. Extension
and iOS routes authenticate and update last-used time. MCP uses the stable
`/mcp` endpoint behind `@cloudflare/workers-oauth-provider`. Discovery advertises
RFC 9728 protected-resource metadata and OAuth authorization-server metadata.
Clients use CIMD when supported or Dynamic Client Registration as a fallback,
then authorization code flow with S256 PKCE. The owner-facing consent page
requires either an existing dashboard session plus CSRF or the existing Later
Gator password.

OAuth client, grant, code, refresh-token, and access-token records live in the
private `OAUTH_KV` binding. A configured deployment may bind it to the existing
thumbnail KV because the systems use disjoint key prefixes; a Deploy to
Cloudflare flow may provision it automatically instead. Neither route asks the
owner to find a resource ID or enter another secret.
`mcp_connections` stores only a grant identifier, hashed client identifier,
safe assistant label, read-only scope, and timestamps for Settings. Disconnect
revokes that grant without affecting other assistants. The endpoint must pass an
MCP initialize and tools/list exchange, and every advertised tool remains
annotated read-only.

## 8. Bookmark identity and writes

`normalizeBookmarkUrl` accepts only HTTP and HTTPS URLs, removes fragments,
normalizes host/default ports, and preserves path/query semantics. D1 enforces
active normalized-URL uniqueness.

Every material bookmark mutation increments `revision` and `modified_at`.
Organization jobs capture `expected_revision`. A result commits only when:

- the bookmark still exists and is not deleted;
- it remains in `folder_unsorted`;
- its organization policy is `full` or `preserve`;
- its revision still equals the job expectation; and
- the job remains active for the current organization generation.

If an edit changes the revision, the job refreshes/retries. If a bookmark leaves
Unsorted, the job is cancelled as complete work rather than allowed to overwrite
the owner's folder choice.

## 9. Queue contracts

Background messages are strict Zod unions:

```ts
type BackgroundMessage =
  | { type: "organize"; jobId: string }
  | { type: "dispatch_pending" }
  | { type: "embed_pending" }
  | { type: "reset_storage" };
```

Thumbnail messages are:

```ts
type ThumbnailMessage =
  | { type: "thumbnail"; jobId: string }
  | { type: "dispatch_thumbnail_pending" };
```

Unknown messages are acknowledged without work. Handler exceptions retry after
30 seconds. Provider backoff retries after 300 seconds; a revision refresh uses
a short retry. At-least-once delivery is expected, so D1 state and idempotency
keys—not Queue delivery count—decide whether work is current.

The organization consumer has concurrency one. The thumbnail consumer is
independent with bounded concurrency three. Queue-send failures leave jobs in
`pending_dispatch`; bootstrap repair sends another dispatcher message.

## 10. Organization pipeline

`organizeBookmarkJob` owns the lifecycle:

1. Atomically claims eligible work and loads a `JobContext`.
2. Resolves page evidence through oEmbed/provider metadata and bounded remote
   fetches. One Browser Rendering attempt is allowed when primary evidence is
   still absent and the daily browser latch is open.
3. Builds one structured prompt from bookmark data, active and retired tags,
   related bookmarks, and personal instructions.
4. Calls the selected provider adapter with bounded request/response bodies.
5. Parses and validates the organization result.
6. Applies deterministic folder rules, normalized tags, preserve/full policy,
   and revision conditions in D1.
7. Marks review, retry, provider wait, or completion with safe error codes.
8. Schedules semantic embedding and notifies the live event object.

Provider adapters classify authentication, allocation, throttling, invalid
model, timeout, transport, and malformed-output failures without persisting
provider bodies. Workers AI supports both response envelope shapes currently
returned by available models; that adapter compatibility is provider handling,
not an application migration path.

## 11. Backlog recovery

`repairOrganizationBacklog` is idempotent and current-state-only. It:

- releases a provider allocation wait whose `retry_after` has arrived;
- sends failed/review bookmarks from Unsorted to Need for Review;
- restores organization policy for eligible Unsorted bookmarks;
- requeues stale queued/running jobs after 15 minutes;
- releases provider-wait jobs once the provider is ready; and
- creates a job for an eligible pending/processing bookmark that has none.

Recovery never cancels a pending bookmark without replacement. It returns
whether a dispatcher message is needed.

## 12. Import pipeline

The CSV handler reads a bounded form upload, parses quoted CSV deterministically,
maps supported Raindrop columns, normalizes URLs and tags, identifies duplicates,
and creates one `import_sessions` row. Valid bookmarks are inserted directly in
chunks with shared timestamps and D1 batch operations.

There is no staging table in the current schema. Progress equals the committed,
duplicate, invalid, and failed counts on the import session. Dispatcher messages
continue bounded job delivery after the direct commit. Thumbnail jobs run on
their independent Queue.

## 13. Thumbnail pipeline and SSRF controls

All candidate URLs pass `safeRemoteUrl`, which rejects embedded credentials,
non-HTTP schemes, localhost, private IPv4 ranges, link-local ranges, and unsafe
IPv6 destinations. Redirect targets are revalidated. Fetches use browser-like
headers without cookies or credentials, limit redirects, bound bytes, and cancel
oversized response streams.

Image signatures must match supported raster formats. Cloudflare Images returns
an uncropped, aspect-preserving WebP inside the configured maximum dimensions.
KV keys contain opaque IDs. The delivery route validates session, bookmark, and
current thumbnail ID before returning `private, max-age=31536000, immutable`.

## 14. Search

Text search uses `bookmarks_fts`; field filters and cursor pagination remain in
D1. Semantic search embeds the query, asks Vectorize for IDs, and constrains the
D1 query to those IDs. Embeddings include current title, description, note,
hostname, URL, folder, and tags. `embedded_revision` records whether the current
bookmark revision has been indexed.

Embedding work is best effort. Failed Vectorize operations do not block library
writes or ordinary search. Deletion and reset attempt to remove corresponding
vectors; D1 joins prevent orphan vectors from exposing data.

## 15. Extension build and pairing

`extension/shared` is the only popup/background implementation. Browser-specific
manifests live in `extension/manifests`. `npm run build:extensions` recreates the
ignored `extension/chrome` and `extension/firefox` packages by copying shared
assets and the correct manifest. Browser tests import the shared source and
manifest templates, preventing the generated copies from becoming a second
source of truth.

The pairing code is `later-gator.` plus base64url JSON containing only the
deployment origin and capture token. The extension validates HTTPS or localhost,
requests the deployment host permission, stores the decoded fields, and validates
the credential before showing capture controls.

## 16. Live updates

`LibraryEvents` accepts authenticated dashboard WebSockets and stores only live
socket attachments. Queue and capture handlers call `notifyLibraryChanged`
after visible writes. The browser coalesces notifications, refreshes only when
the library fingerprint changes, reconnects with backoff, and refreshes on
visibility/focus as a fallback.

## 17. Observability and privacy

Logs and `audit_events` may contain event name, request ID, opaque subject ID,
count, duration, provider name/model, and approved safe outcome code. They must
not contain bookmark URLs, titles, notes, descriptions, CSV rows, page content,
tokens, ciphertext, MCP secrets, or remote response bodies.

Every Promise is awaited, returned, caught, or deliberately scheduled. External
inputs and stored JSON are validated. Large or unknown remote bodies are streamed
and bounded rather than read unconditionally.

## 18. Verification

`npm run check` runs:

1. extension and dashboard builds;
2. generated Worker binding verification;
3. Worker and browser TypeScript checks;
4. named-function documentation enforcement;
5. typed ESLint rules;
6. Worker-runtime tests; and
7. browser DOM tests.

`npm run build` performs a production Wrangler dry run without deploying.
Behavior changes require regression tests. Schema, Queue, security, import,
revision, and destructive-action changes require fault-path coverage in addition
to happy-path coverage.
