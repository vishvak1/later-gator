# Later Gator Managed BYOC — Proposed Product Requirements

**Status:** proposed planning specification; not yet implemented or authoritative  
**Repository:** the existing `vishvak1/later-gator` repository  
**Target:** an open-source, single-owner bookmark application managed through
`latergator.app` and deployed into each owner's Cloudflare account

This document defines the intended managed-BYOC product. Until the rebuild is
implemented and accepted, the three specifications under `docs/` continue to
describe the current application. On completion, this proposal must be merged
into those canonical documents and this planning copy removed.

## 1. Product definition

Later Gator is a private, single-owner bookmark manager whose application,
bookmark data, thumbnails, AI credentials, background jobs, and semantic index
run in the owner's Cloudflare account.

`latergator.app` is a management control plane. It authenticates owners with
Cloudflare, provisions and updates personal installations, publishes public
compatibility information, and helps the official Chrome extension locate the
correct installation. It is not the bookmark data plane.

The official product path must not require users to understand Git, GitHub,
repositories, pull requests, Wrangler, binding identifiers, Vectorize
dimensions, or database initialization.

## 2. Product goals

- Preserve user ownership of Cloudflare resources and personal data.
- Give nontechnical users one Cloudflare-based sign-in experience.
- Deliver tested application updates without managing user repositories.
- Keep OpenAI and Anthropic credentials inside the personal installation.
- Continue working when the management control plane is temporarily unavailable.
- Degrade safely when optional thumbnail storage or AI services are unavailable.
- Remain open source and independently auditable.
- Support at least two years of reliable operation, with a design suitable for
  five years of provider, storage, and schema evolution.

## 3. Product boundaries

### 3.1 Management control plane

`latergator.app` owns only management responsibilities:

- Cloudflare OpenID Connect authentication;
- installation and account association;
- encrypted Cloudflare deployment authorization;
- resource provisioning and application updates;
- signed runtime releases and rollout state;
- a signed public model-compatibility catalog;
- current informational Cloudflare storage-plan copy;
- Chrome extension installation discovery and one-time pairing grants; and
- redacted operational health and audit events.

The control plane must not store or process:

- bookmark URLs, titles, notes, descriptions, excerpts, or page content;
- thumbnails;
- OpenAI or Anthropic API keys or encrypted copies of those keys;
- the owner's selected provider or model;
- AI prompts, responses, classifications, or usage;
- library exports; or
- capture payloads.

### 3.2 Personal runtime

Each owner receives one personal Later Gator Worker in the selected Cloudflare
account. That installation owns:

- the dashboard and application APIs;
- D1 application and bookmark state;
- Workers KV or R2 thumbnail bytes, according to owner choice;
- Vectorize embeddings;
- organization and thumbnail Queues;
- provider configuration and encrypted provider credentials;
- dashboard sessions and capture credentials;
- read-only MCP connections; and
- privacy-safe application logs in the owner's Cloudflare account.

### 3.3 Chrome extension

Later Gator publishes one official Chrome Web Store extension. All owners use
the same extension package. It authenticates the owner through the low-privilege
identity flow, discovers the personal installation, obtains a capture-only
credential, and then communicates directly with that installation.

Firefox publication is outside the initial managed-BYOC release.

## 4. Identity and authorization

### 4.1 One sign-in method

The only owner sign-in method is **Continue with Cloudflare**. There is no
Later Gator email/password account, bootstrap password, password reset, or
recovery phrase.

First authentication creates the control-plane owner record. Later
authentications locate the existing installation.

The stable Cloudflare OpenID subject, not an email address, is the owner key.

### 4.2 Separate OAuth authority

Identity and infrastructure authorization must remain separate even when they
appear as one guided onboarding journey:

- **Identity authorization:** the confidential control-plane client requests
  only `user-details.read` to identify the owner. The later public Chrome client
  requests the same identity-only scope using S256 PKCE and no client secret.
- **Installer authorization:** the same confidential control-plane client makes
  a separate consent request for only the Cloudflare account permissions needed
  to provision and update the selected installation.

