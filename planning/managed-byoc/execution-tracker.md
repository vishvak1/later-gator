# Later Gator Managed BYOC — Execution Tracker

**Status:** authoritative implementation ledger and cross-session handoff  
**Last updated:** 2026-08-22, Asia/Kolkata  
**Current branch:** `prd-change`  
**Active stage:** `ACTIVE` owner acceptance of personal-runtime Cloudflare login

**Next task:** owner opens the current personal Worker and clicks **Continue
with Cloudflare**. The control plane now validates the exact ready installation,
reuses or obtains the owner's Cloudflare identity session, and returns a
single-use installation-bound assertion to that Worker's exact callback.

**Deployment state:** development control-plane Worker version
`18cde349-a577-4ee3-b60c-48f894460521` is healthy and live with the missing
runtime-login route and deleted-Worker reconciliation. The current KV
installation `b89a58a2-fff3-4566-af96-537f682292a0` is ready, its personal
Worker exists, and the public runtime health contract is ready. No personal
resource was changed manually during this repair.

## 1. Purpose and authority

This is the one source of truth for:

- what managed-BYOC work is complete;
- what is partially complete;
- the one active implementation slice;
- exact next-session tasks;
- validation evidence;
- known risks and external gates; and
- append-only coding-session handoffs.

Do not duplicate live progress in the proposed PRD, structural plan, static
implementation plan, README, or canonical product specifications.

The documents have different responsibilities:

1. `docs/product-requirements.md`, `docs/technical-design.md`, and
   `docs/developer-guide.md` describe the current application's compatibility
   baseline until the managed-BYOC transition is accepted.
2. `planning/managed-byoc/product-requirements.md` defines the requested target
   product.
3. `planning/managed-byoc/structural-plan.md` defines the target repository and
   system boundaries.
4. `planning/managed-byoc/implementation-plan.md` defines phase order, gates,
   and launch acceptance.
5. This tracker records execution status only.

If the documents conflict, stop and resolve the conflict against the user's
latest explicit decision before changing behavior. Never silently rewrite a
product decision in this tracker.

## 2. Status vocabulary

| Status | Meaning |
| --- | --- |
| `DONE` | Implemented and supported by recorded validation evidence |
| `ACTIVE` | The single slice currently authorized for implementation |
| `TODO` | Required but not started |
| `PARTIAL` | Some work exists, but its phase exit gate is not satisfied |
| `EXTERNAL` | Requires an owner/account/store action; local code may continue |
| `BLOCKED` | Work cannot safely progress; the exact blocker must be recorded |
| `DEFERRED` | Deliberately outside the current milestone or initial release |

Only one task may be `ACTIVE` at a time. A phase is `DONE` only when its exit
gate and required tests are recorded here.

## 3. Non-negotiable product decisions

- The existing `later-gator` repository is the sole public source repository.
- Official users do not receive or manage GitHub forks, branches, or pull
  requests.
- `latergator.app` is a management control plane, not the bookmark data plane.
- Each personal runtime, its bookmarks, thumbnails, provider choice, provider
  keys, prompts, responses, Vectorize data, and application logs remain in the
  owner's Cloudflare account.
- Cloudflare OAuth is the only owner sign-in method. There is no Later Gator
  password, password reset, or recovery phrase in the target product.
- Control-plane identity and installer authorization reuse one confidential
  Cloudflare OAuth client whose stored permission ceiling covers both flows;
  each authorization request asks only for the subset required at that moment.
  The later Chrome client remains public and uses PKCE without a secret.
- Workers AI is the default provider. OpenAI and Anthropic configuration occurs
  only in the personal runtime.
- OpenAI and Anthropic keys are encrypted under a per-installation Worker secret
  and stored only as ciphertext in the personal runtime D1 database.
- Thumbnail modes are `kv`, `r2`, and `disabled`. KV is the initial default.
- Thumbnail failure never fails bookmark capture or organization.
- KV-to-R2 thumbnail bytes move directly inside the owner's Cloudflare account,
  never through the control plane.
- One official Chrome extension is in scope initially. Firefox publication is
  deferred.
- Managed updates deploy immutable, signed runtime releases directly through
  owner-authorized Cloudflare APIs. Users do not merge code updates.
- The personal runtime and existing extension credentials continue operating
  during a control-plane outage; new login, pairing, installation, and updates
  may wait.
- There is one current runtime codebase. Migration history must not create
  parallel numbered application trees.

## 4. Working-tree safety snapshot

The working tree was already dirty when managed-BYOC implementation began. It
contains desired X destination-review work, generated extension output, current
specification edits, and the managed-BYOC foundation. Treat every pre-existing
change as user-owned and preserve it.

Rules for all sessions:

- Do not run `git reset`, `git checkout --`, destructive cleanup, or an implicit
  stash.
- Do not commit or deploy unless the user explicitly requests it.
- Do not recreate `my-later-gator` as a maintained source clone.
- Move modified files together with their behavior and tests during Phase 1.
- Before and after a structural move, run the complete compatibility gate.
- Use the connected test Cloudflare account only for an explicitly announced
  acceptance or provisioning step.
- Never run the root `npm run deploy` as validation; it initializes remote D1
  and deploys production resources.

Current modified/untracked areas that must survive the workspace move:

- canonical specifications in `docs/`;
- canonical Chrome-extension source in `apps/chrome-extension`; generated
  `extension/chrome` is disposable ignored output and Firefox is absent;
- X destination-review application, routing, UI, schema, logs, and tests;
- root runtime source, web source, schema, and Wrangler configuration;
- `apps/control-plane`;
- `packages/contracts`; and
- `planning/managed-byoc`.

## 5. Phase board

### Phase 0 — Freeze baseline and contracts: `PARTIAL`

- [x] `P0.1` Record current behavior from canonical specifications and existing
  regression tests.
- [x] `P0.2` Run the current root compatibility gate before structural work.
- [x] `P0.3` Accept the proposed PRD, structural plan, and implementation plan as
  the direction for staged implementation.
- [x] `P0.4` Add bounded shared contracts for owner assertions, pairing grants,
  installation metadata, release manifests, model catalogs, storage-plan copy,
  and privacy-safe health.
- [x] `P0.5` Add contract tests rejecting bookmark and provider configuration in
  control-plane payloads.
- [x] `P0.6` Enumerate the exact current Cloudflare OAuth scopes for the identity,
  KV installer, R2 installer, and incremental KV-to-R2 flows; record the reason
  for each scope.
- [x] `P0.7` Record private-development and public redirect URI inventories for
  the control plane and Chrome extension.
- [ ] `P0.8` Establish a clean implementation checkpoint if and when the user
  explicitly authorizes a commit. This is a safety gate for history, not a
  blocker to local behavior-preserving work.

Exit gate still open only because the current working tree has no
owner-authorized checkpoint commit. The OAuth scope and redirect inventories
are complete in `cloudflare-oauth-inventory.md`; `P0.8` does not block local
implementation.

### Phase 1 — Create the workspace without changing behavior: `DONE`

- [x] `P1.1` Register npm workspaces for `apps/*` and `packages/*`.
- [x] `P1.2` Move the existing Worker, schema, web application, and Worker tests
  into `apps/runtime` with no behavior change.
- [x] `P1.3` Move `extension/shared` into `apps/chrome-extension` as the single
  source while retaining Chrome behavior and the current X-link UI.
- [x] `P1.4` Stop treating generated Chrome/Firefox directories as source
  ownership; keep only build output required for current validation.
- [x] `P1.5` Remove Firefox from the initial managed release without breaking
  current Chrome tests or losing shared source behavior.
- [x] `P1.6` Add real `apps/control-plane` and `packages/contracts` packages.
- [x] `P1.7` Rewire root type, lint, documentation, unit, web, extension, contract,
  and dry-run build commands for the final workspace layout.
- [x] `P1.8` Prove runtime and Chrome behavior parity after the move, including
  deterministic generated assets.

Exit gate: repository structure changes while the current user-visible behavior
and regression coverage remain unchanged.

### Phase 2 — Control-plane identity shell: `DONE`

- [x] `P2.1` Add the control-plane Worker and privacy-bounded D1 schema.
- [x] `P2.2` Register a private development Cloudflare OAuth client. The owner
  created `Later Gator Dev` and verified its stored scope list through the
  dashboard. Live acceptance proved the client rejects `openid`; add
  `user-details.read` and remove the extra `workers-scripts.edit` scope before
  retrying. `workers-scripts.write` remains required for later provisioning.
- [x] `P2.3` Implement Authorization Code, state, nonce, S256 PKCE, bounded
  provider responses, RS256 ID-token verification, and local opaque sessions.
- [x] `P2.4` Store a hash derived from the stable Cloudflare subject instead of
  email or profile data.
- [x] `P2.5` Implement signed, installation-bound owner assertions and public
  verification keys with rotation support.
- [x] `P2.6` Render signed-out and authenticated `no installation` control-plane
  pages.
- [x] `P2.7` Add explicit deletion of control-plane-only identity metadata.
- [x] `P2.8` Add remaining issuer, audience, expiry, key-rotation, provider
  failure, and log-redaction tests.
- [x] `P2.9` Complete live private-client sign-in acceptance. The owner granted
  only `user-details.read`, returned to the authenticated empty-installation
  dashboard, and read-only D1 inspection confirmed bounded identity/session
  metadata with no token or profile columns.

Exit gate: a test owner completes Cloudflare identity login and sees the empty
installation dashboard without granting deployment authority.

### Phase 3 — Runtime identity and credential vault: `DONE`

- [x] `P3.1` Add owner-login redirect and assertion callback.
- [x] `P3.2` Bind one installation to one Cloudflare subject.
- [x] `P3.3` Verify audience/installation/subject and consume assertion nonce/JTI
  once.
- [x] `P3.4` Create runtime sessions without encrypted data-key session copies.
- [x] `P3.5` Remove password UI, routes, fallback, throttling, `PASSWORD`, and
  password-derived wrapping from the fresh target schema and runtime.
- [x] `P3.6` Add `INSTANCE_MASTER_KEY` and a versioned AEAD credential envelope.
- [x] `P3.7` Store one provider-credential ciphertext representation in personal
  D1 and prove the control plane is never called.
- [x] `P3.8` Require an authenticated owner session for MCP approval.
- [x] `P3.9` Pass assertion, session, CSRF, origin, logout, MCP, provider, Queue,
  and secret/log regression tests.

Exit gate: no Later Gator password or recovery phrase remains in the target
runtime; provider keys work entirely inside the personal installation.

### Phase 4 — Idempotent OAuth provisioning: `PARTIAL`

- [x] `P4.1` Add and accept the installer authorization flow against the same
  private Cloudflare OAuth client, requesting only its provisioning subset.
- [x] `P4.2` Encrypt, rotate, revoke, and scope installer authorization records.
- [x] `P4.3` Add the initial KV/R2 storage choice before deployment
  authorization; the runtime-owned disabled mode and later switching belong to
  Phase 5.
- [x] `P4.4` Implement installation, resource, and resumable-job D1 records.
- [x] `P4.5` Implement idempotent D1, KV/R2, Vectorize, Queue, OAuth KV, Worker,
  asset, binding, secret, `workers.dev`, and schema-initialization steps.
