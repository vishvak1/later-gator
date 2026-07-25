# Later Gator — Product Requirements Document v5.4

**Product:** Raindrop AI Automation  
**Status:** Implementation-ready, subject to final live integration checks  
**Supersedes:** PRD v5.3  
**Revision focus:** In-app credential management and simplified Raindrop onboarding  

---

## 1. Overview

Later Gator is an AI-powered organization and retrieval layer built on top of Raindrop.io.

It automatically organizes bookmarks saved to Raindrop's Unsorted collection and lets a user search their library in natural language from an MCP-capable client such as ChatGPT or Claude. It does not require a dedicated bookmark or search frontend. A minimal browser-based setup and administration surface is allowed.

### Product philosophy

- The LLM supplies semantic judgment.
- The Cloudflare Worker supplies deterministic execution.
- Raindrop remains the source of truth.
- Setup and migrations are explicit; ordinary connections never trigger them.
- Provider and Raindrop credentials are entered and managed in the authenticated Later Gator setup/settings page.
- Cloudflare Workers AI is the zero-extra-key default, not a lock-in requirement.
- Installation should be achievable from the repository README without cloning the repository or using Wrangler locally.

---

## 2. Goals

### Primary goals

- Automatically organize bookmarks that land in Unsorted.
- Generate specific, retrieval-friendly descriptions.
- Reuse a coherent tag vocabulary instead of creating tag sprawl.
- File bookmarks into a stable source-type folder taxonomy.
- Improve long-term searchability without duplicating the library.

### Secondary goals

- Support natural-language retrieval through MCP.
- Avoid a custom frontend.
- Keep infrastructure minimal and single-tenant.
- Keep the default single-user path within the Cloudflare and Raindrop free tiers without requiring a credit card.
- Work correctly from a cold start with zero bookmarks.
- Provide safe, repeatable setup for both fresh and existing libraries.
- Offer a Deploy to Cloudflare path from the public GitHub repository.
- Let the user choose a supported external LLM by providing their own API key, at installation or later.

### Success criteria

- An idle automation run makes no LLM call and no unnecessary KV write.
- A processed bookmark leaves Unsorted and is not processed again.
- Onboarding never begins without an explicit user action.
- Existing-account onboarding is limited to moving bookmarks to Unsorted, clearing tags, deleting emptied user folders, and installing the Later Gator seed folders and tag registry.
- The configured organization provider returns a valid live test response before it is activated.
- The user may choose Workers AI, OpenAI, or Anthropic during first setup before onboarding.
- A Cron discovery can dispatch up to 10 pending bookmarks, and queued items need not wait for another 15-minute tick between each other.
- Email readiness is explicit, and any user-controlled recipient can be used after Cloudflare destination verification.
- Search responses are always structured and include the true result count.
- The README is sufficient for installation and links directly to the deployment and setup flows.
- Changing the organization-model provider does not rerun Raindrop onboarding or alter existing bookmarks.

---

## 3. Architecture

### Automation path

1. A Cloudflare Cron Trigger invokes the Worker.
2. The Worker verifies that onboarding is complete and the pipeline is not paused.
3. It reads a bounded group of bookmarks from Unsorted and sends their IDs to a Cloudflare Queue, excluding IDs that already have a live dispatch lease.
4. The queue delivers one bookmark message at a time to the same Worker, with consumer concurrency limited to one.
5. The consumer rechecks lifecycle state, the dispatch lease, and that the bookmark is still in Unsorted.
6. It reads the latest tag registry, resolves deterministic content and routing information, and calls the configured LLM once.
7. It validates and normalizes the response, updates the bookmark in Raindrop, and moves it out of Unsorted.
8. It writes changed registry and operational state and acknowledges the message.

The 15-minute Cron cadence controls how quickly new work is discovered; it does not limit processing to one bookmark every 15 minutes. Once IDs are queued, the consumer processes them promptly and sequentially, subject to Raindrop and model free-tier budgets.

### Search path

1. The user asks a question in an MCP-capable client.
2. The client model calls Later Gator's MCP tools.
3. The Worker queries Raindrop and returns structured JSON.
4. The client model ranks, interprets, and phrases the answer.

The backend does not make an LLM call during search.

### Responsibilities

| Component | Responsible for | Not responsible for |
|---|---|---|
| Cloudflare Worker | Raindrop API calls, lifecycle guards, deterministic rules, content resolution, folder routing, state management, structured responses | Semantic understanding and relevance ranking |
| Organization LLM | Tag selection, retrieval-friendly descriptions, constrained fallback classification, confidence | Direct Raindrop access, persistence, migration control |
| Client LLM | Query interpretation, MCP tool selection, ranking, conversational response | Bookmark persistence |
| Raindrop | Bookmark storage, collections, tags, metadata, native exports | Later Gator operational state |
| KV | Small operational state, dispatch leases, and caches | Bookmark bodies, a backup archive, embeddings, a search index |
| Cloudflare Queue | Short-lived bookmark-ID delivery and retry isolation | Bookmark content, permanent processing history, model decisions |

---

## 4. Installation, connection, and onboarding lifecycle

### 4.1 Three separate stages