The stored scope ceiling of the confidential client may cover both flows, but
each authorization request must contain only its purpose-specific subset.

Identity tokens must never contain deployment authority. Installer tokens must
never be sent to the personal Worker, dashboard JavaScript, or Chrome extension.

### 4.3 Personal application session

After Cloudflare authenticates the owner, the control plane issues a
short-lived, signed, installation-bound assertion. The personal Worker verifies
the assertion and creates its own `HttpOnly`, `Secure` session.

Mutations continue to require same-origin validation, CSRF protection,
idempotency where appropriate, and explicit owner action.

### 4.4 Availability behavior

If `latergator.app` is unavailable:

- the personal Worker and existing sessions continue operating;
- extension capture with an existing credential continues operating;
- AI organization and background jobs continue operating;
- new sign-ins, installations, extension pairings, and updates wait until the
  control plane returns.

## 5. Installation and onboarding

The official installation flow is:

1. Visit `latergator.app`.
2. Select **Continue with Cloudflare**.
3. Choose thumbnail storage.
4. Authorize installation into a selected Cloudflare account.
5. Allow the control plane to provision the required resources.
6. Observe a plain-language progress screen.
7. Open the resulting stable `workers.dev` application URL.
8. Complete personal setup inside the personal installation.
9. Optionally install and connect the official Chrome extension.

The installer must programmatically set names, binding identifiers, Vectorize
dimensions and metric, Queue configuration, Worker secrets, and the initial D1
schema. Users must not type those values.

If an account administrator disables public OAuth applications, installation
must stop with a clear explanation and no partial claim of success.

## 6. AI provider behavior

### 6.1 Provider ownership

Cloudflare Workers AI is the default organization provider. The owner may switch
to OpenAI or Anthropic at any time from the personal Later Gator Settings page.

Provider selection, model selection, connection testing, activation, failure
state, and usage links belong exclusively to the personal installation.

### 6.2 Model catalog

`latergator.app` may publish a signed public catalog of currently supported
provider model identifiers, display names, capability flags, defaults,
deprecations, and minimum compatible runtime releases.

The personal runtime must validate, cache, and use the last valid catalog. A
catalog failure must not change the active provider or break organization work.
Catalog data must never contain user-specific configuration.

### 6.3 Provider credentials

OpenAI and Anthropic keys are entered on a page served by the personal Worker
and sent directly to that Worker.

The personal Worker encrypts each credential under a per-installation master
key held as a Worker secret. Only ciphertext and encryption metadata are stored
in the personal D1 database. Plaintext is held only transiently in browser and
Worker memory and is sent only to the selected provider.

The control plane must never receive the credential, ciphertext, prompt, or
provider response.

## 7. Thumbnail storage choice

### 7.1 Workers KV default

Workers KV is the recommended default for owners who do not want to activate an
R2 subscription.

Setup must describe limits as current, account-shared Cloudflare allowances,
not permanent Later Gator entitlements. As checked on 2026-08-19, Cloudflare
documents 1 GB of KV storage per Free account and namespace, with Free-plan
daily operation limits.

When a daily operation allowance is exhausted, thumbnail work waits for the
allowance to reset. When storage is full, Later Gator stops new thumbnail writes
and asks the owner to disable future thumbnails, reclaim storage, move to R2,
or change their Cloudflare plan. Bookmark capture and organization continue.

### 7.2 Optional R2

Owners may choose R2 for greater thumbnail capacity. Setup must explain that R2
requires an R2 subscription checkout and may require a billing profile. As
checked on 2026-08-19, Cloudflare documents 10 GB-month of Standard R2 storage,
one million Class A operations, and ten million Class B operations per month as
included usage.

The product must link to Cloudflare's current pricing and show when the
information was last reviewed. It must never promise that the allowance or
billing requirement will remain unchanged.

If R2 is not active, setup opens the official Cloudflare activation flow, waits
for the owner to return, and rechecks availability before creating a bucket.

### 7.3 Disabled state and migration

Thumbnails are optional. The runtime supports `kv`, `r2`, and `disabled`
storage modes. Thumbnail failure never fails a bookmark write.

