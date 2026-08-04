# Later Gator — Developer Guide

**Applies to:** the current Later Gator product and implementation architecture

**Companion documents:** [Product Requirements](product-requirements.md) and
[Technical Design](technical-design.md)

**Last consolidated:** 2026-07-31

**Current repository status:** `src/index.ts` now selects the v6 implementation
under `src/v6`. The older source tree is retained temporarily as migration
history but is excluded from the active TypeScript, lint, test, and deployment
entry points.

---

## 1. The mental model

Later Gator is the bookmark manager.

```mermaid
flowchart LR
    UI["Dashboard"] --> W["Later Gator Worker"]
    EXT["Browser extension"] --> W
    IOS["iOS Shortcut"] --> W
    MCP["MCP client"] --> W
    W <--> D1["D1: authoritative library"]
    W <--> KV["Workers KV: private thumbnails"]
    W --> AQ["AI/background Queue: job IDs"]
    AQ --> W
    W --> TQ["Thumbnail Queue: job IDs"]
    TQ --> W
    W --> AI["Selected AI provider"]
```

The most important rules are:

1. D1 is the system of record.
2. Workers KV contains only thumbnail binaries.
3. Queue messages contain only a job ID or an ID-free dispatcher signal.
4. AI never writes without rechecking the bookmark revision.
5. Raindrop is only a CSV import source.
6. View and edit remain usable when AI is unavailable.

If you remember those six rules, most of the design follows naturally.

---

## 2. What changed from the retired Raindrop architecture

The previous implementation was built around Raindrop:

- Cron searches Raindrop Unsorted.
- Queue messages refer to Raindrop bookmarks.
- KV contains onboarding, leases, folder IDs, and a tag registry.
- Raindrop remains authoritative.

The current implementation replaces that architecture:

| Retired concept              | Current replacement                              |
| ---------------------------- | ------------------------------------------------ |
| Raindrop bookmark            | D1 `bookmarks` row                               |
| Raindrop folder IDs          | Seeded immutable D1 `folders` rows               |
| Raindrop tag registry        | D1 `tags` and `bookmark_tags`                    |
| Registry resynchronization   | Not needed                                       |
| 15-minute discovery Cron     | Immediate job creation when a bookmark is stored |
| Dispatch lease               | Not needed                                       |
| Lease revision               | Bookmark revision and job state                  |
| Raindrop rate-limit deferral | Provider-specific waiting state only             |
| KV operational documents     | Relational D1 state                              |
| Raindrop search through MCP  | D1/FTS search                                    |
| Raindrop onboarding reset    | Personal setup plus optional CSV import          |

The active implementation entry point is verified. Remove remaining legacy source files only as a
separate housekeeping change after confirming no release tooling references
them.

---

## 3. Authoritative state

### D1

D1 owns:

- Bookmarks.
- Tags and bookmark-tag associations.
- Fixed folders.
- Related-bookmark relationships.
- Favorite and Trash state.
- Setup and personalization.
- AI jobs and provider/model configuration.
- Import progress.
- Sessions.
- Encrypted provider settings.
- Capture and MCP credential hashes.
- Thumbnail metadata.

### Workers KV

Workers KV owns:

- One optimized thumbnail value per bookmark when available.

It does not own:

- Bookmark text.
- Provider credentials.
- Import files.
- Public image URLs.

### Queue

The Queue owns no durable application truth. It carries:

```json
{
  "version": 1,
  "jobId": "..."
}
```

If a message is duplicated, delayed, or retried, the consumer asks D1 whether the job is still eligible.

### AI provider

The provider supplies a proposal and may include usage metadata in its response.
Neither is authoritative: application code validates the proposal and does not
persist provider token or neuron usage.

---

## 4. Request entry points

There are four authorization lanes.

### Dashboard lane

- Secure HTTP-only session cookie.
- Same-origin validation.
- CSRF token on mutations.
- Full single-user administration privileges.

### Browser-extension lane

- Scoped bearer token.
- Can fetch fixed folders and tag suggestions.
- Can search a bounded projection of active bookmarks.
- Can create the active-tab bookmark and relate it to the selected existing bookmark.
- Can inspect only the result of its own request.

### iOS Shortcut lane

- Separate minimal bearer token.
- Can create one URL in Unsorted.
- Cannot send tags, notes, folders, favorite, or Linked to.

### MCP lane

- Separate opaque path credential.
- Read-only tools.
- Cannot mutate the library or control AI.

Never let credentials cross lanes. In particular:

- The extension and Shortcut do not receive the Later Gator password.
- MCP does not receive a dashboard session.
- A dashboard cookie does not authorize capture routes.
- A capture bearer cannot call MCP.

---

## 5. Deployment and first login

The user presses **Deploy to Cloudflare** and enters one blank secret labelled
**Later Gator password**. It must be non-empty. The interface recommends a
strong password but does not reject an existing deployment password merely
because it is shorter than 10 characters.

The form also asks for the Vectorize index **Dimensions** (`1024`) and **Metric**
(`cosine`). The Wrangler config schema sets `additionalProperties: false` on the
`vectorize` block, so a template cannot pre-fill them
(`cloudflare/workers-sdk#14075`). The values are therefore carried in the
`cloudflare.bindings.VECTORS` description in `package.json`, which the deploy
form renders beside those fields, and repeated in the README install steps. If
the embedding model in `src/v6/application/embeddings.ts` ever changes, update
the dimensions in all three places together.

Cloudflare provisions:

- Worker and static assets.
- D1.
- Workers KV.
- Queue.
- Workers AI.
- Vectorize.

The user opens the root URL.

```mermaid
flowchart TD
    ROOT["GET /"] --> AUTH{"Authenticated?"}
    AUTH -->|No| LOGIN["Login page"]
    AUTH -->|Yes| SETUP{"Setup complete?"}
    SETUP -->|No| S["/setup"]
    SETUP -->|Yes| D["/dashboard"]
```

The user never needs to append `/setup`.

### Password initialization

The deployment password is a bootstrap input. On first valid login, the application:

1. Generates a random data-encryption key.
2. Derives a wrapping key with PBKDF2-SHA256 at the hosted Workers maximum of 100,000 iterations.
3. Encrypts the data-encryption key.
4. Stores the wrapped key and KDF parameters in D1.

Provider keys are encrypted with the data-encryption key.

Changing the password rewraps the same data-encryption key and revokes sessions. It does not have to decrypt and rewrite every provider credential.

Both dashboard-key wrapping and background provider-credential encryption use
the same hosted-compatible iteration constant. If a stored KDF configuration is
unsupported, login fails closed with a controlled 503 response; it must never
fall through to Cloudflare Error 1101.

There is no application-side forgotten-password recovery that can decrypt provider keys. The user must protect the Later Gator password and keep a library export.

---

## 6. Setup

Setup is product personalization, not Raindrop onboarding.

Required:

- At least five relevant tags.
- Career context.
- Aspiration context.

Optional:

- Personal AI instructions.
- Raindrop CSV import.

MCP is configured later from Settings and is not part of setup.

Completing setup seeds:

- Fixed folders.
- Starting tags.
- Profile context.
- Initial provider configuration.

It does not:

- Connect to Raindrop.
- Delete or modify Raindrop data.
- Start an import unless the user submits a CSV file.

---

## 7. Bookmark creation

Every capture surface eventually calls the same application use case with a different authorization policy.

### Normal flow

```mermaid
sequenceDiagram
    participant C as Client
    participant W as Worker
    participant D as D1
    participant Q as Queue

    C->>W: Create bookmark
    W->>W: Validate and normalize URL
    W->>D: Insert bookmark and pending job
    D-->>W: Committed
    W->>Q: Send job ID
    Q-->>W: Accepted
    W-->>C: Saved
```

The client receives **Saved** only after D1 commits.

### Queue-send failure

D1 and Queue cannot participate in one atomic transaction.

If the bookmark commits but Queue send fails:

- Bookmark is still saved.
- Job remains `pending_dispatch`.
- Response says automation is pending.
- The UI offers a retry.

Never roll back a safely stored bookmark merely because background organization could not start.

### Duplicate URL

Normalized URL is the default identity.

A duplicate:

- Returns the existing bookmark.
- Is a successful **Already saved** result for capture surfaces.
- Does not create a second AI job.

---

## 8. Source URL and Linked to

These fields represent two bookmarks.

Example:

- Source URL: an X post.
- Linked to: the article referenced by the post.

Later Gator:

1. Saves or reuses the X bookmark.
2. Saves or reuses the article bookmark.
3. Creates one bidirectional related-bookmark relationship.

It does not replace the X URL with the article URL.

Relationships are stored once using canonical bookmark-ID order. The UI renders them in both directions.

Deleting one bookmark does not delete the related bookmark.

---

## 9. Why there is still a Queue

The Queue is not used to discover work.

It is used so that:

- The browser can close.
- Imports can continue.
- A temporary provider problem can retry.
- AI runs one bookmark at a time.