Later Gator distinguishes:

1. **Deployment:** Cloudflare copies and builds the repository, provisions declared resources, binds them to the Worker, and collects required configuration.
2. **Installation validation:** Later Gator checks that required bindings, Raindrop credentials, and the selected organization-model provider are usable, and records the exact core-email readiness state. It performs no Raindrop mutation.
3. **Onboarding:** Later Gator checks whether the account is fresh or existing and, after the user starts onboarding, performs the corresponding seed or reset-and-seed flow.

The onboarding check is intentionally small: count bookmarks and user folders, then select the fresh or existing path.

### 4.2 Connection is not onboarding

Supplying or replacing a Raindrop token in the authenticated setup/settings page only connects the deployment to an account. It must not start onboarding, modify collections, or process bookmarks.

Onboarding starts only when the authenticated user selects the onboarding action. Cron and MCP search connections are ordinary runtime connections and never invoke onboarding.

The primary end-user setup path is the Worker-hosted setup page linked from the README and post-deployment instructions. After onboarding, the same authenticated surface becomes the permanent settings and status page. A local developer workflow may exist for maintainers, but users are not required to clone the repository, install dependencies, or run Wrangler.

### 4.3 Installation validation

Before onboarding is offered, the setup page checks:

1. The KV, Workers AI, and organization Queue bindings declared by the repository are available.
2. The Raindrop token succeeds against the authenticated-user endpoint.
3. The selected organization-model provider is configured and can return a small validated test response.
4. If an external provider is selected, the required API key has been entered in the setup/settings page, encrypted, stored, and can pass a live connection test.
5. The notification step records one user-chosen recipient and reports whether Cloudflare email prerequisites and a test message succeed.
6. The connected Raindrop user ID does not conflict with a previously onboarded account.

Validation failures explain the exact field that must be corrected. They do not mutate Raindrop.

### 4.3.1 Decisions made during first setup

Before onboarding, the setup wizard requires the user to make or confirm these choices:

1. **Organization provider:** choose Cloudflare Workers AI, OpenAI, or Anthropic. Workers AI is recommended and preselected, but the user may choose either external provider immediately rather than switching later.
2. **Model and provider key:** accept the README model recommendation or enter a model identifier. When OpenAI or Anthropic is selected, enter or replace its API key directly in the authenticated page before running the connection test.
3. **Instructions:** optionally add personal organization instructions; the protected default prompt remains active unless the advanced override is deliberately enabled.
4. **Notification recipient:** enter any email address the user controls. Cloudflare must verify that destination before Later Gator can send to it.
5. **Email readiness:** complete the Cloudflare routing-domain and binding checklist, run a test email, or explicitly continue in `email_unavailable` mode if no suitable domain exists.

Provider activation occurs before onboarding begins. A failed external-provider test leaves Workers AI selected and offers correction or an explicit return to the default; it never begins migration accidentally.

### 4.4 Lifecycle state

KV stores an `onboarding_state` object with the following status values:

| Status | Meaning | Runtime behavior |
|---|---|---|
| Missing or `not_started` | Deployment has not been initialized | Cron exits; mutation tools remain unavailable; setup is offered |
| `in_progress` | A confirmed onboarding run stopped between steps | Cron exits; setup may resume at the last completed step |
| `complete` | Deployment is initialized | Normal automation and MCP operation are allowed |

The state also records the selected mode, current step, start and completion timestamps, seed version, and connected account identity.

The system must never infer that onboarding is complete from the presence of familiar folder names. If KV state is lost or missing, the safe behavior is to block processing and require the user to run setup again. It must not silently migrate the account.

Changing credentials after onboarding does not automatically reset the state or onboard a different Raindrop account. The setup flow compares the connected Raindrop user ID with the ID recorded at onboarding. A mismatch blocks runtime activity until the user explicitly initializes the new account.

### 4.5 Mode selection

After credential verification, setup performs a small read-only inventory:

- **Mode A — Fresh account:** selected only when the connected account contains zero bookmarks and zero user folders.
- **Mode B — Existing account:** selected when the account contains any bookmark or user folder.

Mode selection is deterministic and displayed to the user before any write. Connecting a token does not start either mode.

### 4.6 Onboarding check

Every onboarding run performs this check:

1. Call Raindrop's user endpoint to verify the token and identify the account.
2. Count bookmarks and user folders using read-only calls.
3. Select Mode A or Mode B.
4. Show the applicable actions.
5. Wait for the user to select **Start onboarding** before making any write.

### 4.7 Mode A — Fresh account

1. Create the eight standard folders if they do not exist.
2. Initialize the versioned seed tag registry. Raindrop has no standalone empty-tag object, so seed tags become visible in Raindrop as they are applied during organization.
3. Store the folder ID map, connected Raindrop user ID, and seed version.
4. Mark `onboarding_state.status` as `complete`.

### 4.8 Mode B — Existing account

The user is told plainly:

> All bookmarks will be moved to Unsorted, all existing bookmark tags will be removed, and all existing user folders will be deleted after they are emptied. Later Gator's seed folders and tag registry will then be created, and the Unsorted pile will be organized gradually.

After the user selects **Start onboarding**:

1. Move every bookmark from every user folder directly into Unsorted.
2. Clear all tags from all bookmarks.
3. Verify the former user folders are empty, then delete them.
4. Create the eight standard Later Gator folders.
5. Initialize the versioned seed tag registry.
6. Store the folder ID map, connected Raindrop user ID, and seed version.
7. Mark onboarding complete.
8. Let routine Queue-backed processing sort the Unsorted pile over time; the user may also start the explicit faster backfill flow.

Trash is never used as an intermediate migration location.
Onboarding does not clear excerpts, rewrite notes, generate descriptions, or organize individual bookmarks. Those actions belong to the normal organization pipeline.

### 4.9 Resumability and repeat safety

- Each small step checks its postcondition before acting.
- `current_step` is written after each completed onboarding step.
- An interrupted run resumes from the first incomplete step.
- Opening setup against a completed deployment is a read-only status view unless the user explicitly selects a separate administrative action.
- Re-onboarding or resetting lifecycle state requires a separate explicit destructive administration action and confirmation.
- Cron remains blocked until all onboarding postconditions succeed.

### 4.10 Permanent setup and settings page

The authenticated `/setup` page changes presentation according to lifecycle state:

- Before onboarding, it is a step-by-step setup wizard with a visible checklist and no Raindrop writes until final confirmation.
- During onboarding or backfill, it is a progress and recovery page.
- After onboarding, it is the permanent Later Gator settings and status page.

It contains these sections:

| Section | User sees and can do |
|---|---|
| Overview | Overall state (`Running`, `Waiting`, `Paused`, or `Needs attention`), pending and leased counts, last successful item, last Cron discovery, next reset/retry time, today's Workers AI budget, and a plain-language current-action message |
| AI provider | Choose Workers AI, OpenAI, or Anthropic during first setup or later; enter or replace an external-provider API key, enter a model identifier, test a candidate, and activate it without interrupting the current item |
| Instructions | Edit personal instructions, preview the effective prompt summary, use an advanced full override behind a warning, see the active revision, and restore the shipped default |
| Raindrop | See connected account identity, token health, folder map, Unsorted count, and reconnect instructions; account changes never trigger onboarding automatically |
| Automation | Pause/resume, see Cron and Queue health, change the discovery batch limit within a documented safe range, start or stop explicit backfill, and see why work is deferred |
| Email notifications | Enter any recipient address the user controls, follow Cloudflare verification/domain steps, send a test, see readiness and last delivery outcome, and disable or reconfigure alerts |
| Search and MCP | Copy the MCP URL, view ChatGPT and Claude connection snippets, rotate the path secret, and test `get_context()` without exposing bookmark content |
| Folders and tags | View the managed folder taxonomy, registry size, highest-use tags, and seed version; v1 does not provide bulk tag editing or consolidation |
| Activity | View a small redacted history of runs, deferrals, item-review moves, provider changes, prompt changes, pauses, resumes, and alert outcomes |
| Maintenance | Replace Raindrop and provider keys, rebuild the tag registry, rerun the onboarding check, explicitly reset onboarding, and view uninstall instructions |

The page accepts Raindrop, OpenAI, and Anthropic credentials over HTTPS in authenticated, CSRF-protected forms. It never returns a stored credential to the browser: saved fields are shown only as configured or missing, and replacement fields are blank. Credentials are encrypted before KV storage using Web Crypto and key material derived from the deployment's installation secret; KV contains ciphertext, nonce, provider label, and schema version only. Rotating the installation secret invalidates stored credentials and requires the user to enter them again. Provider and prompt changes are captured at the start of an item and affect the next item only.

This page is an administration interface, not a replacement bookmark browser. Reading, browsing, and manual editing of bookmarks remain in Raindrop.

---

## 5. Feature 1 — Automatic organization

### 5.1 Trigger and early exits

Raindrop does not provide the required webhook, so a Cloudflare Cron Trigger runs every 15 minutes.

At the start of every run:

1. If the connected Raindrop user ID differs from the onboarded user ID, pause and exit.
2. If onboarding is not complete, exit.
3. If the pipeline pause flag is set, exit.
4. If the pipeline is deferred until a known rate-limit or free-budget reset, exit.
5. If Unsorted is empty, exit without calling the LLM or writing unchanged state.

Cost therefore follows bookmark volume, not cron frequency.

### 5.2 Queue model

Raindrop Unsorted remains the authoritative source of pending work. Cloudflare Queue is a short-lived delivery mechanism that separates discovery from processing and gives each bookmark its own free-tier Worker invocation.

- Cron discovers up to `DISPATCH_LIMIT` eligible Unsorted IDs; the initial value is 10.
- A compact KV dispatch-lease document prevents the same ID from being intentionally enqueued again while its lease is live.
- Queue messages contain only bookmark ID, Raindrop user ID, dispatch revision, and enqueue time—not bookmark content.
- The consumer uses `max_batch_size=1` and `max_concurrency=1` so model calls remain sequential and registry updates remain coherent.
- The consumer re-fetches the bookmark. If it is no longer in Unsorted, it acknowledges a harmless duplicate without an LLM call.
- A successfully processed bookmark moves out of Unsorted, clears its lease, and is not picked up again.
- An expired or lost Queue message is recoverable because Unsorted remains authoritative and a later Cron run can enqueue the ID again.