- [x] `P4.6` Detect inactive R2 and pause for explicit owner checkout.
- [x] `P4.7` Add safe resume, duplicate-click protection, and compensating
  cleanup with explicit confirmation.
- [x] `P4.8` Add privacy-safe runtime health checks.
- [ ] `P4.9` Pass mocked Cloudflare API contracts and disposable KV/R2 test-account
  acceptance.

Exit gate: a nontechnical owner provisions a working personal test installation
without GitHub, Wrangler, binding IDs, or manual Vectorize configuration.

### Phase 5 — Thumbnail resilience and migration: `DONE`

- [x] `P5.1` Add the runtime-owned `ThumbnailStore` interface.
- [x] `P5.2` Add KV, R2, and disabled implementations.
- [x] `P5.3` Record storage backend and byte-size metadata per thumbnail.
- [x] `P5.4` Preserve bookmarks, AI, search, and existing reads during thumbnail
  quota/capacity/provider failures.
- [x] `P5.5` Add disable, reclaim, and storage-status owner actions.
- [x] `P5.6` Add resumable mixed-backend KV-to-R2 copying entirely inside the
  personal runtime.
- [x] `P5.7` Require verification and explicit approval before source deletion.
- [x] `P5.8` Pass limit, disabled, mixed-read, interruption, resume, and
  control-plane-exclusion tests.

Exit gate: thumbnails may pause, disable, fail, or migrate without losing or
blocking bookmarks.

### Phase 6 — Model and plan catalogs: `DONE`

- [x] `P6.1` Build signed publication for the existing bounded catalog contracts.
- [x] `P6.2` Fetch, verify, and cache the last valid catalogs in personal D1.
- [x] `P6.3` Replace free-text OpenAI/Anthropic model fields with supported
  dropdowns and clear deprecated/unavailable states.
- [x] `P6.4` Prove catalog refresh never changes the active provider or model.
- [x] `P6.5` Show storage-plan facts as dated informational copy with official
  links, never runtime quota logic.
- [x] `P6.6` Pass invalid signature, schema, replay, stale, network, unknown model,
  and privacy-boundary tests.

Exit gate: compatibility information can update independently while provider
selection and secrets remain local and stable.

### Phase 7 — Official Chrome extension: `PARTIAL`

- [x] `P7.1` Create `apps/chrome-extension` from the canonical shared source.
- [x] `P7.2` Add Chrome identity OAuth and control-plane installation discovery.
- [x] `P7.3` Issue one-time, installation-bound pairing grants.
- [x] `P7.4` Request optional permission for the exact personal Worker origin.
- [x] `P7.5` Exchange grants for narrow existing capture credentials.
- [x] `P7.6` Add device naming, last-used state, revocation, and reconnect.
- [x] `P7.7` Preserve popup, duplicate, relationship, X-link selection/review,
  and direct-capture behavior.
- [x] `P7.8` Pass permission, cancellation, wrong-owner, replay, revocation,
  reachability, remote-code, and existing UI regression tests.
- [ ] `P7.9` Prepare and submit the Chrome Web Store package. Status: `EXTERNAL`
  for final submission.

Exit gate: the official extension connects by Cloudflare identity and captures
directly without pasted URLs or tokens.

### Phase 8 — Managed releases and schema evolution: `PARTIAL`

- [x] `P8.1` Produce immutable runtime bundles and signed manifests.
- [x] `P8.2` Add ordered checksum-verified schema migrations and ledgers.
- [x] `P8.3` Add compatible schema ranges and expand/migrate/contract rules.
- [x] `P8.4` Record D1 Time Travel position before risky mutations.
- [x] `P8.5` Upload, health-check, atomically promote, and record Worker versions.
- [x] `P8.6` Roll out through internal canary and progressively larger cohorts.
- [x] `P8.7` Pause automatically on safe failure thresholds.
- [x] `P8.8` Coordinate code, D1, and object-storage rollback compatibility.
- [x] `P8.9` Show safe update history and authorization state.
- [ ] `P8.10` Pass fresh-install, supported-upgrade, interruption, failure,
  rollback, revocation, and control-plane-outage tests.

Exit gate: a prior supported test installation updates and recovers without Git
or Wrangler work by its owner.

### Phase 9 — Canonical documentation and launch: `TODO`

- [ ] `P9.1` Merge accepted target requirements into the three canonical
  specifications and remove superseded password/deploy/fork instructions.
- [ ] `P9.2` Rewrite README onboarding around `latergator.app`.
- [ ] `P9.3` Document exact OAuth permissions, storage choices, current-facts
  dates, provider ownership, revocation, disconnect, export, and uninstall.
- [ ] `P9.4` Complete privacy policy, threat model, incident runbooks, signing and
  secret rotation, dependency audit, and Chrome disclosures.
- [ ] `P9.5` Run clean KV and R2 installs, provider acceptance, control-plane
  outage, migration, update, rollback, export, and uninstall drills.
- [ ] `P9.6` Promote OAuth clients to public after publisher-domain verification.
  Status: `EXTERNAL`; public promotion is a launch action.
- [ ] `P9.7` Reconcile and delete this planning directory after its accepted
  content becomes canonical, leaving one final specification set.

Exit gate: every acceptance item in the proposed PRD and implementation plan is
demonstrably satisfied.

## 6. First vertical milestone

The first managed-BYOC milestone remains:

1. Sign into a development `latergator.app` with Cloudflare identity.
2. Authorize the connected test Cloudflare account.
3. Choose KV thumbnail storage.
4. Provision one personal installation without GitHub.
5. Sign into the personal Worker through Cloudflare.
6. Save one dashboard bookmark.
7. Prove control-plane D1 and logs contain no bookmark or provider fields.

R2 live acceptance, catalog publication, Chrome Web Store submission, and
automatic population-wide updates follow after this trust-boundary milestone.

## 7. Current implementation inventory

### Shared contracts

Implemented under `packages/contracts`:

- owner assertion payload;
- pairing grant payload;
- safe installation metadata;
- signed model catalog shape;
- signed runtime release manifest shape;
- dated storage-plan catalog shape; and
- privacy-safe system health shape.

The contracts are strict and reject unknown private fields.

### Control-plane foundation

Implemented under `apps/control-plane`:

- generated `Env` bindings from `wrangler.jsonc`;
- production compatibility date `2026-08-19`;
- identity-only OIDC discovery pinned to the configured Cloudflare issuer;
- Authorization Code with state, nonce, and S256 PKCE;
- bounded token and JWKS responses;
- RS256 ID-token verification;
- short-lived, installation-bound ES256 owner assertions;
- bounded signing-key rotation and a public verification-only JWKS endpoint;
- one-time OAuth state consumption;
- stable subject hashing;
- hashed local session and CSRF credentials;
- same-origin logout;
- explicit control-plane identity-metadata deletion;
- script-free signed-out and empty-installation pages;
- safe event-code-only logs; and
- D1 tables for owners, login requests, sessions, and content-free audit events.

The control-plane schema contains no bookmark, thumbnail, provider,
provider-key, prompt, response, or capture-data table.

### Runtime identity and credential boundary

Implemented under `apps/runtime`:

- control-plane redirect with hashed state and nonce persistence;
- strict ES256 owner-assertion verification against bounded public JWKS;
- installation, issuer, audience, subject, expiry, nonce, and one-time JTI
  enforcement;
- one-owner installation binding and ordinary hashed local sessions;
- Cloudflare-only sign-in UI with no password or recovery fallback;
- one versioned AES-GCM provider-credential ciphertext under the personal
  `INSTANCE_MASTER_KEY` Worker secret;
- authenticated-session and CSRF enforcement for MCP approval; and
- tests proving provider credentials never call or enter the control plane.

### Remaining live connections

- The control plane now has the provisioning, release, and extension-pairing
  paths. One disposable KV installation shell and active encrypted installer
  authorization exist; its resumable provisioning steps have not yet created
  personal Cloudflare resources.
- Automatic updates are implemented and failure-tested locally; their live
  acceptance begins after the first disposable runtime exists.
- The Chrome package is built and store-ready, but the production extension ID
  and Chrome Web Store publisher submission remain external actions.

## 8. Validation evidence

Evidence is append-only. If a later change invalidates evidence, record a new
result instead of editing the old result.

