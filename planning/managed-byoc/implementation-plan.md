# Later Gator Managed BYOC — Step-by-Step Implementation Plan

**Status:** proposed execution plan  
**Application source:** existing `later-gator` repository  
**Deployment target:** the owner's test Cloudflare account first; no production
library testing

## Live execution state

Implementation progress is intentionally not duplicated in this static plan.
The authoritative status, active slice, validation evidence, and next-session
queue live in `planning/managed-byoc/execution-tracker.md`. Every managed-BYOC
coding session must update that tracker before handoff.

## 1. Working-tree and branch rule

The current repository contains in-progress changes on `prd-change`. Managed
BYOC implementation must not be mixed into an uncommitted feature set.

Before implementation begins:

1. Review and finish, commit, or deliberately shelve the current product work.
2. Confirm the baseline commit that contains all behavior to preserve.
3. Create a clean `codex/managed-byoc` implementation branch from that baseline.
4. Treat `/Users/vishvakvragav/Documents/later-gator` as the only source tree.
5. Use the test Cloudflare account as the canary; do not recreate a
   `my-later-gator` source fork.

The planning files may coexist with the current changes because they are new,
isolated files. Source restructuring must wait for a clean baseline.

## 2. Delivery principles

- Preserve current bookmark behavior unless the proposed PRD explicitly
  supersedes it.
- Keep one runtime codebase and one Chrome extension source.
- Add a regression test with every behavior change.
- Use generated Cloudflare `Env` types for every deployable application.
- Validate all external, stored, OAuth, catalog, release, and migration payloads
  with Zod.
- Never place bookmark content, credentials, OAuth tokens, or remote response
  bodies in logs.
- Make installation and update steps idempotent before testing retries.
- Do not deploy to production resources while building or diagnosing.
- Do not publish the extension until the personal runtime and pairing contracts
  are stable.

## 3. Phase 0 — Freeze the baseline and contracts

### Work

1. Complete or isolate the current `prd-change` work.
2. Run the existing full test and dry-run build gates.
3. Record the preserved feature inventory from the canonical documents and
   current tests.
4. Approve the proposed PRD and structural plan.
5. Define initial versions of the shared contracts:
   `OwnerAssertion`, `PairingGrant`, `RuntimeReleaseManifest`, `ModelCatalog`,
   `StoragePlanCatalog`, and `SystemHealth`.
6. Enumerate the exact Cloudflare OAuth scopes required for each storage
   variant and document why each scope is necessary.

### Exit gate

- Clean implementation baseline.
- Existing tests pass unchanged.
- No unresolved product decision changes the trust boundary or resource set.
- OAuth scopes and public-client redirect URIs are reviewed before client
  registration.

## 4. Phase 1 — Create the workspace without changing behavior

### Work

1. Add npm workspaces at the repository root.
2. Move the existing Worker, dashboard, schema, and tests into `apps/runtime`.
3. Move the single extension source into `apps/chrome-extension`.
4. Remove generated Chrome/Firefox copies from source ownership.
5. Remove Firefox build output from the initial managed release while retaining
   current Chrome behavior.
6. Add empty `apps/control-plane` and `packages/contracts` packages.
7. Rewire typecheck, lint, function-documentation, unit, browser, contract, and
   dry-run build commands.

### Tests

- Current Worker tests run against the moved runtime.
- Current dashboard and extension tests run against their new paths.
- Runtime production dry run has the same functional bindings.
- Generated asset hashes and manifests are deterministic.

### Exit gate

The repository structure is new, but user-visible behavior and the test count
are unchanged.

## 5. Phase 2 — Build the control-plane identity shell

### Work

1. Create the control-plane Worker and D1 schema.
2. Register a private development Cloudflare OAuth client whose sign-in request
   uses only `user-details.read` and whose later installer request uses only its
   required provisioning subset.
3. Implement Authorization Code flow, PKCE where required, state/nonce
   validation, callback handling, user-info validation, and local control-plane
   sessions.
4. Store the stable Cloudflare subject as the owner identifier.
5. Build the signed owner-assertion issuer with key rotation support.
6. Create an installation dashboard that can represent `no installation`
   without provisioning anything.
7. Add account deletion for control-plane-only metadata.

### Tests

- OAuth state, nonce, PKCE, callback replay, issuer, audience, expiry, and key
  rotation contract tests.
- Fault-injection tests for callback/provider/network failures.
- Logs prove absence of identity tokens and user-profile payloads.

### Exit gate

A test user can select **Continue with Cloudflare**, obtain a safe local session,
and see an empty installation dashboard. No deployment scope has been requested.

## 6. Phase 3 — Replace runtime password authentication and credential wrapping

### Work

1. Add the owner-login redirect and assertion callback to the personal runtime.
2. Bind each installation to one Cloudflare subject.
3. Verify signed, installation-bound assertions and consume nonce/JTI once.
4. Create ordinary local sessions without an encrypted data-key copy.
5. Remove password UI, password routes, password fallback, `PASSWORD` binding,
   `auth_config`, and login-attempt state from the fresh schema.