### 5.3 Batch behavior

- Discover and enqueue at most 10 bookmarks per scheduled invocation by default.
- Process one bookmark per Queue consumer invocation, then allow the Queue to deliver the next message immediately.
- Make one organization-model call per bookmark.
- Process bookmarks sequentially by setting consumer concurrency to one.
- Keep the dispatch limit configurable. Increasing it changes discovery throughput, not parallel LLM usage.

### 5.4 Registry threading

Within each Queue-consumed item:

1. Read the tag registry from KV once.
2. Snapshot it for comparison.
3. Give the model call the latest registry.
4. Merge accepted tags and usage changes only after the Raindrop update succeeds.
5. Write the registry once and only if it changed, then allow the next single-concurrency message to run.

Sequential processing is required because parallel calls would see the same starting vocabulary and increase duplicate tag creation.

### 5.5 Model response contract

```json
{
  "tags": [],
  "description": "",
  "folder": "",
  "confidence": "high | medium | low",
  "notes": null
}
```

The Worker validates this response against the application schema before any Raindrop write.

- `confidence: low` routes the item to Need for Review.
- An invalid or unknown folder is coerced to Websites & Apps after deterministic routing rules are attempted.
- An invalid response is retried according to failure policy; raw model text is never written to Raindrop.

### 5.6 Content preservation on write

Before replacing an excerpt with the generated description, append the original excerpt and original URL to a delimited note block unless already present. Existing user notes must remain intact.

Every processed bookmark note contains the original URL at minimum, so substitutions and generated descriptions are auditable.

---

## 6. Content resolution

### 6.1 Observed source behavior

The original ten-bookmark sample indicated that:

- X posts make up most of the author's current library.
- Raindrop often places post text in the excerpt, but sometimes only in the title.
- Title and excerpt are partial, inconsistent views of the same post.
- Genuine outbound links are uncommon.
- Some `t.co` links resolve back to X media rather than to an external page.
- The previously considered FxEmbed fallback returned authorization failures and is not part of v1.

These figures are directional evidence from a small sample, not general product guarantees.

### 6.2 Resolution order

1. Pass both Raindrop title and excerpt to the organization pipeline, with title first.
2. Scan them for a URL that is not an X/Twitter URL.
3. Follow a candidate redirect using a lightweight request.
4. Discard the candidate if its final destination is still an X/Twitter URL.
5. Apply the baseline substitution rule in Section 7 when one genuine external destination remains.

### 6.3 Graceful degradation

- If neither field contains useful text, process the available title and lower confidence when appropriate.
- If a link cannot be resolved, retain the original post and apply item-specific failure handling when necessary.
- Do not depend on an external X-reading service for v1.

### 6.4 Title cleaning

For X titles shaped like `<author> on X: "<body>" / X`, strip the wrapper and trailing short-link fragments before model input.

When baseline substitution occurs, use the destination page's title instead of the post title.

---

## 7. Baseline X substitution

Preserve the v4 baseline behavior for this revision. When a post contains a usable description and one genuine external link, update the bookmark in place to represent the destination:

- Replace the bookmark URL with the final external URL.
- Preserve the original post URL in the note.
- Replace the title with the destination title.
- Route according to the substituted destination.
- Preserve the bookmark ID and original `created` date.

Do not delete and recreate the bookmark.

Author-first-comment link extraction remains deferred because it requires X access not available to v1.

This revision does not add the later-discussed URL deduplication or multiple-link policy. Those proposals are outside the scope of v5 and do not alter the baseline above.

---

## 8. Folder taxonomy

Folders classify source type; tags classify topic.

| Folder | Covers |
|---|---|
| Social Posts | X/Twitter, Reddit, Hacker News, LinkedIn, Bluesky, Mastodon |
| Articles | Medium, Substack, personal blogs, news, long-form writing |
| Videos & Talks | YouTube, Vimeo, conference recordings, video podcasts |
| Code | GitHub, GitLab, npm, PyPI, Hugging Face |
| Docs & Reference | Official documentation, API references, MDN, specifications, wikis |
| Papers | arXiv, ACM, IEEE, research PDFs |
| Websites & Apps | Tools, products, services, and the fallback category |
| Need for Review | Operational failures and low-confidence items |

Folders are created during onboarding, never lazily during routine processing.

Routing precedence:

1. Deterministic domain map.
2. `.pdf` override to Papers.
3. Model classification constrained to the seven content folders.
4. Websites & Apps fallback.

---

## 9. Tag vocabulary

### 9.1 Structure

Use a fully open tag vocabulary rather than a closed topic taxonomy.

### 9.2 Seed

Ship a versioned seed in the repository containing:

- The eight folder definitions.
- The domain map.
- 30–50 starter tags.
- 3–5 worked examples.
- Tag style and folder-classification rules.

The seed is shared across deployments; each deployment's vocabulary can diverge afterward.

### 9.3 Versioning

Seed changes affect future bookmarks only. They do not trigger retroactive reprocessing. KV stores the applied seed version and change date.