| Date | Scope | Command | Result |
| --- | --- | --- | --- |
| 2026-08-19 | Managed-BYOC packages | `npm run check:managed-byoc` | PASS: 5 contract tests, 8 control-plane tests, generated types current, strict typecheck, control-plane dry-run bundle |
| 2026-08-19 | Existing Worker | `npm run check` | PASS: lint, types, function docs, 68 Worker tests, 24 web/extension tests |
| 2026-08-19 | Existing production bundle | `npm run build` | PASS: Wrangler dry run only; no deployment |
| 2026-08-19 | Diff integrity | `git diff --check` | PASS |
| 2026-08-19 | Moved runtime compatibility | `npm run check` | PASS: generated types, strict runtime/web types, 454 documented functions across 67 source files, lint, 68 Worker tests, and 24 web/extension tests |
| 2026-08-19 | Moved runtime bundle | `npm run build` | PASS: same 13 functional bindings reported; content-hashed assets `app.U62XD5YM.css` and `main.OVYSKMVO.js`; Wrangler dry run only |
| 2026-08-19 | Managed-BYOC packages after move | `npm run check:managed-byoc` | PASS: 5 contract tests, 8 control-plane tests, generated types, strict typecheck, and control-plane dry-run bundle |
| 2026-08-19 | Generated web determinism | two consecutive `npm run build:web` snapshots | PASS: all 20 generated files had identical SHA-256 snapshots |
| 2026-08-19 | Post-move diff integrity | `git diff --check` | PASS |
| 2026-08-20 | Chrome-extension workspace | `npm run check --workspace @later-gator/chrome-extension` | PASS: strict typecheck and 11 extension DOM tests |
| 2026-08-20 | Full compatibility after extension move | `npm run check` | PASS: generated types, runtime/web/extension strict types, 454 documented functions across 67 source files, lint, 68 Worker tests, 13 dashboard tests, and 11 extension tests |
| 2026-08-20 | Extension generation parity | two consecutive `npm run build:extensions` snapshots plus pre-move comparison | PASS: 20 generated Chrome/Firefox files were deterministic with aggregate SHA-256 `8697bcce1b578c64ad2b73d67873ab1e243d15095ca33af63b2dc292899b6dc3`; every canonical source and generated-file hash matched the pre-move baseline |
| 2026-08-20 | Runtime bundle after extension move | `npm run build` | PASS: stable web asset hashes and the same 13 functional bindings; Wrangler dry run only |
| 2026-08-20 | Managed-BYOC packages after extension move | `npm run check:managed-byoc` | PASS: 5 contract tests, 8 control-plane tests, generated types, strict typecheck, and control-plane dry-run bundle |
| 2026-08-20 | Extension-move diff integrity | `git diff --check` | PASS |
| 2026-08-20 | Generated-output source cleanup | absent-output regeneration plus `npm run check`, `npm run build`, and `npm run check:managed-byoc` | PASS: exact 20-file baseline regeneration, 68 Worker tests, 13 dashboard tests, 11 extension tests, 5 contract tests, 8 control-plane tests, and both Worker dry-run bundles |
| 2026-08-20 | Chrome-only transition | Worker, browser, route, settings, and deterministic-generation checks | PASS: 68 Worker tests, 13 dashboard tests, 11 extension tests, removed Firefox route/action, and identical 10-file Chrome aggregate SHA-256 `c26c2472c1d8d6aa83a35d0578a4e293018e9400f33aa3240f9285cba6dd5fdb` |
| 2026-08-20 | Final Phase 1 workspace gate | `npm run check`, `npm run build`, `npm run check:managed-byoc`, two web snapshots, and `git diff --check` | PASS: 68 Worker, 13 dashboard, 11 extension, 5 contract, and 8 control-plane tests; both Worker dry-run bundles; 454 documented functions; identical 20-file web aggregate SHA-256 `fc92506709655aae1a35e0df0cb4b81bce336c8325a90e66129e04121665588e` |
| 2026-08-20 | Phase 0 OAuth inventory and local Phase 2 identity completion | official Cloudflare discovery/scope/API review, `npm run check:managed-byoc`, `npm run check`, `npm run build`, `npm run build:development --workspace @later-gator/control-plane`, and `git diff --check` | PASS: exact three-client OAuth boundary and least-privilege installer scopes recorded; 5 contract, 13 control-plane, 68 Worker, 13 dashboard, and 11 Chrome-extension tests; 462 documented functions across 68 source files; runtime plus production/development control-plane dry-run bundles; no deployment |
| 2026-08-20 | Live Phase 2 identity acceptance | interactive private OAuth authorization, authenticated dashboard inspection, and read-only Wrangler D1 count/schema queries | PASS: the owner returned to `Cloudflare account connected`; one owner record exists; the live schema stores only subject hash, opaque session/CSRF hashes, bounded login state, timestamps, and safe event codes; no OAuth token or Cloudflare profile field exists |
| 2026-08-20 | Phase 3 runtime identity and credential vault | `npm run check`, `npm run build`, `npm run check:managed-byoc`, focused owner-auth/credential/MCP tests, leak grep, and `git diff --check` | PASS: 74 Worker, 13 dashboard, 11 Chrome-extension, 5 contract, and 14 control-plane tests; 453 documented functions; runtime and control-plane dry-run bundles; assertion replay/rotation/owner binding and single AEAD credential storage verified; no deployment |
| 2026-08-20 | Local Phase 4 authorization foundation | `npm run check`, control-plane strict type/lint checks, `npx vitest run`, control-plane Wrangler dry run, and `git diff --check` | PASS: 74 Worker, 13 dashboard, 11 Chrome-extension, and 18 control-plane tests; 475 documented functions; purpose-specific KV/R2 scopes, account/owner binding, callback replay rejection, encrypted refresh-token storage, immutable installation plan, and dry-run bundle verified; no deployment |
| 2026-08-21 | Phases 4–8 local completion | `npm run check:managed-byoc`, `npm run check`, focused provisioning/cleanup/update tests, Chrome packaging, and `git diff --check` | PASS: 5 contract, 31 control-plane, 88 runtime, 14 web, and 12 Chrome tests; 610 documented functions across 89 source files; strict types, lint, runtime/control-plane dry-run bundles, immutable release generation, signed catalogs, thumbnail resilience/migration, extension pairing, compensating cleanup, staged update, rollback, revocation, interruption, and cohort-pause coverage |
| 2026-08-21 | Development release deployment | remote schema inspection, additive D1 migration, development Worker deployment, public health, signed-manifest fetch, and read-only schema/resource count verification | PASS: 11 additive queries applied; Worker version `17cf01a4-f158-41e2-8b7f-f236dac14234` healthy with 23 immutable release files and a valid public signed `1.0.0` manifest; four managed-release tables present; zero personal installations and no personal Cloudflare resources created |
| 2026-08-21 | Phase 4–8 completion audit and live-control repair | current Cloudflare API review, `npm run check:managed-byoc`, `npm run check`, `npm run build`, Chrome packaging, focused fault-injection tests, remote D1 schema reconciliation, dev deployment, and aggregate-only remote counts | PASS: initial upload now requires Cloudflare's real normalized Worker version ID; fresh installs record release/migration ledgers and a Time Travel bookmark; KV/R2 provisioning and provider-outage resume pass; candidate health, schema/deployment interruption, artifact outage, revocation, destructive migration refusal, rollback, stale session/CSRF recovery, null-Origin fetch metadata, Cloudflare-only CSP navigation, and bounded discovery retry paths pass; 5 contract, 44 control-plane, 88 runtime, 14 web, and 12 Chrome tests; 614 documented functions; dev Worker `9f1850e7-02a5-4a9e-a2c4-01a61fe1c81c`; current 15-table control schema; zero installations, resources, and installer authorizations |
| 2026-08-21 | Live KV installer authorization | exact-scope consent plus aggregate-only remote D1 inspection | PASS: one active encrypted installer authorization contains the expected KV provisioning scope set; one KV installation shell is `authorized`; all 12 resumable steps are pending with zero attempts and no safe error; zero personal resources exist |
| 2026-08-21 | Chrome host-permission ceiling | extension workspace check, package regeneration, packaged-manifest inspection, and `git diff --check` | PASS: 12 Chrome tests; the source and packaged manifests declare only `https://*.workers.dev/*` plus local development as optional hosts, while runtime pairing still requests the exact personal Worker origin |
| 2026-08-21 | Phase 5–6 named acceptance regressions | focused catalog/storage/UI tests followed by `npm run check`, `npm run build`, and `git diff --check` | PASS: network failure retains both last-valid signed catalogs and the local provider choice; unknown active and deprecated model states render correctly; repeated KV-to-R2 work remains idempotent and invokes no network path; 89 runtime, 15 web, and 12 Chrome tests; 617 documented functions; production bundle dry run |
| 2026-08-21 | Live D1 schema-application repair | read-only remote D1 inspection, current D1 API docs review, root `npm run lint`, control-plane `npm run check`, hardened `/query` fakes, and `deploy:development` | PASS: diagnosis confirmed `schema_initialize` failed 3× with `cloudflare_rejected` while all eight earlier steps were complete and the personal database contained zero tables; root cause was `applySchema` posting a bare JSON array, which the D1 query API rejects (it requires `{"batch": [...]}`); fix deployed as dev Worker `78cf914d-2a81-4290-8d58-f91542db9e07` with `/health` 200; 45 control-plane tests pass with fakes that now reject malformed query bodies |
| 2026-08-21 | First-provisioning health retry | live retry evidence, direct runtime `/health` probe, new bounded-retry regression tests, control-plane `npm run check` plus root lint, and `deploy:development` | PASS: after the batch repair the owner retry advanced through `schema_initialize`, `queue_consumers`, and `workers_dev`; only `health_check` paused with `cloudflare_unavailable` because a brand-new workers.dev origin did not answer immediately; a direct probe of the personal runtime returned HTTP 200 `ready`; provisioning now retries health up to five attempts six seconds apart with an injectable sleep; two new regressions cover propagation recovery and bounded exhaustion; dev Worker `06029922-2b4d-4ad7-87e5-b90322221e94` healthy at 100% |
| 2026-08-21 | Multipart upload version-ID repair | live D1 step inspection, Cloudflare plugin docs/API verification, current Wrangler source comparison, focused provisioning test, `npm run check:managed-byoc`, root lint, dry-run bundles, development deployment, and public health | PASS: fresh provisioning proved the multipart upload succeeded but `worker_upload` failed during an invalid deployment-detail lookup; Cloudflare's legacy `deployment_id` response value is the Worker version ID; the direct value is now validated, normalized, and recorded without a detail lookup; 5 contract and 49 control-plane tests pass; dev Worker `2a869029-08eb-48d1-b916-29df0d7258d4` is active and `/health` returns 200 `ready` |

Known environment notes:

- The machine reported Node `24.3.0`, below the repository's declared
  `>=24.11.0`, although the recorded checks passed.
- The installed Workers test runtime supports compatibility dates through
  `2026-07-29`; the control-plane production config uses `2026-08-19` and its
  test config is explicitly pinned to the supported test date.
- Wrangler reported a newer available release than the repository's pinned
  `4.114.0`; dependency upgrades must be deliberate and independently tested.
- A production-only npm audit refresh was not completed because external
  transmission of dependency metadata was not authorized in that session.
- The lockfile-only workspace refresh repeated the Node engine warning and
  reported 3 moderate and 4 high dependency advisories. No dependency version
  or audit fix was attempted during the behavior-preserving move.
- Sandbox-only test attempts could not reliably open the Workers test runtime's
  localhost socket. The same Worker and control-plane suites passed when local
  test sockets were permitted. The runtime test harness read existing
  Cloudflare account metadata for its configured remote binding; it did not
  deploy or create a resource.
- The post-move Worker suite exited successfully but Vitest reported a
  ten-second close timeout before the dashboard and extension suites ran and
  passed. This is recorded as an existing test-runner shutdown warning, not a
  failed assertion or product behavior change.

## 9. External actions and real blockers

The following do not block local implementation. They block only the named live
acceptance step:

| External action | Needed for | Owner handling |
| --- | --- | --- |
| Save the installer callback and refresh capability on `Later Gator Dev` | Live Phase 4 provisioning and later managed updates | Keep the existing confidential client, exact development installer callback, and Refresh Token grant. Cloudflare protocol-manages `offline_access`; do not add `openid` or substitute `account-settings.read` for the nonexistent `account.read` scope |
| Start the authorized KV provisioning job | Disposable installation acceptance | Click **Create my Later Gator** on the authenticated dashboard; duplicate submissions are idempotent |
| Activate R2/billing profile | Live R2 acceptance | Optional until KV milestone passes |
| Supply OpenAI/Anthropic test keys | Final provider acceptance | Enter only into personal test runtime |
| Verify `latergator.app` publisher domain and promote OAuth clients | Public launch | Do only after private acceptance; never as a development shortcut |
| Chrome Web Store developer access | Store submission | Not needed for local extension work |

Phases 2, 3, 5, and 6 are complete. Phases 4, 7, and 8 are implemented and
locally verified; their remaining exit gates require owner consent, disposable
personal-runtime acceptance, and Chrome Web Store access. No further local
implementation is waiting on the installer token contract.

## 10. Next-session queue

### Active session objective: disposable `P4.9` KV provisioning acceptance

Advance the authorized installation through its resumable resource job, then
exercise the disposable KV runtime and managed update.

Required order:

1. Owner clicks **Create my Later Gator** on the authenticated dashboard.
2. Use the implemented resumable state machine to create the disposable KV
   personal installation and verify owner assertion, bookmark capture, privacy
   boundary, update, failure recovery, and explicit uninstall cleanup.
3. Repeat the storage acceptance with R2 only if the owner activates R2.

## 11. Session protocol

### At session start

1. Read this file completely.
2. Read the relevant sections of the PRD, structural plan, implementation plan,
   and canonical current specifications.
3. Inspect the current branch and dirty working tree.
4. Verify the active task has no unresolved decision that would change the trust
   boundary or product behavior.
