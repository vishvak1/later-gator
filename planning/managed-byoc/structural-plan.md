# Later Gator Managed BYOC — Proposed Structural Plan

**Status:** proposed; no source move or runtime behavior change has occurred  
**Source repository:** `/Users/vishvakvragav/Documents/later-gator`

This plan converts the existing repository into one open-source monorepo. It
does not create a second product repository, and it stops the former practice of
maintaining a matching `my-later-gator` source clone. A test installation in the
owner's test Cloudflare account replaces the clone as the canary.

## 1. Target system

```text
Owner browser
├── latergator.app control plane
│   ├── confidential Cloudflare OAuth client for identity and installer subsets
│   ├── installation and release metadata
│   └── signed public catalogs
├── personal Later Gator Worker
│   ├── dashboard and APIs
│   ├── D1 application data
│   ├── KV or R2 thumbnails
│   ├── Vectorize
│   ├── Queues
│   └── MCP
└── official Chrome extension
    ├── separate public PKCE Chrome OAuth client
    └── direct capture to personal Worker
```

The two-client split is mandatory: one confidential control-plane client reuses
separate identity and installer authorization subsets, while the Chrome client
must use `token_endpoint_auth_method=none` and S256 PKCE. Exact scopes and
redirect URIs are maintained in `cloudflare-oauth-inventory.md`.

The control plane participates in management and authentication. It does not
proxy ordinary dashboard, capture, provider, MCP, or storage traffic.

## 2. Repository layout

```text
later-gator/
├── apps/
│   ├── control-plane/
│   │   ├── src/
│   │   │   ├── application/
│   │   │   ├── domain/
│   │   │   ├── adapters/
│   │   │   ├── routes/
│   │   │   ├── security/
│   │   │   └── observability/
│   │   ├── test/
│   │   ├── schema.sql
│   │   └── wrangler.jsonc
│   ├── runtime/
│   │   ├── src/
│   │   │   ├── application/
│   │   │   ├── domain/
│   │   │   ├── adapters/
│   │   │   ├── routes/
│   │   │   ├── security/
│   │   │   └── observability/
│   │   ├── web/
│   │   ├── test/
│   │   ├── schema.sql
│   │   ├── migrations/
│   │   └── wrangler.dev.jsonc
│   └── chrome-extension/
│       ├── src/
│       ├── test/
│       ├── assets/
│       └── manifest.json
├── packages/
│   └── contracts/
│       ├── identity-assertion.ts
│       ├── installation.ts
│       ├── model-catalog.ts
│       ├── pairing-grant.ts
│       ├── release-manifest.ts
│       ├── storage-plan.ts
│       └── system-health.ts
├── scripts/
│   ├── build-runtime-release.mjs
│   ├── verify-runtime-release.mjs
│   └── build-chrome-extension.mjs
├── docs/
├── planning/
└── package.json
```

The workspace should introduce only packages with real cross-application
ownership. Shared Zod contracts belong in `packages/contracts`; runtime-only
domain rules stay in the runtime instead of becoming a premature shared package.

## 3. Mapping the current application

| Current area | Target treatment |
| --- | --- |
| `src/domain` | Move intact to `apps/runtime/src/domain` |
| `src/application` | Move intact, then add storage/update use cases |
| `src/adapters` | Move intact; split thumbnail adapter into KV and R2 implementations |
| `src/routes` | Preserve product APIs; replace owner-login transport |
| `src/security` | Remove password vault; add signed-owner assertion and instance-secret vault |
| `src/observability` | Preserve redaction and extend safe storage/update events |
| `web/src` | Move to runtime; remove password UI and connection-code setup |
| `extension/shared` | Become the single Chrome extension source |
| Firefox manifest/build | Remove from the initial managed release |
| `schema.sql` | Become fresh-runtime base schema |
| No migration history | Add immutable upgrade migrations and ledger |
| `wrangler.jsonc` with fixed resource IDs | Replace with local-dev config plus release binding manifest |
| Deploy-to-Cloudflare/Git clone | Replace with OAuth installer API |
| `my-later-gator` source clone | Replace with an installation record in the test account |