Consumer configuration is one message and one concurrent invocation.

There are no dispatch leases because D1 already knows:

- Which job exists.
- Which bookmark it belongs to.
- Whether it is pending, running, paused, complete, or cancelled.
- Which bookmark revision it was created for.

The Queue can deliver the same job more than once. Only one delivery can transition an eligible D1 job to `running`.

---

## 10. Bookmark revision safety

Every bookmark has a monotonically increasing `revision`.

An AI job records `expected_revision`.

Before saving AI output:

```text
current bookmark revision == expected revision
AND job is still running
AND owner pause is inactive
AND organization generation still matches
```

If the revision or generation changed, the AI result is stale and is discarded.
The same job is refreshed against the current bookmark rather than cancelled
while leaving the bookmark pending.

This is the central protection for simultaneous user and AI activity.

### Example race

1. AI begins processing revision 4.
2. User changes the note and folder, producing revision 5.
3. AI returns a proposal for revision 4.
4. Conditional apply fails.
5. Revision 5 remains untouched.
6. A new job is created only if revision 5 still needs organization.

No time-based lease is involved.

---

## 11. Bookmark details and editing

Clicking a card opens a non-mutating details modal with its description, note,
tags, dates, folder, relationships, thumbnail, and an explicit external-link
action. The user can open the editor for that bookmark from the modal.

There is no library-wide edit mode. Editing one bookmark does not pause other AI
jobs. Every PATCH carries `expectedRevision`; a concurrent AI commit produces a
revision conflict, while a user edit that commits first causes the stale AI
proposal to be rejected and the job to refresh against the current revision.

An expired browser session clears stale cookies and redirects to login. It
cannot leave automation globally paused because bookmark editing owns no global
automation state.

---

## 12. AI organization pipeline

For each eligible bookmark:

1. Load current bookmark and revision.
2. Resolve safe metadata and a thumbnail candidate.
3. Objectively require at least one primary content field beyond a title, URL,
   hostname, author, engagement count, thumbnail, or link-only placeholder.
4. If primary content is absent, skip AI and record an insufficient-evidence
   attempt. Otherwise let AI decide whether the retrieved content is meaningful
   enough or is generic/ambiguous.
5. Build the provider-neutral organization input.
6. Call the selected provider.
7. Validate either an `organized` or `insufficient_evidence` result. An
   insufficient result cannot contain a generated description or tags.
8. Retry retrieval once after the first insufficient result from either the
   Worker gate or AI. A second completed insufficient result moves the bookmark
   to Need for Review.
9. Ignore provider usage metadata for product accounting; do not persist token
   or neuron usage.
10. Normalize tags for an organized result.
11. Apply deterministic folder rules.
12. Recheck revision and application state.
13. Commit the valid result.

The proposal contains:

- Status.
- Description.
- Tags.
- Folder.
- Confidence.
- Review reason.

### Deterministic code remains in charge

The model may suggest a folder, but deterministic rules handle obvious cases:

- GitHub-like code hosts → Code.
- YouTube-like sites → Videos & Talks.
- arXiv/direct papers → Papers.
- Documentation sites → Docs & Reference.
- X and Twitter → Social Posts through a deterministic hostname override.
- Reddit and LinkedIn → Social Posts.

The model may suggest tags, but code:

- Normalizes them.
- Removes duplicates.
- Rejects operational/folder terms.
- Blocks retired tags.

---

## 13. Structured output and invalid responses

All providers should use their supported structured-output feature when the selected model supports it.

That is not the final validation boundary.

The adapter returns `unknown`. The shared Zod schema validates it again because:

- A provider may refuse.
- Output may hit the maximum token limit.
- A model may not support the requested schema.
- API behavior may change.
- Semantic constraints can still fail even when JSON shape is valid.

Failure sequence:

1. One corrective request may run in the same processing attempt.
2. If still invalid, increment quality attempts.
3. Retry later within a bounded limit.
4. Move to Need for Review after the quality limit.

Queue retries do not increment quality attempts.

Insufficient evidence uses one bounded lifecycle across both layers. Objective
absence of primary content records `content_unavailable`; a valid AI abstention
records `ai_insufficient_evidence`. The first code retries retrieval later. If
the next completed attempt produces either code, the bookmark moves to Need for
Review without applying a description or tags. A timeout or failed Queue
delivery is not a completed content attempt.

---

## 14. Temporary provider failures

Temporary means the same request may work later without changing configuration.

Examples:

- Timeout.
- HTTP 429.
- HTTP 5xx.
- Workers AI daily free allocation exhausted.

The bookmark:

- Remains stored.
- Keeps its existing content.
- Stays pending or waiting.
- Does not accumulate an AI-quality failure.

If the provider supplies a short retry time, the Queue message retries with delay.

If the condition requires owner action—invalid key, billing disabled, inaccessible model—it is not temporary. The application pauses new AI work and directs the user to Settings.

---

## 15. Usage presentation

Later Gator does not store token or neuron usage for Workers AI, OpenAI, or Anthropic.

The dashboard presents account-wide Workers AI usage through Cloudflare's authoritative dashboard. If Cloudflare does not expose an authoritative account-wide neuron total to the Worker, the application says so and provides the dashboard link. It never substitutes a local counter, per-request metadata, or a character-based estimate.

Never show a calculated account balance or invoice as authoritative.

---

## 16. Tags

Tags live in D1, so there is no registry resynchronization.

The setup topics seed useful starting interests only. The organizer prompt treats
the active registry as open: it reuses an accurate tag or inserts a new
`created_by = 'ai'` tag for a missing subject. The Library sidebar shows the
eight most-used topics; **View all** opens the full filter/delete vocabulary in
a modal. Settings does not own tag vocabulary management.

There is no 20-topic or global vocabulary ceiling. Normalization applies
canonical aliases for known equivalents, and the organizer prompt requires reuse
of canonical registry wording rather than synonym or abbreviation duplicates.

Setup's custom topic field tokenizes comma-separated values live. All tag entry
paths—setup, AI, CSV, dashboard edits, capture, and MCP-adjacent repository
calls—canonicalize values to lowercase single words or lowercase hyphenated
words. Bootstrap performs an idempotent set-based merge of legacy equivalent
tags before returning the registry.

The bookmark editor and browser extension use the same `#` autocomplete
contract: existing results render as `#tag`, a missing normalized value renders
as `Create #tag`, and neither menu adds “Existing tag” or “New tag” helper
labels. Selected values render as removable chips.

### Add/remove on one bookmark

Update `bookmark_tags` and usage count in the same transaction.

### Delete globally

Global deletion:

1. Shows affected bookmark count.
2. Removes all associations.
3. Marks the tag retired.
4. Leaves bookmarks in place.
5. Increments affected bookmark revisions.

The retired row is intentionally retained. It tells future AI output not to recreate the tag.

Explicit restore makes the tag active again but does not automatically reattach it.

---

## 17. Folders

Folders are seeded database rows.

Permanent destinations:

- Social Posts
- Articles
- Videos & Talks
- Code
- Docs & Reference
- Papers
- Websites & Apps
- Need for Review

System views:

- Unsorted
- Imports as a hidden compatibility row; new CSV imports go to Unsorted
- Trash
- All Bookmarks

API routes reject rename/delete even if a malicious client bypasses disabled UI controls.

Trash is represented by `deleted_at`. It is not a folder that AI can select.

---

## 18. Thumbnails

Thumbnail priority:

1. User or extension preview candidate.
2. Server-resolved page image metadata.
3. Declared page icon or conventional favicon.
4. Built-in placeholder.

The bookmark save never depends on thumbnail success.

### Safe image fetch

Remote images are untrusted:

- HTTP/HTTPS only.
- No private, loopback, link-local, reserved, or metadata-service destination.
- Recheck redirects.
- Enforce timeout, redirect count, byte limit, media type, and magic bytes.
- Do not forward cookies or authorization.
- Use the shared browser-compatible public-page headers for HTML and image
  discovery; do not add site-specific YouTube or social-network branches.
- Reject SVG in the initial release.

### Storage

- Normalize to an uncropped WebP bounded by 960 × 1,600 pixels and 500 KiB.
- Write the private bytes under an immutable Workers KV key.
- Store object key and metadata in D1.
- Serve through an authenticated, versioned Worker route using one-year
  `private, immutable` browser caching.

Workers KV is never made public.

If Workers KV is unavailable or full, save the bookmark without a thumbnail.

---

## 19. Raindrop CSV import

Raindrop is not connected at runtime.

The supplied representative CSV fields are:

```text
id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite
```

Single-folder or collection exports omit `folder`; both layouts are accepted.

Mapping:

| CSV field | Treatment                                      |
| --------- | ---------------------------------------------- |
| `url`     | Required; normalized for duplicate identity    |
| `title`   | Optional; falls back to the URL hostname       |
| `tags` | Normalized and retained only in preserve mode |
| `excerpt` | Retained as description only in preserve mode |
| all other fields | Ignored and not stored                  |