5. Append a session entry marked `IN PROGRESS` before code changes.
6. Use current Cloudflare documentation/types/config schema for drift-prone
   platform details.

### During the session

- Keep one active task.
- Preserve current behavior unless the active phase explicitly supersedes it.
- Add a regression test with every behavior change.
- Validate every external, OAuth, stored, catalog, release, and migration input.
- Keep request state local and await, return, or schedule every promise.
- Never log bookmark data, provider secrets, tokens, remote bodies, or MCP paths.
- Record a newly discovered product decision or blocker immediately.

### At session end

1. Run checks proportional to the change and the full phase gate when closing a
   phase.
2. Update the phase checklist and active task.
3. Record exact commands, test counts, dry-run/deployment state, and failures.
4. Append the completed session handoff below.
5. Leave one exact next task or a concrete blocker requiring user action.
6. Never describe unverified work as complete.

## 12. Session log

Do not rewrite prior entries except to correct a factual error. Add a new entry
for every managed-BYOC coding session.

### `S001` — 2026-08-19 — Foundation contracts and control-plane identity shell

**Status:** COMPLETE  
**Scope:** additive foundation; no current-runtime behavior change  
**Files:** root workspace configuration, `packages/contracts`,
`apps/control-plane`, and managed-BYOC planning documents

Completed:

- registered npm workspaces;
- created strict shared cross-component contracts;
- created the control-plane Worker and privacy-bounded D1 schema;
- implemented identity-only OIDC, PKCE, RS256 validation, opaque sessions, CSRF,
  safe pages, and safe logs; and
- documented control-plane development setup.

Validation:

- `npm run check:managed-byoc` passed;
- `npm run check` passed with 68 Worker and 24 web/extension tests; and
- `npm run build` passed as a dry run.

No deployment or Cloudflare resource creation occurred.

Handoff: create an authoritative tracker before further staged work, then return
to Phase 1 structural conversion before changing runtime authentication.

### `S002` — 2026-08-19 — Authoritative execution tracker

**Status:** COMPLETE  
**Scope:** documentation and cross-session continuation contract only  
**Files:** `AGENTS.md`, `planning/managed-byoc/implementation-plan.md`, and this
tracker

Completed:

- established this file as the sole progress and TODO ledger;
- mapped every implementation-plan phase into stable task IDs;
- recorded the dirty-worktree safety contract, existing implementation, test
  evidence, external gates, and exact next task;
- linked repository instructions to this tracker; and
- removed duplicated live status from the static implementation plan.

Validation:

- `git diff --check` passed;
- tracker links from `AGENTS.md` and the static implementation plan were
  confirmed; and
- exactly one active next task (`P1.2`) is recorded.

Handoff: execute `P1.2` only—move the current runtime into `apps/runtime`
without behavior changes—then update this tracker.

### `S003` — 2026-08-19 — Runtime workspace relocation

**Status:** COMPLETE  
**Scope:** `P1.2` behavior-preserving structural move only

Planned ownership and transitional command map:

- move `src`, `web`, `test`, `schema.sql`, both runtime Wrangler files,
  generated Worker types, TypeScript/Vitest configuration, and runtime local
  variables into `apps/runtime`;
- retain `extension/shared`, generated browser folders, and the extension build
  script at the repository root until `P1.3`;
- retain monorepo-wide lint and function-documentation ownership at the root;
- make the existing root `build`, `dev`, database, type, Worker-test, web-test,
  and deploy command names delegate to `@later-gator/runtime`;
- keep `build:extensions`, `check:function-docs`, `lint`, and
  `check:managed-byoc` root-owned; and
- keep root Deploy-to-Cloudflare binding metadata during this transitional
  phase while the runtime package owns its production dependencies.

No product behavior, authentication, binding set, schema content, or remote
Cloudflare resource is authorized to change in this session.

Completed:

- created `@later-gator/runtime` and moved the complete current Worker, schema,
  dashboard, Worker/browser tests, generated Worker types, runtime
  configuration, and ignored local runtime variables into it;
- preserved the in-progress X destination-review source, schema, routes, UI,
  redacted diagnostics, and regression tests inside the moved runtime;
- kept all existing root command names and Deploy-to-Cloudflare binding metadata
  while delegating runtime commands to the workspace;
- made root build scripts independent of the caller's working directory and
  updated extension-test imports mechanically;
- moved production dependency ownership to the runtime package and refreshed
  the workspace lockfile without changing dependency versions; and
- updated repository and canonical developer/technical path documentation.

Validation:

- `npm run check` passed with 68 Worker and 24 web/extension tests;
- `npm run check:managed-byoc` passed with 5 contract and 8 control-plane tests;
- `npm run build` produced a successful runtime dry-run bundle with the same 13
  functional bindings;
- two consecutive web builds produced identical 20-file SHA-256 snapshots and
  stable content-hashed CSS/JS names; and
- `git diff --check` passed.

The existing ignored root `.wrangler` and `dist` directories were left intact
as disposable pre-move build state. No deployment, schema initialization,
Cloudflare resource creation, commit, stash, or destructive cleanup occurred.

Handoff: execute `P1.3` only—move the canonical extension source into
`apps/chrome-extension` without changing current Chrome or X-link behavior.

### `S004` — 2026-08-20 — Canonical Chrome-extension workspace relocation

**Status:** COMPLETE  
**Scope:** `P1.3` behavior-preserving extension-source move only

Planned ownership and transitional output map:

- move canonical extension JavaScript, HTML, and CSS from `extension/shared`
  to `apps/chrome-extension/src`;
- move canonical icons to `apps/chrome-extension/assets/icons` and the Chrome
  manifest template to `apps/chrome-extension/manifest.json`;
- move the two extension-specific DOM suites and their raw-asset declaration to
  `apps/chrome-extension/test` with package-local TypeScript/Vitest config;
- retain `extension/firefox`, `extension/chrome`, and the Firefox manifest under
  `extension/manifests` until `P1.4` and `P1.5`;
- keep the existing generated install-folder paths and root
  `npm run build:extensions` command stable; and
- preserve all permissions, connection-code pairing, capture payloads,
  individual X-link selection, duplicate confirmation, Go back, and Cancel
  behavior without modification.

No authentication, extension permission, capture contract, runtime behavior,
or remote Cloudflare state is authorized to change in this session.

Completed:

- created the real `@later-gator/chrome-extension` workspace with canonical
  source under `src`, icons under `assets/icons`, and the Chrome manifest at the
  package root;
- moved the two extension-specific DOM suites and raw-asset typing into the
  extension package while retaining the runtime connection-code helper import;
- retained the transitional Firefox manifest and both generated install-folder
  paths;
- updated the generator, function-documentation scan, lint/type/test routing,
  workspace lockfile, repository guidance, and canonical developer/technical
  path documentation;
- preserved the root `npm run build:extensions` command and the combined 24
  browser-side regression tests; and
- confirmed every moved source, icon, manifest, and generated output hash
  matched its pre-move value.

Validation:

- `npm run check --workspace @later-gator/chrome-extension` passed strict
  typecheck and 11 extension tests;
- `npm run check` passed with 68 Worker, 13 dashboard, and 11 extension tests;
- `npm run check:managed-byoc` passed with 5 contract and 8 control-plane tests;
- `npm run build` produced the same web hashes and 13-binding runtime dry run;
- two consecutive extension builds produced the same 20-file aggregate SHA-256
  snapshot and matched the captured pre-move hashes; and
- `git diff --check` passed.

No deployment, resource creation, schema initialization, commit, stash, or
destructive cleanup occurred. The generated Chrome/Firefox folders remain for
the separately bounded `P1.4` source-ownership cleanup.

Handoff: execute `P1.4` only—remove generated browser copies from source
ownership while retaining exact, deterministic transitional regeneration.

### `S005` — 2026-08-20 — Generated extension source-ownership cleanup

**Status:** COMPLETE  
**Scope:** `P1.4` generated-output cleanup only

Recoverable build-output contract:

- `apps/chrome-extension/src`, `assets/icons`, and `manifest.json` are the
  canonical Chrome inputs;
- `extension/manifests/firefox.json` remains the transitional Firefox-only
  input through `P1.5`;
- `extension/chrome` and `extension/firefox` are disposable ignored build
  outputs, never editable source;
- `npm run build:extensions` must recreate both output trees byte-for-byte from
  an absent-output checkout; and
- the session will remove both output trees again after validation so the
  working tree represents their eventual source-control deletion.

No manifest, permission, pairing, capture, X-link, or browser behavior is
authorized to change in this session.

Completed:

- proved both generated output trees can be recreated from an absent-output
  checkout with the recorded 20-file aggregate hash;
- removed `extension/chrome` and `extension/firefox` from the final working tree
  so their tracked deletions represent the eventual source-control cleanup; and
- retained canonical inputs, ignore rules, the generator, and locally loadable
  output creation for both browsers through the next stage.

Validation:

- clean regeneration matched aggregate SHA-256
  `8697bcce1b578c64ad2b73d67873ab1e243d15095ca33af63b2dc292899b6dc3`;
- `npm run check` passed with 68 Worker, 13 dashboard, and 11 extension tests;
- `npm run build` preserved the 13-binding runtime dry run; and
- `npm run check:managed-byoc` passed 5 contract and 8 control-plane tests plus
  the control-plane dry-run bundle.

The generated folders were removed again after validation. They are recoverable
with `npm run build:extensions`; no user-authored data was deleted.

Handoff: execute `P1.5` only—remove Firefox from the initial managed release
without changing Chrome behavior.

### `S006` — 2026-08-20 — Chrome-only initial extension release

**Status:** COMPLETE  
**Scope:** `P1.5` intentional Firefox removal only

The Chrome workspace, permissions, build output, tests, pairing, capture, and
X-link behavior remain the compatibility contract. Firefox-specific manifest,
generation, setup UI, route, docs, and ignored output are the only authorized
removals.

Completed:

- removed the transitional Firefox manifest, generator branch, ignored output,
  setup action, how-to content, installation route, and current documentation;
- retained Chrome and iOS capture guidance and all Chrome permissions, pairing,
  capture, duplicate, relationship, and X-link selection behavior;
- added regression assertions proving Chrome setup remains available while the
  Firefox settings action and `/extension/firefox` route are absent; and
- reduced generated extension output to the canonical ten-file Chrome package.

Validation:

- `npm test` passed 68 Worker tests;
- `npm run test:web` passed 13 dashboard and 11 Chrome-extension tests;
- `npm run check --workspace @later-gator/chrome-extension` passed strict types
  and 11 extension tests;
- two consecutive Chrome generations produced the identical aggregate SHA-256
  `c26c2472c1d8d6aa83a35d0578a4e293018e9400f33aa3240f9285cba6dd5fdb`;
  and
- `git diff --check` passed.

No deployment, resource creation, schema initialization, commit, or stash
occurred.

Handoff: execute `P1.7` only—finalize root command ownership—then run the Phase
1 parity gate.

### `S007` — 2026-08-20 — Final workspace command ownership

**Status:** COMPLETE  
**Scope:** `P1.7` command rewiring and `P1.8` parity validation only