6. Add `INSTANCE_MASTER_KEY` support.
7. Replace dual provider-credential ciphertext with one envelope encrypted by
   the instance secret.
8. Change MCP approval to require an authenticated owner session only.

### Tests

- Assertion replay, wrong audience/installation/subject, expiry, and signing-key
  failure tests.
- Session, CSRF, origin, logout, expiry, and MCP-consent regressions.
- Provider credential encrypt/decrypt tests proving no control-plane call.
- Repository-wide secret/log leak checks.

### Exit gate

The runtime has no Later Gator password or recovery phrase. Workers AI works by
default. OpenAI and Anthropic keys can be entered, encrypted, tested, used by a
Queue consumer, and removed entirely within the personal installation.

## 7. Phase 4 — Build idempotent OAuth provisioning

### Work

1. Add installer authorization to the accepted private server OAuth client and
   enable durable refresh support before managed-update acceptance.
2. Implement encrypted installer-token storage and revocation.
3. Add the thumbnail-storage choice before provisioning.
4. Request only the permissions required by the chosen variant.
5. Implement a resumable provisioning state machine for:
   - D1;
   - Workers KV or R2;
   - Vectorize with fixed dimensions and metric;
   - organization and thumbnail Queues;
   - MCP OAuth KV if still required;
   - Worker upload, assets, bindings, secrets, and `workers.dev`; and
   - base-schema initialization.
6. Detect inactive R2 and pause for the owner to complete Cloudflare checkout.
7. Add compensating cleanup for cancelled or irrecoverably failed installs.
8. Run a safe health check before marking an installation ready.

### Tests

- Mock Cloudflare API contract tests for every resource.
- Retry after each possible partial failure.
- Duplicate-click and callback-replay tests.
- KV and R2 variant acceptance in disposable test resources.
- Explicit confirmation before cleanup deletes created resources.

### Exit gate

From `latergator.app`, a nontechnical user can create a working test installation
without GitHub, Wrangler, resource IDs, or manually entered Vectorize settings.

## 8. Phase 5 — Add storage resilience and migration

### Work

1. Introduce `ThumbnailStore` and KV/R2/disabled adapters.
2. Add backend and byte-size metadata to thumbnail rows.
3. Add storage status and safe failure categories.
4. Pause only thumbnail work on daily allowance or capacity failures.
5. Preserve bookmark creation, AI organization, search, and existing-thumbnail
   delivery during thumbnail failure.
6. Add owner actions to disable thumbnails and reclaim older thumbnails.
7. Build the KV-to-R2 upgrade flow:
   - redirect to control plane;
   - request incremental permission;
   - activate/check R2;
   - provision bucket;
   - deploy both bindings;
   - copy in a personal-runtime background job;
   - verify object-by-object;
   - switch new writes to R2; and
   - remove KV objects only after owner approval.

### Tests

- KV write/read/storage-limit fault injection.
- R2 operation and subscription-unavailable failures.
- Disabled mode.
- Mixed-backend reads during migration.
- Interrupted, repeated, and resumed migration.
- Proof that bytes do not pass through control-plane fixtures or logs.

### Exit gate

Thumbnail storage can fail, pause, disable, or migrate without losing a
bookmark or blocking the core application.

## 9. Phase 6 — Add the model and plan catalogs

### Work

1. Define signed, schema-validated model and storage-plan catalogs.
2. Build a release-authorized publication process.
3. Fetch, validate, and cache catalogs in personal D1.
4. Replace free-text provider model entry with supported dropdowns plus clear
   unavailable/deprecated states.
5. Keep provider/model selection and API keys local.
6. Display plan allowances as informational copy with review date and official
   Cloudflare links; never use those numbers as quota-enforcement logic.

### Tests

- Invalid signature/schema, replayed revision, stale catalog, network failure,
  unknown model, and deprecation behavior.
- Provider choice never changes as a side effect of catalog refresh.
- Catalog payloads contain no installation or provider-credential fields.

### Exit gate

Public compatibility information can change without a runtime release, while
personal provider configuration remains private and stable.

## 10. Phase 7 — Rebuild and publish the Chrome extension

### Work

1. Add the Chrome `identity` permission and OAuth callback handling.
2. Replace connection-code paste with identity login and installation discovery.
3. Issue and validate short-lived pairing grants.
4. Request optional host permission for the exact personal Worker origin.
5. Exchange the grant for an existing narrow capture-credential shape.
6. Add device naming, last-used state, revocation, and reconnect behavior.
7. Retain current popup, duplicate, X-link, relationship, and direct-capture
   behavior.
8. Prepare store listing, privacy disclosure, screenshots, package signing, and
   Chrome Web Store submission.

### Tests