### Direct import

Submitting the file starts the import immediately. There is no preview,
separate commit, or resume action. Setup and Settings both require one explicit
mode: reorganize everything, or preserve imported tags and descriptions while
AI assigns only the permanent folder.

The Worker:

- Parses quoted commas, multiline cells, Unicode, and both common Raindrop
  export layouts.
- Performs only the minimum safe checks needed to read valid HTTP(S) URLs.
- Keeps the first occurrence of a normalized URL inside the file.
- Inserts rows into Unsorted in chunks using D1's active-URL uniqueness as the
  final duplicate guard.
- In preserve mode, normalizes `tags` and retains `excerpt` as description; in
  reorganize mode, both are discarded.
- Updates processed, added, duplicate, and invalid counts after every chunk so
  the dashboard can show real progress.
- Creates one recoverable AI job and one independent thumbnail job for each
  newly inserted Unsorted bookmark.
- Commits both job records before signaling their separate Queue consumers.
- Does not pause AI or the library, import notes, favorites, folders, or
  Raindrop covers, or perform remote fetches inside the import request.

Only bookmarks currently in Unsorted may be processed by AI. X/Twitter routing
is applied when such a job successfully commits, never during import or
bootstrap. Moving a pending bookmark to a permanent folder cancels its AI job.

If an import is interrupted, upload the same CSV again. Existing normalized
URLs are skipped, so this safely fills only bookmarks that were not inserted by
the earlier attempt.

---

## 20. Browser extension

Chrome and Firefox share one WebExtension codebase.

Popup fields:

- Thumbnail/title/description preview.
- Note.
- Folder.
- Tags, enabled for permanent folders with `#` existing-or-create completion.
- Linked to, enabled for permanent folders as an existing-bookmark search.
- Favorite.
- Save.

The source URL is always the active tab URL and is not an editable field.
Unsorted disables and clears Tags and Linked to. The Worker enforces the same
rule even if a client bypasses the popup. Linked to search calls
`POST /api/capture/bookmark-search` after at least two characters and receives
only active bookmark ID, title, URL, hostname, and folder name.

Use minimal permissions:

- `activeTab`
- extension storage
- temporary scripting only to read the current page's metadata
- access to the configured Later Gator host

Do not request browsing-history permission.

On popup startup, keep both primary forms hidden while the stored capture
credential is checked against `GET /api/capture/options`. Show only the capture
form after a successful check. Missing, malformed, rejected, or permission-less
credentials show only the connection form. Preserve a credential through
temporary network and deployment failures and offer Retry. Test a newly entered
credential before saving it to extension-local storage.

Settings combines `location.origin` and the newly issued extension token into a
single `later-gator-v1.` connection code. Keep the code out of links, query
parameters, logs, and browser navigation. Present it once with an explicit Copy
action. The extension decodes one pasted value, validates its version and
fields, requests host permission, and tests the credential before storing the
decoded connection. Encoding does not make the code non-secret.

Chrome and Firefox self-install instructions open in the Settings-page dialog,
not a new tab. Keep browser-specific steps in that dialog synchronized with the
actual `extension/chrome` and `extension/firefox` folders.

The normal capture form has no full-size Connection action. A compact settings
control may open the connection form deliberately, with Cancel available while
the existing credential remains valid. Capture credentials have no automatic
expiry; revocation and application reset are the server-side invalidation paths,
while lost extension storage or host permission requires local reconnection.

### Save feedback

Render the server's committed result:

- Saved.
- Already saved.
- Saved and linked.
- Source saved; automation pending.
- Source saved; link failed.
- Failed.

Do not infer success from a completed `fetch` alone. Parse and validate the application response.
After a confirmed result, hide the capture form and header and render the full
success panel with the exact outcome, dashboard link, and Done action. Options
validation and active-tab metadata retrieval run concurrently; Linked to search
does not run until the user types at least two characters.

The popup also POSTs the active URL to `/api/capture/bookmark-status`. A live
normalized-URL match renders **Already saved** immediately and sets a per-tab
tick badge; a new page clears the badge. A status-only failure degrades to the
capture form and never invalidates an otherwise working connection.
The background script repeats this check for the active tab on navigation and
activation. The required `tabs` permission is used only to read that current URL;
do not persist it or scan inactive browsing history.

---

## 21. iOS Share Sheet Shortcut

The Shortcut sends:

- Request ID.
- One shared HTTP/HTTPS URL.