Runtime web generation, Chrome packaging, shared repository checks, and each
Worker dry-run bundle must remain independently runnable. No product behavior,
authentication, provisioning, or remote Cloudflare state is authorized to
change.

Completed:

- removed Chrome package generation from the runtime package's web lifecycle;
- made the root compatibility gate explicitly generate Chrome and dashboard
  assets before type, documentation, lint, and test gates;
- preserved the existing root command names and kept deploy/database commands
  outside validation; and
- removed the generated Chrome folder again after proving it is reproducible.

Validation:

- `npm run check` exited zero with 68 Worker, 13 dashboard, and 11 extension
  tests plus types, lint, and 454 documented functions across 67 source files;
- `npm run check:managed-byoc` passed 5 contract and 8 control-plane tests plus
  generated types, strict types, and the control-plane dry-run bundle;
- `npm run build` passed as a runtime Wrangler dry run with the same 13
  functional bindings;
- two consecutive dashboard builds produced stable asset names and aggregate
  SHA-256 `fc92506709655aae1a35e0df0cb4b81bce336c8325a90e66129e04121665588e`;
  and
- `git diff --check` passed.

No deployment, resource creation, schema initialization, commit, or stash
occurred. The generated Chrome directory was removed and remains recoverable
with `npm run build:extensions`.

Handoff: execute `P0.6` and `P0.7` from current official Cloudflare OAuth and
API-permission documentation before expanding the identity shell.

### `S008` — 2026-08-20 — Cloudflare OAuth capability and permission inventory

**Status:** COMPLETE  
**Scope:** `P0.6` and `P0.7`; current official platform review and architecture
boundary only

Completed:

- verified Cloudflare's self-managed OAuth/OIDC discovery, stable subject,
  Authorization Code, PKCE S256, confidential-client, and public-client
  capabilities;
- refined the architecture to three clients: confidential control-plane
  identity, confidential installer authorization, and public PKCE Chrome
  identity;
- queried the authenticated OAuth scope catalog without printing or persisting
  the current token;
- mapped the minimum installer permissions to D1, KV, Vectorize, Worker script,
  Queue, and optional R2 operations; and
- recorded exact development/public callbacks and the deferred Chrome redirect
  dependency in `cloudflare-oauth-inventory.md`.

The initial installer request excludes optional R2 and dedicated Queue scope.
R2 is incremental; official Queue API authorization also accepts Workers
Scripts Write and must be verified against a disposable installation before
launch.

No OAuth client, Worker, storage resource, secret, or deployment was created.

Handoff: finish the remaining local Phase 2 signing, deletion, and adversarial
identity tests before requesting private-client live acceptance.

### `S009` — 2026-08-20 — Local Phase 2 identity-shell completion

**Status:** COMPLETE  
**Scope:** `P2.5`, `P2.7`, and `P2.8`; no live Cloudflare mutation

Completed:

- hardened owner-assertion contracts to a five-minute maximum lifetime and an
  audience exactly matching the installation;
- added a bounded ES256 P-256 signing-key ring, active/retained rotation
  invariants, 120-second installation-bound assertions, and a public
  verification-only JWKS endpoint;
- added authenticated, same-session CSRF-protected deletion of all
  control-plane identity metadata;
- consolidated logout and deletion through one session/CSRF authorization rule;
- removed an avoidable Web Crypto double cast while documenting the Workers
  JWK type-library gap;
- added issuer, audience, expiry, provider failure, key rotation, signing,
  deletion, and log-redaction regression coverage; and
- corrected the control-plane operator guide for HTTPS development acceptance,
  the three production secrets, offline key generation, and the authoritative
  OAuth inventory; and
- added an isolated `later-gator-control-plane-dev` Wrangler configuration and
  explicit remote-mutation commands that are excluded from validation.

Validation:

- `npm run check:managed-byoc` passed with 5 contract and 13 control-plane
  tests, current generated bindings, strict types, and a control-plane dry-run
  bundle;
- `npm run check` passed with 68 Worker, 13 dashboard, and 11 Chrome-extension
  tests plus strict types, lint, and 462 documented functions across 68 source
  files;
- `npm run build` passed as a runtime Wrangler dry run with the same 13
  functional bindings; and
- `npm run build:development --workspace @later-gator/control-plane` passed as
  an isolated development control-plane dry run; and
- `git diff --check` passed.

The compatibility gate regenerated `extension/chrome`; the disposable folder
was removed afterward and remains recoverable with
`npm run build:extensions`. No deployment, D1 creation, OAuth client creation,
secret entry, schema initialization, commit, or stash occurred.

Handoff: the next safe gate is `P2.2` plus `P2.9`. It requires owner-authorized
remote resource creation/deployment, private secret entry, and an interactive
Cloudflare sign-in; do not begin destructive runtime-authentication replacement
until live identity acceptance passes.

### `S010` — 2026-08-20 — Development control-plane D1 creation

**Status:** COMPLETE  
**Scope:** owner-authorized development D1 creation and schema initialization;
no Worker deployment

Completed:

- confirmed the connected test account contained no existing D1 databases;
- created `later-gator-control-plane-dev` with an APAC placement hint;
- recorded database ID `a425eda6-2120-4d7a-82eb-f0b2d1b8bb61` in
  `apps/control-plane/wrangler.dev.jsonc` under binding `CONTROL_DB`;
- applied the canonical control-plane schema remotely; and
- verified the `owners`, `oauth_login_requests`, `control_sessions`, and
  `control_audit_events` tables with a read-only query.

Remote evidence:

- schema import processed 8 queries successfully;
- the database reported region APAC and serving colo SIN;
- the verification query wrote zero rows; and
- no Worker, KV namespace, R2 bucket, Vectorize index, Queue, or personal runtime
  resource was created or changed.

The owner also created a private `Later Gator Dev` OAuth client showing six
scopes in the dashboard. Exact stored scope IDs remain unverified because the
current Wrangler OAuth token lacks OAuth Client Read and the read-only API call
returned 403; the client secret was never requested or exposed to Codex.

Handoff: verify the six scopes through the dashboard, then obtain explicit
authorization for development Worker deployment and complete secure secret
entry plus live sign-in acceptance.

### `S011` — 2026-08-20 — Development control-plane deployment

**Status:** COMPLETE  
**Scope:** owner-authorized first deployment and public endpoint verification;
no personal runtime or personal storage resource mutation

Completed:

- verified the OAuth client scope list from the owner's dashboard screenshot:
  `d1.write`, `vectorize.write`, `workers-scripts.edit`,
  `workers-kv-storage.write`, `workers-r2.write`, and
  `workers-scripts.write`;
- identified `workers-scripts.edit` as an unnecessary extra scope to remove
  before live authorization while retaining `workers-scripts.write`;
- deployed `later-gator-control-plane-dev` at
  `https://later-gator-control-plane-dev.vishvak-v.workers.dev`;
- activated Worker version `d0895f90-bd9d-45af-a686-7f4c59ff58f4` with the
  initialized `CONTROL_DB` binding;
- generated a real P-256 owner-assertion signing key offline, supplied it only
  through Wrangler's first-deployment secrets file, and deleted the temporary
  file immediately; and
- bootstrapped the two OAuth secrets with deliberately inactive placeholder
  values so the owner can replace them in Cloudflare without exposing the
  saved client credentials to Codex or chat.

Validation:

- `git diff --check` passed;
- the development dry run completed with a 591.82 KiB upload and 90.22 KiB
  gzip size;
- Wrangler's deployment ledger reports version
  `d0895f90-bd9d-45af-a686-7f4c59ff58f4` at 100%;
- `GET /health` returned HTTP 200 with control-plane status `ready`; and
- `GET /.well-known/later-gator-jwks.json` returned HTTP 200 with one ES256
  public key and no private `d` material.

No KV namespace, R2 bucket, Vectorize index, Queue, or personal runtime was
created or changed by this deployment.

Handoff: in the `Later Gator Dev` OAuth client remove only Workers Editor
(`workers-scripts.edit`). In the development Worker's encrypted secrets,
replace `CLOUDFLARE_IDENTITY_CLIENT_ID` and
`CLOUDFLARE_IDENTITY_CLIENT_SECRET` with the saved real values. Then complete
the live Cloudflare sign-in acceptance for `P2.9`.

### `S012` — 2026-08-20 — Live OAuth compatibility correction

**Status:** PARTIAL; owner scope edit required  
**Scope:** real-secret verification, live authorization acceptance, redacted
diagnostics, and supported Cloudflare identity-flow correction

Completed:

- confirmed the owner's dashboard secret update created active Worker version
  `aa313429-d68f-45ee-8828-87bbcd6fd555` with all three required secret names;
- found and fixed a Workers-runtime incompatibility where
  `fetch(..., { redirect: "error" })` throws before reading Cloudflare's valid
  discovery response; `manual` now prevents following redirects and every
  non-success response remains rejected;
- added fixed, privacy-safe failure-stage codes for discovery, state generation,
  and D1 state storage without logging tokens, callback details, or profiles;
- completed a real browser authorization attempt and recorded Cloudflare's
  definitive `invalid_scope` response: the private client is not allowed to
  request `openid`;
- queried Cloudflare's authenticated read-only scope catalog without printing
  or persisting the Wrangler token and confirmed `user-details.read` as the
  `User Details Read` scope ID;
- replaced the unsupported OIDC ID-token path with Authorization Code plus
  `user-details.read`, bounded `GET /client/v4/user`, stable user-ID extraction,
  immediate access-token/profile discard, and one-way subject hashing;
- removed obsolete login nonce storage from the canonical and remote
  development schema after proving the database had zero owners and sessions;
- deleted the two disposable rejected OAuth-attempt rows; and
- deployed development version `d968fc9d-a736-48ba-b16f-cbc277426ef7`.

Validation:

- Cloudflare discovery succeeded from a temporary Workers-edge probe with
  `redirect: "manual"` and failed with `redirect: "error"`; the probe contained
  no Later Gator secrets and was stopped and removed afterward;
- `npm run check:managed-byoc` passed with 5 contract and 14 control-plane tests,
  strict types, current generated bindings, and a dry-run bundle;
- the live Worker now returns HTTP 302 to `https://dash.cloudflare.com`, requests
  exactly `user-details.read`, uses Authorization Code plus S256 PKCE and state,
  and sends no OIDC nonce; and
- the revised remote `oauth_login_requests` table matches the canonical schema.

No OAuth consent completed, Cloudflare access token was retained, owner/session
row was created, or personal resource was provisioned.

Handoff: edit `Later Gator Dev` and add **User Details Read**
(`user-details.read`). Remove **Workers Editor** (`workers-scripts.edit`) if it
is still selected, but retain **Workers Scripts Write**
(`workers-scripts.write`). Then retry the visible sign-in page and complete
`P2.9` acceptance.

### `S013` — 2026-08-20 — Runtime identity and instance credential vault

**Status:** COMPLETE  
**Scope:** `P3.1` through `P3.9`; supersede only the runtime password boundary
while preserving bookmark, setup, provider, Queue, capture, MCP, and X-review
behavior

Phase 2 entry evidence:

- the owner corrected `Later Gator Dev` to the six intended stored scopes;
- the identity request displayed only `User Details Read` and completed;
- the returned page displayed `Cloudflare account connected` and the empty
  personal-installation state;
- read-only remote D1 queries reported one owner, two current/previous session
  rows, two safe audit events, and zero writes; and
- live table columns contain no OAuth token, email, name, membership, or other
  Cloudflare profile field.

Authorized Phase 3 changes:

- add signed owner-assertion callback, owner binding, one-time assertion
  consumption, and ordinary runtime sessions;
- remove password login, throttling, password-derived key wrapping, and
  password fallback from the fresh runtime;
- add `INSTANCE_MASTER_KEY` and one AEAD provider-credential envelope; and
- require an authenticated owner session for MCP approval.

No personal runtime deployment, personal resource creation, control-plane
deployment, destructive cleanup, commit, or stash is authorized in this
session. Validation uses local Worker fixtures and dry-run bundles only.

Completed:

- replaced password login with installation-bound Cloudflare owner assertions;
- added hashed login state/nonce, strict ES256 verification, rotation support,
  one-time JTI consumption, and one-owner binding;
- replaced password-bearing sessions with ordinary hashed session and CSRF
  credentials;
- removed password UI, routes, fallback, throttling, schema, and password-derived
  credential wrapping;
- added the per-installation `INSTANCE_MASTER_KEY` boundary and one versioned,
  provider-bound AES-GCM ciphertext representation in personal D1;
- required an existing authenticated owner session plus CSRF for MCP approval;
  and
- reconciled the planning documents to the accepted two-client design: one
  confidential control-plane client with separate request subsets and one later
  public Chrome PKCE client.

Validation:

- focused owner-assertion, credential-vault, MCP, and Worker tests passed;
- `npm run check` passed with 74 Worker, 13 dashboard, and 11 Chrome-extension
  tests plus strict types, lint, and 453 documented functions;
- `npm run check:managed-byoc` passed with 5 contract and 14 control-plane tests;
- `npm run build` passed as a runtime Wrangler dry run;
- both control-plane and runtime generated bindings were current; and
- the leak grep and `git diff --check` passed.

The first chained dry-run attempt encountered sandbox-only Wrangler log/socket
`EPERM`; the runtime dry run still completed, and both affected gates then
passed cleanly with the required local permissions. No deployment occurred.

Handoff: begin local Phase 4 installer authorization and resumable provisioning;
stop before any OAuth-client edit, consent, remote resource creation, secret
entry, or deployment.

### `S014` — 2026-08-20 — Local OAuth provisioning foundation

**Status:** PARTIAL; exact OAuth-client edit and live contract acceptance required  
**Scope:** `P4.1` through `P4.8` local implementation and mock validation only

Authorized work:

- add separate installer authorization state/callback behavior using the
  existing confidential client and purpose-specific scope subset;
- encrypt renewable installer authorization only in control-plane D1;
- add owner-visible KV/R2 choice and an immutable requested-resource plan;
- add validated Cloudflare API adapters, resumable provisioning steps,
  idempotency, health gating, and explicit cleanup planning; and
- add mock contract, replay, partial-failure, retry, and redaction tests.

No OAuth-client edit, interactive installer consent, remote personal resource,
runtime/control-plane deployment, destructive cleanup, commit, or stash is
authorized until the local boundary passes and the exact owner action is
recorded.

Completed locally:

- added a CSRF-protected KV/R2 decision before installer consent;
- added a separate installer state cookie, hashed one-time state, S256 PKCE,
  exact callback, immutable requested scopes, and same-owner callback binding;
- retained the minimum live-catalog product scopes and left account-ID
  resolution as a disposable-account acceptance check; the live catalog has no
  `account.read`, and the broader `account-settings.read` is not substituted;
- required exactly one selected account and rejected missing scopes, callback
  replay, and identity/installer owner mismatch;
- encrypted access and refresh credentials with a dedicated control-plane
  AES-GCM secret and owner/account-bound associated data before D1 persistence;
- added control-plane tables for installer requests, encrypted authorization,
  installations, and resumable provisioning steps without bookmark/provider
  fields; and
- added an immutable per-installation resource-step plan and owner-visible safe
  status rendering.

Validation:

- `npm run check` passed with 74 Worker, 13 dashboard, and 11 Chrome-extension
  tests plus lint, strict types, and 475 documented functions;
- `npx vitest run` passed all 18 control-plane tests, including four new
  installer/token-vault tests;
- the contract package retained its five passing tests;
- the control-plane Wrangler dry run passed at 607.92 KiB upload and 92.75 KiB
  gzip size; and
- `git diff --check` passed.

The aggregated managed-BYOC command hit the known sandbox-only Wrangler log and
localhost-socket `EPERM`; its individual contract, type, test, and dry-run
components all passed. No remote state changed.

External gate discovered from current official Cloudflare contracts:

1. edit the existing `Later Gator Dev` confidential client;
2. retain the six selected live-catalog scopes; there is no `account.read`, and
   `account-settings.read` must not be added as a substitute;
3. add `https://later-gator-control-plane-dev.vishvak-v.workers.dev/install/cloudflare/callback`
   as an additional redirect URI while retaining the identity callback;
4. add the **Refresh Token** grant while keeping Authorization Code, Code,
   `client_secret_post`, and S256 PKCE; and
5. do not add `openid`; Cloudflare manages `offline_access` from refresh support.

After the owner confirms that edit, the next authorized step is schema
application, secure `INSTALLER_TOKEN_ENCRYPTION_KEY` entry, development Worker
deployment, and interactive installer-consent acceptance. Remote resource
provisioning remains a separate explicit gate after the returned account/scope
contract is verified.

### `S015` — 2026-08-21 — Phases 4–8 completion run

**Status:** PARTIAL; owner/store acceptance remains  
**Scope:** complete Phases 4 through 8 and their recorded exit gates; stop before
Phase 9 canonical documentation and launch work

Authorized work:

- complete live installer authorization and disposable-account provisioning;
- implement thumbnail resilience and owner-approved KV-to-R2 migration;
- implement signed model and storage-plan catalog publication and consumption;
- implement Chrome identity, installation discovery, pairing, and packaging;
- implement immutable signed releases, schema evolution, cohort rollout, and
  compatible rollback; and
- deploy and mutate only the connected disposable test account as required by
  those acceptance gates.

Completed:

- implemented and tested the full resumable D1/KV-or-R2/Vectorize/Queue/Worker
  provisioning state machine, R2 pause, health gate, token rotation/revocation,
  and explicitly confirmed compensating cleanup;
- completed thumbnail resilience, disabled mode, reclaim, mixed reads, and
  owner-approved resumable KV-to-R2 migration inside the personal runtime;
- completed signed model/storage catalogs, last-valid caching, model dropdowns,
  deprecated-state handling, and local provider/secret ownership;
- completed Chrome Cloudflare pairing, exact host permission, narrow capture
  credential exchange, revocation/reconnect, UI regressions, and the packaged
  `later-gator-chrome-1.0.0.zip` artifact;
- completed immutable runtime artifacts, signed release manifests, compatible
  schema ledgers, D1 Time Travel recording, staged version health, atomic
  promotion, compatible rollback, cohort rollout, automatic pause, scheduled
  updates, and owner-visible safe history/authorization state; and
- applied the additive development control schema and deployed healthy Worker
  version `17cf01a4-f158-41e2-8b7f-f236dac14234` with immutable release assets.

Remaining external gates before Phase 9: accept the visible KV installer OAuth
consent and run the disposable personal-install/update drill; optionally enable
R2 for its live variant; provide Chrome Web Store publisher access and the
eventual extension ID. Phase 9 remains deliberately untouched.

### `S016` — 2026-08-21 — Phase 4–8 correctness and live-acceptance audit

**Status:** PARTIAL; owner identity and installer consent remain  
**Scope:** close local correctness and recovery gaps in Phases 4–8, repair the
disposable development control plane, and stop before Phase 9

Completed:

- replaced the initial Worker upload's unsafe script-name/release fallback with
  validation and normalization of Cloudflare's actual `deployment_id`;
- made fresh provisioning record the exact Worker version, promoted release
  history, ordered migration checksum, and D1 Time Travel bookmark;
- added continuous schema-chain planning and blocked unattended `migrate` or
  `contract` phases before any personal-account mutation;
- expanded KV and R2 provisioning coverage with R2 resume, partial provider
  outage retry, duplicate-creation prevention, and malformed upload-response
  rejection;
- expanded update coverage with pre-promotion health failure, interrupted
  schema/deployment retries, artifact outage recovery, incompatible-schema
  refusal, post-promotion rollback, and revoked authorization;
- extended immutable release digests to cover the signed descriptor and
  migration metadata, not only bundle bytes;
- added bounded, value-free configuration failure stages for Cloudflare logs;
- made the home route clear a mismatched session/CSRF cookie pair before it
  can render an actionable installation dashboard;
- accepted privacy-preserving `Origin: null` form submissions only when browser
  fetch metadata proves same-origin and the session-bound CSRF token matches;
- permitted form navigation to the exact Cloudflare OAuth origin in CSP and
  added a bounded retry for its validated public discovery document;
- reconciled the missing additive metadata/pairing tables in disposable
  control-plane D1 and deployed development Worker version
  `9f1850e7-02a5-4a9e-a2c4-01a61fe1c81c`; and
- confirmed by aggregate-only queries that installations, personal resources,
  and active installer authorizations all remain zero.

Validation:

- `npm run check:managed-byoc` passed 5 contract and 44 control-plane tests,
  generated types, strict typecheck, and the control-plane dry-run bundle;
- `npm run check` passed lint, strict runtime/web/Chrome types, 88 runtime, 14
  web, and 12 Chrome tests, with 614 documented functions across 89 files;
- `npm run build`, Chrome packaging, and `git diff --check` passed; and
- the repaired live dashboard renders the no-installation KV/R2 choice.

Owner-only handoff: the in-app browser is paused at the verified KV installer
consent. It requests exactly **D1 Write**, **Vectorize Write**, **Workers KV
Storage Write**, **Workers Scripts Write**, and **User Details Read**; it does
not request R2. The disposable install/update drill follows authorization;
Phase 9 remains untouched.

### `S017` — 2026-08-21 — Live KV installer authorization accepted

**Status:** PARTIAL; authorized provisioning job awaits explicit owner start  
**Scope:** verify the post-consent contract and preserve the Phase 4 trust
boundary before personal resources are created

Completed:

- confirmed the live development deployment still points entirely to Worker
  version `9f1850e7-02a5-4a9e-a2c4-01a61fe1c81c`;
- confirmed one active installer authorization is stored only as ciphertext and
  bounded metadata;
- confirmed the granted set is the expected KV installer set, including the
  protocol-managed refresh capability and no R2 permission;
- confirmed one KV installation shell is `authorized`, with all 12 resumable
  steps pending at zero attempts, no safe error, and zero personal resources;
- updated the live tracker header and next-session queue to remove the completed
  consent gate; and
- reran `git diff --check` before recording this handoff.