The move must be behavior-preserving before authentication or deployment logic
is changed. Tests and generated assets move with their owners in the same commit.

## 4. Control-plane internals

### 4.1 Modules

- `domain`: installation states, release states, storage choices, scope rules,
  safe error codes, and transition invariants.
- `application`: authenticate owner, start installation, provision resources,
  resume failed installation, issue owner assertion, issue pairing grant, deploy
  release, migrate installation, roll back, disconnect, and uninstall.
- `adapters`: Cloudflare OAuth, Cloudflare user/resource APIs, encrypted token store,
  release artifact store, D1 repository, Queue/Workflow orchestration, and
  health-check client.
- `routes`: landing/onboarding pages, OAuth callbacks, installation status,
  extension auth callback, update management, and explicit uninstall.
- `security`: state/nonce/PKCE, OAuth token encryption, signed assertions,
  release signature verification, CSRF, and control-plane sessions.
- `observability`: opaque installation/release IDs and approved outcome codes
  only.

### 4.2 Control-plane D1

Proposed tables:

```text
owners
control_sessions
oauth_authorizations
installations
installation_resources
installation_jobs
runtime_releases
release_rollouts
pairing_grants
control_audit_events
```

`owners` stores a stable Cloudflare subject and timestamps. It does not need a
password or recovery material.

`oauth_authorizations` stores encrypted installer access/refresh tokens and the
granted scope/account set. Identity tokens are short-lived and are not reused as
installer credentials.

`installations` stores safe metadata: owner ID, target account ID, Worker name,
Worker URL, storage variant, installed release, desired release, health state,
and authorization state.

No control-plane table accepts bookmark fields, provider configuration, or
provider credentials.

### 4.3 Installation state machine

```text
draft
  -> awaiting_authorization
  -> provisioning
  -> initializing
  -> health_check
  -> ready

Any active step
  -> retryable_failure
  -> resuming

Any pre-ready step
  -> cleanup_required
  -> cancelled
```

Every resource creation stores its opaque ID before the next step. Repeating a
step must discover or reuse the intended resource rather than create duplicates.

## 5. Personal runtime internals

### 5.1 Authentication

Add:

- owner-login redirect to the control plane;
- signed, audience-bound owner assertion verification;
- one-time nonce/JTI consumption;
- owner-subject binding;
- ordinary local session creation; and
- control-plane issuer/signing-key rotation support.

Remove:

- bootstrap password lookup;
- password verification and throttling;
- password-derived key wrapping; and
- password fallback on MCP consent.

The runtime verifies a signed assertion and then owns its local session. It does
not call the Cloudflare account API and does not receive installer OAuth tokens.

### 5.2 Provider credential vault

The installer writes a random `INSTANCE_MASTER_KEY` as a personal Worker secret.
The runtime uses an AEAD envelope containing ciphertext, nonce, key version, and
credential type. Provider credentials have one encrypted D1 representation.

Provider API-key submission and testing routes remain same-origin runtime APIs.
The control plane has no provider-configuration endpoint.

### 5.3 Runtime D1 changes

Remove from the fresh schema:

```text
auth_config
login_attempts
sessions.encrypted_data_key
sessions.data_key_nonce
```

Add or revise:

```text
installation_state
owner_identity
schema_migrations
runtime_release_state
thumbnail_storage_config
thumbnails.storage_backend
thumbnail_migrations
extension_devices
```

`capture_credentials` remains the authorization source for extension and iOS
capture. An extension device may reference a capture credential rather than
introduce a second bearer-token system.

### 5.4 Thumbnail storage adapter

Define one runtime-owned interface:

```text
ThumbnailStore
  put(objectKey, bytes, metadata)
  get(objectKey)
  delete(objectKey)
```