It cannot send:

- Note.
- Tags.
- Folder.
- Favorite.
- Linked to.

The server always stores a new valid URL in Unsorted and creates an organization job.

The Shortcut shows:

- **Saved to Later Gator**
- **Already saved in Later Gator**
- **Failed to save to Later Gator**

There is no offline queue in v6. A timeout is failure, not “probably saved.”

Settings reveals the Shortcut endpoint and token once with separate Copy
actions. **Create in Shortcuts** opens `shortcuts://create-shortcut`; Apple's URL
scheme opens an empty editor and cannot prefill actions. The setup tutorial
therefore lists the required actions in a Settings-page dialog. Do not advertise
this as one-tap installation until the project has an Apple-validated iCloud
Shortcut link with endpoint and token import questions.

---

## 22. MCP

MCP is a stateless read-only view over D1.

Use current `createMcpHandler` with Streamable HTTP.

Do not use the deprecated stateful `McpAgent` path; Later Gator does not need MCP session memory.

Tools:

- `get_context`
- `search_bookmarks`
- `get_bookmark`
- `get_library_status`

MCP cannot mutate or resume anything.

Search excludes Trash and respects output limits.

Rotating the MCP URL invalidates the old credential without affecting capture tokens or dashboard sessions.
The rotated URL is shown once with a Copy action. Its setup tutorial opens in a
Settings dialog. D1 retains only the secret hash, so an old URL cannot be
recovered for reuse.

---

## 23. Search and filtering

Search combines:

- D1 FTS5 for text.
- Indexed SQL filters for folder, tag, site, dates, favorite, AI state, and thumbnail state.
- Keyset pagination.

Date added descending is the default. The dashboard loads 48 results at a time,
shows `loaded of total`, and follows the validated next cursor. Bootstrap
returns grouped non-trashed counts beside every fixed folder and a separate
Trash count.

In selection mode, **Select all** snapshots the current folder, search, sort,
and filter query, then follows every validated cursor page to select all
matching bookmark IDs. It is not limited to the 48 cards currently rendered.

Text search is hybrid. A query matches when FTS5 matches, when every term
matches an active tag name, or when the query embedding is semantically close to
the bookmark embedding held in Vectorize. Embeddings come from
`@cf/baai/bge-large-en-v1.5` (1024 dimensions, cosine); queries carry the bge
retrieval prefix and documents do not. Matches are gated at
`max(0.3, 0.85 × top score)`. `bookmarks.embedded_revision` marks stale rows and
an `embed_pending` Queue message drains the backlog. Every semantic failure
degrades to lexical results; search never fails because embeddings are missing.

The dashboard translates `#` input into a dynamic tag picker and sends selected
tags as structured filters. A bare `#` returns every active tag; typed text
narrows the complete registry rather than a fixed top-eight slice. Sort order,
site, dates, and favorite state live in one modal rather than a row of
always-visible controls.

Settings polls bootstrap while visible and renders actual D1 state counts:
organized, waiting, processing, provider wait, owner pause, review, and failed.
Bootstrap also repairs legacy `paused_edit`, stale queued/running work older than
the recovery window, and pending bookmarks that have no active job. Independent
dispatcher notifications resume AI/background and thumbnail work from their D1
pending records.

Never concatenate a user-supplied sort column or FTS expression.

Map allowlisted sort names to known SQL fragments in code.

Supported sorts:

- Date added.
- Date modified.
- Date created.
- Site.
- Title.

---

## 24. Failure states developers should recognize

| State              | Meaning                                         | Developer action                      |
| ------------------ | ----------------------------------------------- | ------------------------------------- |
| `pending_dispatch` | Bookmark stored; Queue send did not succeed     | Redispatch idempotently               |
| `queued`           | Queue accepted job                              | Wait for consumer                     |
| `running`          | Consumer owns current attempt                   | Inspect safe event trail              |
| `waiting_provider` | Provider temporarily unavailable                | Wait, switch, or explicit retry       |
| `paused_edit`      | Legacy state from a pre-removal deployment      | Bootstrap recovery converts it        |
| `paused_owner`     | User explicitly paused AI                       | Do nothing until resume               |
| `review`           | AI quality attempts exhausted or low confidence | User reviews bookmark                 |
| `cancelled`        | Terminal historical job                         | Pending bookmarks get a replacement   |
| `completed`        | Organization committed                          | No action                             |
| `failed`           | Non-recoverable internal job failure            | Diagnose systemic invariant           |