Owner-only handoff: click **Create my Later Gator** on the authenticated
dashboard. That explicit action starts the already-authorized idempotent
provisioning job. The agent will then inspect only safe step/resource metadata,
complete runtime and update acceptance, and stop before Phase 9.

### `S018` — 2026-08-21 — Chrome permission-ceiling hardening

**Status:** COMPLETE  
**Scope:** close a Phase 7 manifest-permission gap while live provisioning waits
at its explicit owner-action boundary

Completed:

- found that runtime pairing correctly requested one exact Worker origin but the
  Chrome manifest declared optional access to every HTTPS origin;
- narrowed the declaration to managed `workers.dev` origins plus local
  development, without granting either origin until the existing exact-origin
  runtime request succeeds;
- added a manifest regression that rejects the previous broad HTTPS pattern;
  and
- regenerated and inspected the store ZIP so its manifest matches the bounded
  source declaration.

Validation:

- extension strict typecheck and all 12 tests passed;
- `later-gator-chrome-1.0.0.zip` regenerated successfully;
- packaged `manifest.json` contains the bounded optional-host list; and
- `git diff --check` passed.

Handoff remains unchanged: the authorized KV provisioning job still requires
the owner to click **Create my Later Gator** before any personal Cloudflare
resource is created.

### `S019` — 2026-08-21 — Phase 5–6 named-test completion audit

**Status:** COMPLETE  
**Scope:** add direct evidence for named storage/catalog failure cases while
live provisioning remains owner-gated

Completed:

- added a public-catalog network-failure regression that retains both signed
  last-valid catalogs and proves local provider/model selection is unchanged;
- added UI coverage proving an active model missing from a newer catalog stays
  visible while a different deprecated model is clearly labeled and disabled;
- made the KV-to-R2 migration test repeat the same job safely and assert that
  no `fetch` path can carry thumbnail bytes through the control plane; and
- retained the previously packaged bounded Chrome manifest.

Validation:

- focused catalog, thumbnail-migration, and settings tests passed;
- the escalated full gate passed 89 runtime, 15 web, and 12 Chrome tests after
  the initial known sandbox-only socket denial;
- strict types, lint, 617 documented functions, generated bindings, and the
  runtime production dry-run bundle passed; and
- `git diff --check` passed.

Handoff: click **Create my Later Gator** on the authenticated dashboard so the
live Phase 4 and Phase 8 acceptance can proceed. Phase 9 remains untouched.

### `S020` — 2026-08-21 — Owner-action boundary confirmed

**Status:** BLOCKED after three consecutive unchanged live checks  
**Scope:** preserve the explicit onboarding mutation boundary and avoid creating
personal Cloudflare resources without the required owner action

Confirmed:

- the installation remains `authorized` at the initial D1 step;
- all 12 resumable steps still have zero attempts and no safe error;
- no personal Cloudflare resource has been created; and
- local Phase 4–8 implementation and the expanded compatibility gate remain
  ready for the live drill.

Resume condition: the owner clicks **Create my Later Gator** on the authenticated
dashboard and returns to this task. The next agent action is aggregate-only
monitoring of the resumable provisioning job, followed by personal-runtime and
signed-update acceptance. Phase 9 remains untouched.

### `S021` — 2026-08-21 — Identity callback session-loss fix

**Status:** PARTIAL; deployed and locally verified, live consent return awaiting
owner approval

**Scope:** remove the sign-in loop without weakening the existing mutation
boundary or starting personal-resource provisioning

Completed:

- traced repeated successful provider callbacks and valid server-side sessions
  to the browser withholding the readable CSRF cookie on Cloudflare's
  cross-site return because it was issued with `SameSite=Strict`;
- aligned the callback's session-bound CSRF cookie with the opaque session
  cookie at `SameSite=Lax`, which permits the safe top-level OAuth return while
  retaining POST-only mutations, same-origin enforcement, token equality, and
  the server-side session hash binding;
- added an end-to-end Worker regression covering identity discovery, token
  exchange, user lookup, callback cookie attributes, and the authenticated home
  landing;
- passed the complete managed-BYOC gate: 5 contract tests, 45 control-plane
  tests, generated bindings, strict typecheck, and both Worker dry-run bundles;
- deployed only `later-gator-control-plane-dev` as version
  `1896188b-2404-4750-bc33-58a48e77a290` and reached the live identity consent
  screen requesting only **User Details Read**; and
- confirmed through a read-only aggregate D1 query that personal resources and
  provisioning attempts both remain zero.

Owner-only handoff: click **Authorize** on the visible identity consent, then
return to this task. The next action is read-only verification that the browser
lands on **Your Later Gator** rather than **Continue with Cloudflare**. Do not
start provisioning during this callback acceptance check. Phase 9 remains
untouched.

### `S022` — 2026-08-21 — Live `schema_initialize` D1 batch-body repair

**Status:** PARTIAL; deployed and locally verified, live retry awaiting owner
click

**Scope:** diagnose and fix the first live provisioning failure without touching
the trust boundary or creating any new personal resource

Diagnosis (read-only remote inspection only):

- aggregate `provisioning_steps` queries showed `d1`, `oauth_kv`, `thumbnail_kv`,
  `vectorize`, `background_queue`, `thumbnail_queue`, `runtime_secret`, and
  `worker_upload` all complete; only `schema_initialize` was `failed` after
  three attempts with safe error `cloudflare_rejected`;
- the personal installation database contained only D1's internal `_cf_KV`
  table, proving Cloudflare refused the whole request before executing any
  statement;
- current official D1 API documentation confirmed the query endpoint accepts
  either `{sql}` or `{batch: [{sql}]}` and rejects a bare top-level array.

Completed:

- corrected `applySchema` in
  `apps/control-plane/src/adapters/cloudflare-provisioning.ts` to send
  `{"batch": [...]}`, which also repairs the identical call path used by
  managed updates (`updates.ts`);
- hardened both `/query` test fakes (`provisioning.test.ts`,
  `updates.test.ts`) to reject malformed bodies exactly like the real API,
  so a regression to a bare array now fails tests loudly;
- added an explicit regression assertion that the schema step posts a non-empty
  `batch` array of single-statement entries and no legacy `sql` field;
- deployed only `later-gator-control-plane-dev` as version
  `78cf914d-2a81-4290-8d58-f91542db9e07` and confirmed public `/health`
  returns 200 `ready`.

Validation:

- root `npm run lint` passed;
- control-plane `npm run check` passed: generated types current, strict
  typecheck, 45 control-plane tests, and a successful dry-run bundle;
- no new personal resource was created and no installation state was mutated by
  hand; the paused step remains resumable through the app's own retry path.

Owner-only handoff: click **Continue to retry only the unfinished step** on the
authenticated dashboard. The job resumes at `schema_initialize`; remaining steps
are queue consumers, workers.dev enablement, and the health check. If a later
step pauses again, record its safe code before changing code. Phase 9 remains
untouched.

### `S023` — 2026-08-21 — First-provisioning health-check propagation retry

**Status:** PARTIAL; deployed and locally verified, final owner retry awaiting

**Scope:** repair the second live provisioning pause without weakening any
boundary or creating resources

Diagnosis (read-only remote inspection plus one direct public probe):

- after the S022 deployment, the owner's retry completed `schema_initialize`,
  `queue_consumers`, and `workers_dev` on their first attempt;
- only the final `health_check` step paused once with
  `cloudflare_unavailable`: it fetched the brand-new workers.dev origin
  immediately after `workers_dev` enabled it, and new addresses need a short
  propagation window before answering;
- a direct probe of
  `https://later-gator-cc66e9b9450e4b65.vishvak-v.workers.dev/health` returned
  HTTP 200 with release `1.0.0`, schema version 1, and status `ready`.

Completed:

- added a bounded first-provisioning health retry in
  `apps/control-plane/src/application/provisioning.ts`: up to five attempts,
  six seconds apart, via an injectable sleep so tests stay fast;
  incompatible-runtime responses are never retried;
- added two regressions in `test/provisioning.test.ts`: transient unavailability
  recovers to `ready` with recorded waits, and permanent unavailability still
  pauses safely after exactly five attempts on `health_check`;
- deployed development Worker version
  `06029922-2b4d-4ad7-87e5-b90322221e94` and confirmed public `/health` 200.

Validation:

- control-plane `npm run check` passed with 47 tests, current generated types,
  strict typecheck, and a dry-run bundle; root `npm run lint` passed;
- no personal resource was created or mutated by hand; the paused installation
  remains resumable only through the app's own retry action.

Owner-only handoff: click **Continue setup**. Eleven of twelve steps are
complete and the runtime already answers healthy, so this should be the final
action before runtime sign-in acceptance. Record any new safe code verbatim if
a different step pauses. Phase 9 remains untouched.

### `S024` — 2026-08-21 — Deterministic same-zone health-check repair

**Status:** SUPERSEDED IN PART by S025; the health diagnosis remains valid, but
the upload-response identifier conclusion below was later falsified

**Scope:** replace the incorrect propagation diagnosis with the exact Cloudflare
failure and repair the final provisioning step without weakening production
health acceptance

Diagnosis:

- the personal runtime's public `/health` endpoint consistently returned HTTP
  200 `ready`, while every control-plane execution of the same request failed;
- an isolated remote Worker probe reproduced Cloudflare error 1042: a Worker in
  the same `workers.dev` zone cannot reach another Worker through the public
  route in this development account topology, and Cloudflare represents the
  block as a 404 response with body `error code: 1042`;
- therefore more propagation retries could never resolve this installation;
- the Workers upload API returned a legacy response field named
  `deployment_id`; this session incorrectly inferred from the name that its
  value was a deployment ID. A later fresh installation and current Wrangler
  behavior proved that the value is already the Worker version ID; see S025.

Completed:

- detect only the exact bounded 404/1042 response and expose the specific safe
  code `cloudflare_worker_fetch_blocked` instead of conflating it with a network
  outage;
- retain the real public `/health` contract as the production acceptance gate;
- for development only, and only when the runtime and control plane share the
  exact account-owned `workers.dev` namespace, verify the active Cloudflare
  deployment through the Workers API when 1042 prevents the public fetch;
- attempted to resolve the upload field through a deployment-detail request;
  S025 records why that lookup is invalid and removes it, while retaining the
  separate active-deployment lookup used by resumptions and health fallback;
- bound and validate health JSON rather than trusting an unbounded response;
- add regressions proving same-account development recovery, correct version
  recording, and refusal of the fallback outside development.

Validation and deployment:

- focused provisioning tests passed 8 of 8;
- `npm run check:managed-byoc` passed with 5 contract tests and 49 control-plane
  tests, current generated types, strict typecheck, and both Worker dry-run
  bundles;
- root `npm run lint` and `git diff --check` passed;
- deployed only `later-gator-control-plane-dev` as version
  `f6a51046-edd7-4fe4-9c19-0a630544b543`;
- read-only remote D1 verification confirms the installation is still failed at
  `health_check`, with eleven completed steps and no manual state mutation.

Owner-only handoff: authorize the development identity client, return to the
authenticated dashboard, and click **Continue setup** once. Then verify the
installation is `ready`, `worker_upload.resource_id` and `current_version_id`
both equal the active Worker version, and the runtime still answers `/health`
200. Phase 9 remains untouched.