### 9.4 Duplicate prevention

- Give the model the current registry, sorted by usage, and explicitly require reuse before invention.
- Normalize casing, spaces, hyphenation, and singular forms deterministically.
- Drop and log tags longer than two words rather than silently mangling them.
- Do not implement fuzzy or edit-distance merging in v1.

Semantic synonym reuse is a model capability and is a critical model-selection criterion.

### 9.5 Usage counts

Track a usage count for every tag from day one. Counts determine registry ordering and will support a future consolidation pass.

---

## 10. Failure handling

### Tier 1 — Transient

Examples: Raindrop 5xx responses, timeouts, rate limiting, temporary model overload, or reaching the configured daily Workers AI free-tier budget.

Retry only when the provider indicates that retrying soon is useful. Honor rate-limit reset information, stop starting new work for the run, and leave the bookmark in Unsorted. Do not pause, email, notify, or count the item as failed. Daily Cloudflare AI budget exhaustion waits for the next daily reset.

### Tier 2 — Item-specific

Examples: dead link, deleted post, unparseable page, invalid model response after retries, low confidence.

After the configured attempt limit, move the item to Need for Review, append the reason to its note, and continue. One bad bookmark must not block the batch.

### Tier 3 — Systemic

Examples: expired authentication, invalid model credentials, connected-account mismatch, corrupt state, or repeated non-rate-limit failures across several different bookmarks.

Set the pause flag and show the problem and remediation on the authenticated settings page. All later scheduled runs exit until the issue is resolved and the pipeline is resumed. A temporary rate limit or ordinary free-tier reset is never promoted to this tier merely because it happens repeatedly.

### Status, core email alerts, and resume

Email alerting is a core Later Gator capability because the user should not have to keep checking the settings page. It uses Cloudflare Email Service and sends only for a persistent, user-action-required pause. The recipient may be any address the user chooses and controls, but Cloudflare requires that address to be verified. Cloudflare also requires the sender to use a routing domain in the user's Cloudflare account. Rate limits, provider overload, daily free allowance exhaustion, individual bookmark failures, and successful recovery never send email.

First setup includes recipient entry, verification instructions, binding/domain readiness, and a test email. A deployment with the prerequisites is `email_ready`. A user without a suitable Cloudflare-managed domain may explicitly continue as `email_unavailable`; the page must state that automatic intervention alerts will not arrive and that the settings/MCP status surfaces are the fallback. This limitation cannot be hidden without adding a centrally operated Later Gator email service, which is outside the single-tenant free architecture. Resume through the settings page or the `resume_pipeline()` MCP tool.

---

## 11. Feature 2 — Conversational search

### 11.1 MCP tools

- `get_context()` returns the tag registry with usage counts, folder list, and current date.
- `search_bookmarks(text, tags, folder, from, to, limit)` combines meaning-oriented text with explicit validated tag, folder, and date constraints.
- `get_pipeline_status()` reports lifecycle, pause state, and recent failure summary.
- `resume_pipeline()` clears a recoverable pipeline pause after validation.

Onboarding and re-onboarding are not exposed as ordinary MCP actions.

### 11.2 Search behavior

The client model first uses `get_context()` to learn the actual folder and tag vocabulary. It passes the user's remaining concepts as `text` and passes tags separately. Later Gator validates requested tags against the registry, then composes Raindrop's supported search operators safely. Relative dates are resolved using the date returned by `get_context()`.

An explicit request such as “tagged machine-learning” requires that tag. Otherwise a strong tag match may narrow or improve the search, while the free-text concepts remain present so relevant bookmarks are not lost merely because they lack that tag. This is hybrid tag-plus-meaning search within Raindrop; Later Gator does not create embeddings or a separate semantic index.

### 11.3 Response contract

Each item contains:

- `id`
- `title`
- `description`, truncated to approximately 300 characters
- `tags`
- `folder`
- `created`
- `url`
- `domain`

Exclude cover images, highlights, raw HTML, and irrelevant Raindrop internals.

The response envelope always includes `status`, `total`, `returned`, and `items`. Default ordering is newest first.

```json
{"status":"ok","total":42,"returned":42,"items":[]}
```

For broad queries:

```json
{"status":"too_many_results","total":342,"returned":25,"suggestion":"Please refine your search.","items":[]}
```

The Worker must return structured JSON instead of throwing a user-facing error and must report the true total.

### 11.4 MCP security

Use a long random secret in the MCP URL path. Store it as a rotatable Cloudflare secret. An invalid path returns a bare 401 without account or pipeline details.

---

## 12. KV strategy

### Stored

- Tag registry and usage counts.
- Failure attempt counts.
- Pipeline pause state.
- Onboarding lifecycle state and current step.
- Connected Raindrop user ID.
- Encrypted Raindrop and external-provider credential envelopes.
- Seed version.
- Folder ID map.
- Small operational caches.

### Never stored

- Raindrop backup files or full-library snapshots.
- Plaintext credentials.
- Bookmark bodies as a second library.
- Search indexes.
- Embeddings.

### Write discipline