There is no generic “deferral time” product concept. Waiting is attached to a job/provider and has a concrete reason.

---

## 25. Logging and privacy

Allowed in logs:

- Request/event name.
- Opaque bookmark/job/import ID.
- Provider/model.
- Safe status/error code.
- Duration and attempt.

Forbidden:

- Full URL.
- Title.
- Description.
- Note.
- Tag names.
- CSV contents.
- Prompt or model output.
- Thumbnail source URL.
- Any credential or token.

When debugging locally, resist logging the whole request or provider response. Add a redacted event with the one field needed to understand the branch.

---

## 26. Local development

Repository commands:

```bash
npm run types
npm run typecheck
npm run lint
npm test
npm run check
npm run build
```

Expected workflow:

1. Read the consolidated Product Requirements and Technical Design.
2. Create or update a numbered D1 migration.
3. Implement domain rule and Zod schema.
4. Implement adapter/repository behavior.
5. Implement application use case.
6. Add route/UI translation.
7. Add regression and fault-injection tests.
8. Run the complete check gate.

Use generated `Env` types. Never hand-write a partial binding interface.

### Local resources

Use local Wrangler persistence for:

- D1.
- Workers KV.
- Queue.

Provider calls should default to fakes or recorded redacted fixtures. Live provider tests require explicit opt-in.

Never point local development at production D1 or Workers KV by default.

---

## 27. D1 development rules

- Use prepared statements.
- Keep SQL in the D1 adapter/repository boundary.
- Return typed rows and validate them.
- Use `batch()` for multi-statement atomic changes.
- Add indexes with the query that needs them.
- Inspect D1 `meta.rows_read` and `meta.rows_written` in performance tests.
- Never edit an applied migration.
- Test foreign-key behavior.

Any bookmark mutation that changes user-visible state must increment `revision`.

Any tag-association change must update usage count in the same transaction.

---

## 28. Queue development rules

- Message contains job ID only.
- Batch size one.
- Concurrency one.
- Load authoritative state from D1.
- Transition state conditionally.
- Acknowledge terminal or missing jobs.
- Distinguish transport retry from AI-quality retry.
- Never rely on one-time delivery.
- Never place bookmark content or secrets in the message.

If you add a new background job type, prove why it belongs in the same sequential lane. Do not casually add parallel consumers that can race on bookmark or vocabulary state.

---

## 29. Provider adapter rules

Every adapter must:

- Validate configuration.
- Use a bounded timeout.
- Request structured output when supported.
- Return proposal as `unknown`.
- Tolerate provider usage metadata without persisting or presenting it as
  Later Gator usage.
- Convert provider errors to the shared safe taxonomy.
- Never log request/response bodies.
- Expose a synthetic connection test.

Connection test uses synthetic content, not a real bookmark.

Provider activation happens only after the candidate passes.

---

## 30. Thumbnail development rules

- Treat remote URLs and bytes as hostile.
- Do not store the remote URL as the serving URL.
- Do not make Workers KV public.
- Put object before referencing it in D1.
- Clean up orphaned objects.
- Keep thumbnail failure independent of bookmark success.
- Keep thumbnail messages on `THUMBNAIL_QUEUE`; never route them through the
  sequential AI/background consumer.
- Treat the thumbnail UUID in `/api/thumbnails/:bookmarkId/:thumbnailId` as the
  immutable browser-cache version.
- Measure normalized size.

Browser Rendering is not bound in the current deployment. Thumbnail candidates
come from capture input, bounded page metadata, declared icons, conventional
favicons, and the built-in placeholder. Thumbnail jobs retry and recover
independently from AI organization jobs.

---

## 31. Extension development

The extension is a separate client of the capture API.

Test:

- Chrome and Firefox manifests.
- Internal active-tab URL capture with no editable Source URL field.
- Metadata permission failure.
- Missing/expired/revoked token.
- Duplicate clicks.
- Popup closing after commit.
- Unsorted organization controls disabled and server-side values discarded.
- Permanent-folder `#` tag selection and creation.
- Existing-bookmark search and Linked to selection.
- Partial automation result.

Do not import dashboard code that assumes cookie authentication into the extension client.

---

## 32. Shortcut development

Keep the Shortcut endpoint deliberately small.

The request schema must reject extra bookmark fields. This is not only a UI convention; it prevents an exposed Shortcut token from becoming a general mutation credential.

Test response wording and status on:

- New URL.
- Duplicate URL.
- Invalid URL.
- Revoked token.
- Worker unavailable.
- Timeout.

---

## 33. MCP development

Create a fresh server per request.