- OAuth cancellation, wrong owner, multiple/no installation, grant replay,
  revoked device, missing host permission, runtime unreachable, and extension
  update compatibility.
- Manifest permission review and remote-code prohibition checks.
- Existing popup and capture regressions.

### Exit gate

An owner can install the public Chrome package, choose **Continue with
Cloudflare**, and save directly to the correct personal Worker without copying a
URL or token.

## 11. Phase 8 — Build managed runtime releases and schema evolution

### Work

1. Produce immutable runtime bundles and signed release manifests.
2. Add the runtime release and schema-migration ledgers.
3. Add checksum verification and compatible schema ranges.
4. Implement expand/migrate/contract migration rules.
5. Record D1 Time Travel position before risky mutation.
6. Upload a Worker version, health-check, promote atomically, and record its ID.
7. Roll out by installation cohort: internal canary, small cohort, larger
   cohorts, then stable population.
8. Pause rollout automatically on safe failure thresholds.
9. Coordinate Worker rollback with schema/storage compatibility rather than
   assuming a code rollback restores data.
10. Expose update history, current version, failure state, and installer
    authorization state without exposing application data.

### Tests

- Fresh install at current schema.
- Update from every supported prior release.
- Interrupted migration and deployment retry.
- Health-check failure before and after promotion.
- Rollback with compatible and incompatible schema changes.
- Revoked installer token.
- Control-plane outage during each state.

### Exit gate

The test installation upgrades from a prior release to the current release and
recovers from injected failures without manual GitHub or Wrangler work.

## 12. Phase 9 — Documentation, security review, and launch gate

### Work

1. Merge approved planning requirements into the three canonical documents.
2. Rewrite README onboarding around `latergator.app`.
3. Move the Deploy-to-Cloudflare button to an explicitly unsupported or
   advanced developer path, or remove it from the official flow.
4. Document OAuth permissions and the exact user-visible reason for each.
5. Document KV/R2 choices, current-facts date, pricing links, disabled mode, and
   migration.
6. Document account deletion, installer revocation, disconnect, export, and
   uninstall separately.
7. Complete privacy policy, threat model, incident runbooks, release signing,
   key rotation, dependency audit, and Chrome disclosures.
8. Delete this planning directory after canonical-document reconciliation.

### Launch gate

- Clean install into a new Free test account using KV.
- Clean install into an R2-enabled test account.
- Cloudflare identity login on first and returning visits.
- Control-plane outage drill.
- Workers AI, OpenAI, and Anthropic acceptance.
- Chrome extension store package acceptance.
- KV capacity and KV-to-R2 migration drill.
- Runtime update and rollback drill.
- Export and confirmed uninstall drill.
- Complete local checks, dry-run builds, contract tests, and redaction audit.

## 13. First vertical milestone

The first end-to-end milestone is intentionally smaller than the full rebuild:

1. Sign into a development `latergator.app` with Cloudflare identity.
2. Authorize the test Cloudflare account.
3. Select KV thumbnail storage.
4. Provision one personal installation without GitHub.
5. Sign into that personal Worker through Cloudflare.
6. Save one dashboard bookmark.
7. Prove that the control-plane D1 and logs contain no bookmark or provider
   fields.

R2, extension publication, model catalogs, and automatic updates follow only
after this trust-boundary slice is demonstrably correct.

## 14. Operational runbooks required before launch

- OAuth identity provider unavailable.
- Installer authorization revoked or expired.
- Partial resource provisioning and safe resume.
- Control plane unavailable while personal runtimes continue.
- KV daily operation limit and storage capacity reached.
- R2 subscription unavailable or R2 operations failing.
- Invalid OpenAI/Anthropic credential and provider outage.
- Model deprecated or removed from the public catalog.
- Runtime health check fails after upload.
- Schema migration fails before or after promotion.
- Release-signing key or OAuth client-secret rotation.
- Chrome extension version incompatible with a runtime.
- Explicit account deletion versus explicit Cloudflare-resource uninstall.

## 15. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Installer OAuth has broad account authority | Minimum scopes, selected-account consent, dedicated-account recommendation, audit history, easy revocation |
| Control-plane compromise becomes supply-chain compromise | Signed immutable releases, separate signing authority, canary/cohort rollout, automatic pause, public source |
| Control-plane outage prevents new login | Personal local sessions, direct data plane, clear outage behavior |
| Cloudflare pricing changes | Storage adapter, current-facts catalog, official links, disabled mode, owner-approved migration |
| KV fills | Stop only thumbnail writes; preserve bookmarks and existing objects |
| R2 produces unexpected billing | Explicit checkout, current pricing link, no silent enablement, owner-visible storage state |
| Code rollback conflicts with changed D1 | Compatible schema ranges, expand/contract, Time Travel position, maintenance state |
| Extension receives excess authority | Identity-only OAuth, exact-origin host permission, capture-only token |
| Planning diverges from implementation | Contract tests and final merge into the three canonical documents |