- At most one registry write per automation run, and only when changed.
- No KV write for an idle scheduled run.
- Onboarding step checkpoints are separate safety writes and are not subject to the one-registry-write rule.
- A periodic full resync may rebuild the registry from Raindrop, which remains authoritative.

---

## 13. Organization-model strategy

### 13.1 Provider behavior

The organization task expects the configured model to:

- Write specific descriptions that improve later retrieval rather than generic summaries.
- Reuse relevant tags from a long registry before inventing new ones.
- Understand technical subject matter at useful depth.
- Produce valid application-schema output consistently.
- Use `medium` and `low` confidence when warranted instead of defaulting to `high`.

### 13.2 Provider choice and default

Use a Cloudflare Workers AI model as the default. It requires no separate inference-provider API key. The exact shipped identifier is documented in the README and may change between releases when availability or free-tier economics change.

Cloudflare inference is optional. At installation or later, the user may select a supported external provider and enter their API key in the authenticated Later Gator setup/settings page. The provider and model identifier remain configurable behind one organization-model interface.

Initial supported provider modes:

- `workers-ai`: default; uses the Cloudflare AI binding and no external model key.
- `anthropic`: bring your own Anthropic API key and select a supported Claude model.
- `openai`: bring your own OpenAI API key and select a supported OpenAI model.

Saving an API key alone does not silently change providers. The user enters or replaces the key, selects a provider and model, then runs one small connection check in the settings page. The check verifies only that the credentials, model name, and response path work and that the response can be parsed. Later Gator does not approve, benchmark, grade, or maintain an allow-list of user-selected models. The README recommends known-good model identifiers without enforcing them.

Provider switching affects future organization calls only. It does not rerun onboarding, reprocess existing bookmarks, or change conversational search, which continues to use the MCP client's model.

Prompt caching is not a hard product requirement for Cloudflare-hosted inference. It is an optional provider optimization when an external provider supports it and repeated stable prompt prefixes materially affect cost.

The hard requirement is valid schema at the application boundary: request provider-enforced structured output where available, then validate in the Worker in all cases.

### 13.3 Provider switching

Provider, model, and prompt changes apply only between items. An in-progress item finishes under the configuration captured when it started. The next item uses the newly activated configuration.

The switch sequence is:

1. Enter or replace the OpenAI or Anthropic key in the authenticated settings page.
2. Choose that provider and a model identifier.
3. Run the small live connection check.
4. Activate the candidate only if that check succeeds; otherwise retain the current active provider.

Switching does not rerun onboarding, reprocess existing bookmarks, or change conversational search. The user may switch back to Workers AI at any time through the same flow.

### 13.4 Prompt settings

The permanent settings page provides a normal `Personal instructions` field that is appended to the protected core prompt. An advanced full-prompt override may be offered behind a warning and must include a one-click restore-to-default action. Prompt changes affect future items only.

The Worker continues to validate every model response before writing to Raindrop. A badly behaving model can therefore cause retries or move an item to Need for Review, but cannot write malformed data merely because its API connection check succeeded.

---

## 14. Operational constraints

- The default configuration must run on Workers Free, Workers KV Free, Workers AI's daily free allocation, and Raindrop Free without requiring payment details.
- Discover up to 10 bookmarks per 15-minute Cron invocation and enqueue their IDs. Process each queued bookmark in its own consumer invocation, with queue concurrency fixed at one.
- Keep Queue messages below 64 KB and limited to identifiers. Budget for one write, one read, and one delete operation per normally completed bookmark and stay below the current free Queue operation allowance.
- Track a conservative daily Workers AI budget in KV. Stop before the next call when the configured soft ceiling would be crossed, leave remaining bookmarks in Unsorted, and resume automatically after the daily reset. The shipped ceiling must leave headroom below Cloudflare's published hard limit.
- Cap prompt size and maximum output tokens so a single inference cannot consume the reserved headroom. Record returned token usage when available and use a conservative estimate otherwise.
- Remain within current Cloudflare request, subrequest, CPU, connection, and KV limits.
- Remain within Raindrop's current authenticated-user rate limit. Read remaining/reset headers on every response; on HTTP 429, make no further Raindrop calls in that run and retry after reset or on a later Cron invocation.
- A free-tier or rate-limit stop is normal deferred work: stop dispatching or retry after reset with no pause, item-failure count, email, or notification.
- Waiting on network calls must not be replaced with CPU-heavy content parsing.
- Avoid full-page HTML parsing libraries and expensive regular expressions over large bodies.
- The default Cloudflare path must incur US$0 platform usage and must fail closed rather than request a paid-plan upgrade. OpenAI or Anthropic usage is user-funded and is outside this guarantee.
- Cloudflare email alerts are a core feature and first-setup step. The recipient can be any user-controlled verified address. A Cloudflare-managed routing domain is still an external prerequisite for the no-card sending path; deployments without one must surface `email_unavailable` rather than pretending alerts work.
- Verify all provider limits and costs immediately before implementation and deployment; they are external constraints, not permanent product facts.

---

## 15. Testing

### 15.1 Environments