Each tool:

- Has a strict input schema.
- Uses application query services rather than direct ad hoc SQL.
- Has result and pagination limits.
- Returns stable safe fields.
- Excludes Trash.
- Emits redacted timing/outcome events.

MCP tool descriptions must state their return shape and errors clearly enough for clients to call them reliably.

---

## 34. Testing expectations

Every behavior change receives a regression test.

High-risk changes also require fault injection:

- Bookmark commit versus Queue send.
- AI response versus user edit.
- Workers KV put versus D1 thumbnail reference.
- Import chunk interruption.
- Password rewrap.
- Provider activation.

The essential invariants are:

1. Stored bookmarks are not silently lost.
2. User edits win over stale AI work.
3. Duplicate delivery is harmless.
4. Thumbnail failure does not fail bookmark creation.
5. Secrets never cross authorization lanes.
6. Provider output never bypasses validation.
7. Retired tags are not recreated silently.

---

## 35. Free-tier thinking

The free tier is an operating envelope, not business logic.

Do not create a local fake limit that blocks work before Cloudflare does.

Measure:

- D1 rows read and written.
- D1 storage.
- Workers KV bytes and operations.
- Queue operations.
- Workers requests.
- AI job counts, durations, success states, and provider-wait states without
  storing token or neuron usage.
- Account-wide Workers AI usage only through Cloudflare's authoritative
  dashboard entry point.

Graceful degradation:

- No Workers KV capacity → save without thumbnail.
- No AI capacity → keep library usable and job waiting.
- Queue send failure → save bookmark and expose pending dispatch.
- D1 mutation limit → protect existing data and explain read-only behavior.

---

## 36. Common debugging paths

### Bookmark says automation pending

Check:

1. `background_jobs.state`.
2. Whether Queue send was recorded.
3. Owner pause.
4. Provider configuration.

Do not create a second bookmark.

### AI result disappeared

Check the revision and organization generation. A discarded stale result is
expected when the bookmark changed. The job should immediately become
retryable; a pending bookmark without an active job is repaired on bootstrap.

### Tag returned after deletion

This is a bug. Confirm:

- Tag row remains `retired`.
- Prompt includes retired prohibition.
- Normalization resolves the proposed spelling to the retired normalized name.
- Apply path rejects it.

### Thumbnail missing

Check safe outcome codes:

- no candidate
- unsafe destination
- timeout
- too large
- unsupported type
- transformation failed
- Workers KV limit/unavailable

Do not inspect or log the full source URL in production.

### Queue message repeated

Expected under at-least-once delivery. The D1 conditional state transition should make it harmless.

### Workers AI usage is unavailable

If Cloudflare does not expose authoritative account-wide usage to the Worker,
show the Cloudflare dashboard link and **unavailable**. Do not add a heuristic,
local counter, or per-request reconstruction.

### MCP cannot find a bookmark

Check:

- Bookmark is not in Trash.
- FTS/index synchronization.
- Filters and cursor.
- MCP result limit.
- MCP credential validity.

MCP never queries Raindrop.

---

## 37. Migration discipline

During the Raindrop-to-D1 architecture replacement:

- Keep the current code understandable until its replacement exists.
- Do not mix Raindrop and D1 as co-authoritative sources.
- Do not add a “temporary sync” layer.
- Do not migrate KV operational records as bookmarks.
- Do not update README installation claims ahead of deployed behavior.
- Do not test against a production Raindrop library.

The supported migration path for user content is the CSV importer.

---

## 38. Definition of done for a current feature

A feature is complete when:

- Product behavior matches the consolidated Product Requirements.
- Technical behavior matches the consolidated Technical Design.
- External inputs have Zod validation.
- D1 migration and indexes exist.
- Authorization and CSRF/scope rules are enforced.
- Redacted observability exists.
- Regression tests pass.
- Relevant fault injection passes.
- Free-tier operations are measured where material.
- User-facing success is based on committed state.
- Documentation describes what is actually implemented.

---

## 39. Source documents

- [Product Requirements](product-requirements.md)
- [Technical Design](technical-design.md)
- [Cloudflare D1 documentation](https://developers.cloudflare.com/d1/)
- [Cloudflare Workers KV documentation](https://developers.cloudflare.com/kv/)
- [Cloudflare Queues documentation](https://developers.cloudflare.com/queues/)
- [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Cloudflare stateless MCP handler](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
- [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses)
- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create)

Revalidate provider APIs, model support, Wrangler configuration, and Cloudflare limits before implementation and release.