An owner may move from KV to R2 later. The control plane provisions and binds
R2, while a background job inside the personal Worker copies bytes directly
between resources in the owner's account. D1 records the backend of each object
so reads remain correct during a mixed-backend migration. Deletion of source
objects happens only after verification and explicit approval.

## 8. Chrome extension experience

The extension flow is:

1. Install from the Chrome Web Store.
2. Select **Continue with Cloudflare**.
3. Complete the identity-only OAuth flow.
4. Let the control plane locate the installation.
5. Approve host access for the exact personal Worker origin.
6. Exchange a signed one-time pairing grant for a capture-only credential.
7. Save bookmarks directly to the personal Worker.

The extension must not store Cloudflare installer tokens, provider keys, owner
session cookies, or the control-plane OAuth client secret.

The existing detailed capture behavior, including duplicate detection and X
link selection/review flows, remains part of the personal runtime contract.

## 9. Updates and schema evolution

The control plane deploys immutable, tested runtime artifacts directly through
Cloudflare authorization. End users do not receive or manage repositories.

Every release includes:

- application version;
- artifact digest and signature;
- compatible schema range;
- required and optional Cloudflare bindings;
- health-check contract version;
- model-catalog compatibility; and
- rollback metadata.

Fresh installations use the current base schema. Existing installations use
immutable, checksum-verified schema migrations recorded in D1. There is one
current runtime codebase; migration history must not create parallel `v2`,
`v3`, or similar application trees.

Updates roll out by installation cohort. Each personal installation receives an
atomic promotion rather than a long-running traffic split between schema-sensitive
versions. Risky data changes require a maintenance state and a recorded D1 Time
Travel bookmark before mutation.

## 10. Privacy and security requirements

- Control-plane logs contain only opaque IDs, release versions, safe error
  codes, durations, and counts.
- Personal runtime logs follow the existing redaction contract and remain in the
  owner's account.
- OAuth tokens, installation secrets, and release signing keys are encrypted and
  independently rotatable.
- Public model and plan catalogs are schema-validated and signed; they cannot
  execute code.
- Installation, retries, updates, storage migration, and uninstall are
  idempotent and fault-injection tested.
- Revoking installer authorization stops updates but does not disable or delete
  the personal Worker.
- Account deletion removes control-plane identity and authorization records.
  Personal Cloudflare resources are deleted only through a separately confirmed
  uninstall action.
- The user is clearly informed that deployment authorization permits Later
  Gator to update application code in the selected Cloudflare account.

## 11. Open-source and ownership model

The existing `later-gator` repository remains public and is the sole source
repository. Official users do not receive forks or cloned repositories.

Advanced developers may audit, build, or adapt the source, but manual forks are
outside the managed update guarantee unless they register through a supported
developer installation path.

## 12. Out of scope for the initial release

- A centrally hosted bookmark SaaS data plane.
- Proxying ordinary bookmark traffic through `latergator.app`.
- Email/password accounts or recovery phrases.
- User-managed GitHub repositories and pull requests.
- Firefox Web Store publication.
- A Later Gator subscription or bundled provider billing.
- Automatic activation of a billable Cloudflare product without explicit user
  action.
- Storage migration that sends private thumbnail bytes through the control plane.

## 13. Release acceptance

The managed-BYOC release is acceptable only when:

- a new user installs into a clean test account without GitHub or Wrangler;
- Cloudflare identity is the only owner sign-in path;
- the personal Worker remains usable during a simulated control-plane outage;
- Workers AI works by default and OpenAI/Anthropic can be configured locally;
- provider credentials are absent from control-plane storage, logs, and traces;
- both KV and R2 installation variants pass the same runtime behavior suite;
- KV limit failures preserve bookmark capture and show safe remediation;
- KV-to-R2 migration occurs entirely in the personal Cloudflare account;
- the Chrome extension discovers and connects to the correct installation;
- an old supported runtime can update, migrate, health-check, and roll back;
- installer revocation stops updates without stopping the application; and
- current product behavior not explicitly superseded by this proposal remains
  covered by the existing regression suite.