- Use local scheduled-handler testing rather than a separate code path.
- Use local KV state to reproduce cold-start, interrupted onboarding, and completed lifecycle states.
- Keep local secrets separate from deployed secrets.
- Assume local outbound calls can reach the real Raindrop API.
- Use a dedicated Raindrop test account. Do not test migration against the production library.

### 15.2 Required onboarding tests

- Deploy-button installation provisions and binds a fresh KV namespace and Workers AI binding from repository configuration.
- The setup page distinguishes installation validation from the onboarding check.
- Installation validation performs no Raindrop mutation.
- Workers AI works without an external provider key.
- Selecting Anthropic or OpenAI fails closed when the key entered in settings is missing or invalid.
- Stored credentials are encrypted, never returned to the browser, and are replaced rather than displayed during rotation.
- Switching provider/model requires only a new live connection check and does not reset onboarding.
- Connecting valid credentials performs no write.
- Missing onboarding state blocks cron.
- Zero bookmarks and zero user folders select Mode A.
- Any bookmark or user folder selects Mode B.
- Onboarding makes no write until the user selects Start onboarding.
- An interrupted run resumes at the first incomplete step.
- Re-running completed setup is a no-op.
- Mode B moves every bookmark to Unsorted and clears all bookmark tags.
- Collections are emptied before deletion.
- Mode B creates the seed folders and initializes the seed tag registry.
- Onboarding does not clear excerpts or rewrite notes.
- Trash is never used.
- A Raindrop user-ID mismatch blocks runtime processing.

### 15.3 Required automation tests

- Empty Unsorted exits without LLM or KV writes.
- Sequential items see registry updates from earlier items in the same run.
- Invalid model output cannot reach Raindrop.
- Low confidence routes to Need for Review.
- Transient failure leaves an item retryable in Unsorted.
- A successfully moved item is not processed twice.
- Original URL, excerpt, and user note content remain auditable.

### 15.4 Search tests

- Relative date queries use the context date.
- Folder and date filters compose correctly.
- Result envelopes always contain true totals.
- Broad searches return `too_many_results` rather than throwing.
- Invalid MCP secrets reveal no account detail.

---

## 16. Backfill

Mode B prepares the library by moving items into Unsorted. Backfill then runs through an explicit setup-page action that repeatedly invokes bounded batches. It does not start from a routine connection or attempt the entire library in one Worker invocation.

- Require completed onboarding and a model that passed Section 13.
- Show the number of pending items and require confirmation.
- Process newest first so current interests shape the initial vocabulary.
- Respect current Raindrop and inference-provider rate limits.
- Persist enough operational state to resume safely, while continuing to use Unsorted membership as the queue.
- Do not claim an exact completion time or cost until current provider limits and pricing are checked.

---

## 17. Deployment model

Later Gator is single-tenant. Each user deploys it into their own Cloudflare account with their own Raindrop credentials.

- The public GitHub repository README is the canonical installation document.
- The README starts with a Deploy to Cloudflare button.
- Cloudflare copies the public repository into the user's GitHub or GitLab account, builds it with Workers Builds, and deploys it to the user's Cloudflare account.
- `wrangler.jsonc` declares the KV namespace, Workers AI binding, organization Queue producer/consumer, Cron Trigger, and non-secret defaults so supported resources are provisioned and bound automatically.
- `.dev.vars.example` declares only bootstrap deployment secrets such as the installation secret; Raindrop and external-provider keys are entered in the authenticated application.
- `package.json` supplies clear Cloudflare binding descriptions for bootstrap bindings and configuration.
- After deployment, the README directs the user to the Worker-hosted setup page for credential entry, installation validation, onboarding, backfill, MCP URL creation, and model-provider status.
- Normal installation requires no local clone, package installation, terminal, or Wrangler login.
- No user namespacing.
- No multi-tenant token store.
- No shared vocabulary across deployments after the seed.
- Account-specific IDs, secrets, and alert addresses remain outside tracked example configuration.
- The repository must remain public and use a single deployable Worker application because those are Deploy to Cloudflare constraints.

---

## 18. Out of scope and deferred

### Out of scope

- A dedicated bookmark browser or custom search interface. A minimal setup and administration page is in scope.
- Later Gator-managed Raindrop backups or restores.
- Automatic onboarding triggered by token connection, cron, or MCP connection.
- Vector databases, embeddings, or a duplicate bookmark database.
- Nested folders.
- Multi-tenant service architecture.
- A Raindrop replacement or capture client.
- New X-link deduplication or multiple-link behavior discussed after PRD v4.

### Deferred

- Tag cleaning and consolidation pass.
- FxEmbed or another X-reading fallback.
- Author-first-comment link extraction.
- Optional D1 indexing for very large libraries.
- Worker-side relevance scoring.
- Multi-turn search refinement.
- Personalized ranking.

---

## 19. Decisions and unresolved items

### Settled through v5.4