Implementations:

- `KvThumbnailStore`;
- `R2ThumbnailStore`; and
- `DisabledThumbnailStore`.

The thumbnail job pipeline depends on `ThumbnailStore`, not a Cloudflare binding
directly. D1 records the backend for each object so an installation can read KV
and R2 during migration.

The installer produces two binding manifests from one runtime artifact:

- KV installation: D1 + KV + existing compute/search bindings;
- R2 installation: D1 + R2 + existing compute/search bindings.

An upgrade from KV to R2 temporarily deploys both bindings.

### 5.5 Model catalog

The runtime fetches a signed model catalog through a bounded public request,
validates the shared Zod schema and signature, and stores the last accepted
revision in personal D1. Provider selection and keys remain separate local rows.

Catalog retrieval failure is non-fatal. A catalog may mark a model deprecated,
but must not silently switch an owner's active provider or model.

## 6. Chrome extension structure

Retain the current capture UI and direct Worker requests. Replace manual
connection-code parsing with:

- `chrome.identity.launchWebAuthFlow`;
- a control-plane identity callback;
- installation discovery;
- an installation-bound, one-time pairing grant;
- exact-origin optional host permission; and
- capture-token exchange with the personal Worker.

Persist only:

- personal Worker origin;
- capture token;
- safe extension-device identifier; and
- non-sensitive UI preferences.

The extension build contains no installer client secret or Cloudflare account
token.

## 7. Shared contracts

All cross-component payloads are versioned, bounded, and Zod-validated:

- `OwnerAssertion`: issuer, audience, Cloudflare subject, installation ID,
  nonce, JTI, issued/expiry times.
- `PairingGrant`: owner subject, installation ID, extension device ID, requested
  capture scopes, nonce, JTI, issued/expiry times.
- `InstallationRecord`: safe resource and release metadata only.
- `RuntimeReleaseManifest`: artifact hash/signature, compatibility date,
  schema range, binding requirements, health contract.
- `ModelCatalog`: provider/model metadata with no user state.
- `StoragePlanCatalog`: human-reviewed informational copy, review date, and
  official Cloudflare links.
- `SystemHealth`: runtime version, schema version, binding readiness, queue
  readiness, and safe error codes—never library counts or content.

## 8. Release artifact and update structure

One CI build produces:

```text
runtime-release/
├── worker bundle
├── static assets
├── base schema checksum
├── ordered migration checksums
├── binding variants
└── signed release manifest
```

Artifacts are immutable. The control plane records the digest it deployed and
the Cloudflare Worker version ID returned for each installation.

Updates occur across installation cohorts. Within one personal installation,
the workflow records a D1 Time Travel bookmark, applies only compatible
migrations, uploads a new Worker version, performs a health check, promotes it,
and records completion. Storage and Worker rollback are coordinated because a
Worker version does not contain D1 or object-storage state.

## 9. Operational trust boundaries

| Boundary | Permitted | Forbidden |
| --- | --- | --- |
| Identity authorization | Identify owner | Deploy or read account resources |
| Installer authorization | Provision/update declared resources | Enter runtime or extension sessions |
| Control plane | Store safe installation metadata | Store bookmark/provider data |
| Personal runtime | Process private application data | Receive installer OAuth token |
| Chrome extension | Capture with narrow token | Receive provider or deployment secrets |
| Public catalogs | Describe compatibility/pricing copy | Change user selection or execute code |

## 10. Documentation transition

During implementation, this planning set remains explicitly non-authoritative.
Before release:

1. Merge accepted product behavior into `docs/product-requirements.md`.
2. Merge accepted architecture into `docs/technical-design.md`.
3. Merge workspace, test, release, and operations instructions into
   `docs/developer-guide.md`.
4. Remove superseded deployment/password/Firefox instructions.
5. Delete `planning/managed-byoc` so the repository returns to one canonical
   specification set.