### `S025` — 2026-08-21 — Multipart upload version-ID repair

**Status:** SUPERSEDED by S026; the multipart upload repair succeeded and the
live installation advanced through `worker_upload` to `health_check`

**Scope:** fix the `cloudflare_rejected` failure introduced by S024's incorrect
interpretation of Cloudflare's legacy multipart upload response

Diagnosis:

- read-only control-plane D1 inspection placed the current fresh installation at
  failed `worker_upload`; D1, OAuth KV, thumbnail KV, Vectorize, both Queues, and
  the runtime secret were already complete, while every later step was pending;
- read-only Cloudflare deployment inspection proved the personal Worker upload
  itself succeeded and routed 100% traffic to version
  `248c445d-1449-477d-85a6-abb81013431d`;
- S024 treated the multipart response field `deployment_id` as a deployment ID
  and requested `/deployments/{id}`. Current Wrangler 4.114.0 explicitly treats
  that legacy field as the version ID, so the detail request incorrectly passed
  a version ID where Cloudflare requires a deployment ID and received a 4xx;
- deleting and reinstalling could not help because each fresh installation ran
  the same invalid post-upload lookup.

Completed:

- return the validated and normalized multipart `deployment_id` value directly
  as the initial Worker `versionId`;
- remove the invalid deployment-detail lookup while retaining the independent
  deployment-list lookup used by resumed health checks and managed updates;
- make the provisioning fake return a version ID from the multipart upload;
- add a regression asserting initial provisioning performs zero exact
  deployment-detail requests and stores the returned version ID in the
  `worker_upload` ledger;
- mark S024's upload-identifier conclusion as superseded without changing its
  still-valid exact 1042 health diagnosis.

Validation and deployment:

- current Cloudflare plugin documentation and API schemas were retrieved, and
  the account's raw deployment API confirmed newest-first active-deployment
  ordering;
- current `@cloudflare/workers-types` `5.20260821.1` and Wrangler `4.114.0` were
  checked;
- focused provisioning tests passed 8 of 8;
- `npm run check:managed-byoc` passed with 5 contract tests, 49 control-plane
  tests, generated types, strict typecheck, and both Worker dry-run bundles;
- root `npm run lint` and `git diff --check` passed;
- deployed only `later-gator-control-plane-dev` as version
  `2a869029-08eb-48d1-b916-29df0d7258d4`, and its public `/health` returned HTTP
  200 `ready`;
- no control-plane installation record or personal resource was changed by
  hand.

Owner-only handoff: click **Continue setup** once on the authenticated dashboard.
Afterward verify the installation is `ready`, all 12 provisioning steps are
complete, `worker_upload.resource_id` and `current_version_id` equal the latest
active personal Worker version, and the personal `/health` contract is ready.
Phase 9 remains untouched.

### `S026` — 2026-08-21 — Resumed health-state restoration

**Status:** SUPERSEDED IN PART by S027; the resume-state repair completed setup,
but it did not reconcile an out-of-band Worker deletion before trusting the
stored upload receipt

**Scope:** fix the repeated final `cloudflare_unavailable` pause without
recreating resources, changing installation state manually, or weakening the
production health boundary

Diagnosis:

- read-only D1 inspection confirmed S025 worked: `worker_upload` is complete
  and stores Worker version `ad84ffc2-fcbe-466b-87dc-6063d6a57fd7`; schema,
  Queue consumers, and workers.dev enablement also completed, leaving only
  `health_check` failed;
- Cloudflare's public route returns the expected release `1.0.0`, schema version
  1, and `ready` health, and the newest active deployment routes 100% traffic to
  the same stored Worker version;
- Cloudflare documents and a remote Worker probe confirm sibling Workers on one
  workers.dev namespace cannot reliably use a public fetch as their development
  health channel; the production `latergator.app` topology remains subject to
  the real public health gate;
- every resumed provisioning request initialized its in-memory Worker version
  to empty because the already-complete upload step was skipped. The development
  fallback then made an unnecessary deployment-list request and could surface
  the generic `cloudflare_unavailable` pause despite the verified upload receipt
  already being durable in D1.

Completed:

- added an adapter read that restores an immutable provider resource ID only
  from a completed provisioning step;
- initialize resumed provisioning from the completed `worker_upload` receipt;
- in the exact development-only, same-workers.dev namespace topology, accept
  that verified upload receipt after all later resource/configuration steps
  complete instead of repeating an inaccessible sibling-Worker fetch;
- retain bounded public health retries and strict runtime contract validation
  outside that development-only topology;
- remove the resumed development path's unnecessary deployment-list dependency;
- add a failed-health-to-resume regression proving no resource recreation, no
  health retry, no deployment-list call, and the correct final version ID.

Validation and deployment:

- focused provisioning tests passed 9 of 9;
- `npm run check:managed-byoc` passed with 5 contract tests and 50 control-plane
  tests, current generated types, strict typecheck, and both Worker dry-run
  bundles;
- root `npm run lint` and `git diff --check` passed;
- deployed only `later-gator-control-plane-dev` as version
  `334de0a3-a1bd-4fef-90c7-f52a0da4c614`, and its public `/health` returned HTTP
  200 `ready`;
- no personal resource or control-plane installation record was mutated by
  hand.

Owner-only handoff: on the already-authenticated dashboard, click **Continue
setup** once. It should resume only `health_check` and transition immediately to
ready. Do not delete or reinstall. Afterward verify all 12 steps are complete,
`current_version_id` equals the stored `worker_upload.resource_id`, and the
personal runtime remains publicly healthy. Phase 9 remains untouched.

### `S027` — 2026-08-21 — Personal login route and deleted-Worker reconciliation

**Status:** PARTIAL; implementation, validation, schema application, and
development deployment complete; owner login acceptance remains

**Scope:** repair the highest-priority `not_found` personal-runtime sign-in and
prevent a resumed failed installation from reporting ready after its Worker was
deleted out of band

Diagnosis:

- the personal runtime correctly redirected `/auth/login` to the control plane's
  `/runtime/login` endpoint with its installation ID, exact callback, nonce, and
  state, but the control-plane router had no `/runtime/login` implementation and
  returned the screenshot's `not_found` page;
- the assertion signer, public verification keys, and runtime assertion verifier
  already existed, so the missing component was the authenticated orchestration
  route and its replay-protected continuation record;
- a failed installation could retain `worker_upload = complete` after the owner
  deleted that Worker in Cloudflare. S026 restored the durable version receipt
  and trusted it without first reconciling provider existence, allowing a stale
  origin to be marked ready;
- read-only live inspection confirmed the current replacement Worker
  `later-gator-b89a58a2fff34566` exists with the correct D1, KV, Queue,
  Vectorize, AI, origin, installation, and control-plane bindings.

Completed:

- implemented `/runtime/login` and `/runtime/login/resume` with exact query
  cardinality, ready-installation lookup, exact callback-origin/path binding,
  control-session reuse or Cloudflare identity continuation, short-lived opaque
  request cookies, ES256 owner assertions, and atomic replay rejection;
- added the content-free `runtime_login_requests` control-plane table and expiry
  index; it stores only opaque login coordination values and no bookmark or
  provider data;
- added privacy-safe runtime-login observability event codes;
- added `workerExists` reconciliation against Cloudflare before a non-ready
  installation trusts a completed upload ledger;
- when the Worker is missing, reopen only `worker_upload`, `queue_consumers`,
  `workers_dev`, and `health_check`, then recreate the same deterministic Worker
  rather than returning a false success;
- added regressions for exact assertion issuance, callback substitution,
  continuation replay, and failed-installation Worker recreation.

Validation and deployment:

- focused runtime-login and provisioning tests passed 12 of 12;
- `npm run check:managed-byoc` passed with 5 contract tests and 53 control-plane
  tests, current generated types, strict typecheck, and both Worker dry-run
  bundles;
- root `npm run lint` and `git diff --check` passed;
- applied the additive schema to development control-plane D1 successfully;
- deployed only `later-gator-control-plane-dev` as version
  `18cde349-a577-4ee3-b60c-48f894460521`;
- public control-plane and personal-runtime health both return ready, and a live
  bounded request to the new `/runtime/login` route returns HTTP 302 instead of
  the former HTTP 404 `not_found`;
- no personal resource was deleted, recreated, or mutated during deployment.

Owner-only handoff: reopen
`https://later-gator-b89a58a2fff34566.vishvak-v.workers.dev/` and click
**Continue with Cloudflare**. Record the next page if runtime acceptance does
not reach the application. Do not delete or reinstall the current ready
installation. Phase 9 remains untouched.

### `S028` — 2026-08-22 — Main-branch deployment and extension test handoff

**Status:** PR `#1` OPEN; CI credentials and owner extension ID remain external
handoff items

**PR:** `https://github.com/vishvak1/later-gator/pull/1`

**Scope:** make accepted changes deploy the development control plane from
`main`, activate conditional managed updates in development, and document the
unpacked Chrome acceptance flow without submitting the extension

Completed:

- added a GitHub Actions workflow that validates pull requests into `main` and,
  after every push to `main`, applies the additive control-plane D1 schema and
  deploys only `later-gator-control-plane-dev`;
- kept Cloudflare credentials out of source and required account-scoped
  `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` Actions secrets;
- enabled the existing bounded hourly managed-update scheduler in the
  development configuration;
- retained the update consent boundary: control-plane-only commits do not
  mutate personal Workers, and a new immutable runtime release reaches only
  ready installations in the active cohort whose owner has not revoked managed
  update authorization; and
- added an unpacked Chrome test runbook covering the development-origin build,
  exact extension-ID allowlist, Cloudflare pairing, exact-origin permission,
  ordinary and X captures, duplicate review, revocation, and reload behavior.

Validation:

- `npm run check` passed with 89 runtime, 15 web, and 12 Chrome extension tests,
  strict types, documented-function and lint gates, and generated binding checks;
- `npm run check:managed-byoc` passed outside the filesystem sandbox with 5
  contract and 53 control-plane tests, current generated bindings, strict
  typecheck, and runtime/control-plane dry-run bundles;
- the GitHub Actions YAML parsed successfully, the development unpacked folder
  was generated with the exact development control-plane origin, and
  `git diff --check` passed;
- the first GitHub runner exposed that Ubuntu did not provide `rg`; the
  documented-function gate now prefers `rg` and falls back to dependency-free
  recursive discovery when it is absent. Both the normal and forced-no-`rg`
  paths report 636 documented functions across 90 source files, and root lint
  passes;
- the next runner exposed that merely declaring Workers AI caused the Vitest
  integration to request a remote proxy and CI credentials. The runtime test
  project now disables remote bindings explicitly; production-provider tests
  continue to pass explicit fake `Env` objects. All 89 runtime tests pass with
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` removed from the process.

External handoff before the first automatic deployment:

1. add the two account-scoped Cloudflare secrets to the GitHub repository or
   `control-plane-development` environment before merging the PR;
2. load the development build in Chrome, provide the assigned 32-character ID,
   and add it to `CHROME_EXTENSION_IDS` before pairing acceptance; and
3. keep Phase 9 untouched until the remaining owner acceptance and launch gates
   are complete.