1. Connecting credentials is not onboarding.
2. Onboarding is an explicit browser setup action guarded by KV lifecycle state.
3. Zero bookmarks and zero user folders select fresh mode; any bookmark or user folder selects existing-account mode.
4. Existing-account onboarding only moves bookmarks to Unsorted, clears tags, deletes emptied user folders, and installs the Later Gator seed folders and tag registry.
5. Onboarding does not include backup acknowledgement, plan hashing, excerpt clearing, note rewriting, or bookmark-by-bookmark organization.
6. A completed deployment is identified by lifecycle state plus the connected Raindrop user ID, not by folder names or bookmark count.
7. Cloudflare Workers AI is the no-key default; the exact shipped model is a README recommendation rather than a user-facing approval system.
8. Prompt caching is optional rather than a hard Cloudflare requirement.
9. Provider validation is only a live credential/model/response check; no pre-approved-model list, bake-off, or deployment evaluation exists.
10. The later X deduplication and multiple-link discussion does not change this PRD.
11. The primary installation path is a Deploy to Cloudflare button in the public repository README.
12. Normal users do not need to clone the repository, install dependencies, or run Wrangler.
13. Cloudflare Workers AI is the default inference provider, not a mandatory provider.
14. Users enter, replace, and test external-provider API keys in the authenticated setup/settings page during installation or later.
15. Provider switching never triggers Raindrop onboarding or retroactive bookmark processing.
16. Deployment validation and the small onboarding account check remain separate from onboarding writes.
17. The setup surface becomes the permanent authenticated settings and status page after onboarding.
18. The default single-user path is designed to stay within the card-free Cloudflare and Raindrop tiers by deferring work at conservative soft limits.
19. Email alerts are a core capability and first-setup step, but Cloudflare's free path requires a routing domain and a verified recipient; transient, quota, and rate-limit events never send email.
20. The first setup allows immediate selection of Workers AI, OpenAI, or Anthropic before onboarding.
21. Cron discovers up to 10 items every 15 minutes; Cloudflare Queue then processes one item per consumer invocation with concurrency one, so throughput is not one bookmark per 15 minutes.
22. The permanent settings page has defined overview, provider, prompt, Raindrop, automation, email, MCP, taxonomy, activity, and maintenance sections.

### Remaining implementation-time selection

- Exact default Workers AI model identifier, verified against current availability, structured-output behavior, and free-tier consumption.
- Recommended, non-enforced Anthropic and OpenAI model identifiers for the README.
- Conservative Workers AI daily soft ceiling and per-call prompt/output caps, measured against the final production prompt.

---

## 20. Changes through v5.4

1. Moved Raindrop, OpenAI, and Anthropic credential entry and replacement into the authenticated setup/settings page.
2. Required application-layer encryption for stored credentials and prohibited returning stored values to the browser.
3. Simplified onboarding to fresh seed creation or existing-account reset-and-seed.
4. Removed backup acknowledgement, plan hashing, excerpt clearing, note migration, and the extended onboarding ceremony.
5. Kept all other v5.3 product behavior unchanged.

### Earlier changes through v5.3

The historical backup/preflight decisions below are retained for revision history but are superseded by the v5.4 onboarding rules above.

1. Removed the mandatory Later Gator-generated backup and full-library snapshot.
2. Replaced it with user-owned backup instructions, explicit acknowledgement, and confirmation for Mode B.
3. Defined connection, onboarding, and routine runtime as separate lifecycle events.
4. Added explicit KV lifecycle states and Raindrop user-ID binding.
5. Specified that missing state and account mismatches block processing rather than trigger migration.
6. Made completed setup a no-op and re-onboarding a separate destructive action.
7. Clarified that preservation in bookmark notes is a migration safeguard, not a backup.
8. Made backfill an explicit post-onboarding action rather than a side effect of connecting.
9. Replaced the generic Haiku-class model direction with a Cloudflare-hosted 70B-class default direction.
10. Removed prompt caching as a hard requirement for Cloudflare-hosted inference.
11. Added the 20-bookmark, three-model quality bake-off and launch gate.
12. Preserved v4's baseline X behavior without importing the later deduplication or multiple-link discussion.
13. Added the Deploy to Cloudflare button as the primary installation path.
14. Replaced the user-facing local setup CLI with a minimal authenticated browser setup flow.
15. Split deployment validation from the read-only Raindrop onboarding preflight and defined both.
16. Made Cloudflare Workers AI the default rather than a mandatory inference provider.
17. Added explicit Anthropic and OpenAI bring-your-own-key modes and safe provider switching.
18. Required the README, Wrangler configuration, example secrets file, and binding descriptions to drive automatic provisioning and guided setup.
19. Removed model approval artifacts, model allow-lists, the 20-bookmark user evaluation, and the evaluation launch gate.
20. Made the setup page a permanent settings and status surface with provider and prompt controls.
21. Replaced Resend with Cloudflare Email Service and removed the third-party email API key.
22. Defined silent deferral for Raindrop rate limits, temporary provider failures, and Workers AI free-allocation pressure.
23. Added conservative daily AI budgeting, single-item consumer runs, and a card-free default operating envelope.
24. Moved per-bookmark work to a free Cloudflare Queue with single-message, single-concurrency consumption and a 10-item Cron discovery limit.
25. Made organization-provider selection an explicit first-setup decision as well as a later setting.
26. Promoted Cloudflare email alerts to a core setup and settings capability while documenting the unavoidable sender-domain prerequisite.
27. Fully specified the permanent settings/status page and its lifecycle-dependent behavior.
