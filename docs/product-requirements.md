# Later Gator — Product Requirements

**Product version:** 1.0.0
**Status:** implemented and authoritative

## 1. Product definition

Later Gator is a private, single-owner bookmark manager deployed to the owner's
Cloudflare account. It captures links from the dashboard, Chrome, and
the iOS Share Sheet; stores the library in D1; and uses a selected AI provider
to organize bookmarks that are waiting in Unsorted.

Later Gator owns the active bookmark library. Raindrop is supported only as a
CSV source. There is no runtime Raindrop account, token, synchronization, or
second source of truth.

## 2. Product principles

- Private by default: bookmark content, credentials, and private URLs never
  enter application logs.
- Single source of truth: D1 owns bookmarks and application state; Workers KV
  stores only private thumbnail bytes.
- Explicit control: destructive bulk actions require selection and
  confirmation; AI can be paused by the owner.
- Safe automation: only bookmarks in Unsorted are eligible for AI
  organization, and revision checks prevent stale work from overwriting edits.
- Honest status: the UI distinguishes waiting, processing, provider delay,
  owner pause, review, failure, and completion.
- Portable ownership: the owner can export the library as JSON or CSV.

## 3. Deployment and authentication

The owner deploys one Cloudflare Worker with the bindings described in the
technical design. A `PASSWORD` secret is required.

On the first successful login, Later Gator derives a password wrapping key,
creates a random data-encryption key, and stores only encrypted key material and
KDF parameters. Later logins unlock the same data key. Passwords and provider
credentials are never returned to the browser after submission.

Dashboard sessions have a 24-hour idle lifetime and a 14-day absolute lifetime.
State-changing dashboard requests require a valid session, a same-origin
request, and the session's CSRF token. Repeated failed logins are rate limited.

## 4. Setup

Setup is complete only after the owner:

1. Selects at least five starting topics. Topics are an open vocabulary and are
   normalized to lowercase hyphenated tags.
2. Optionally writes personal AI instructions.
3. Optionally imports a Raindrop CSV using one of the two import policies.
4. Confirms setup.

There is no fixed maximum vocabulary. The seed topics guide organization but do
not prevent the owner or AI from adding useful tags later.

## 5. Bookmark library

Each bookmark contains:

- original and normalized URL;
- hostname, title, description, and owner note;
- one fixed folder;
- favorite state;
- zero or more normalized tags;
- source and source-created timestamps;
- added and modified timestamps;
- organization policy and AI state;
- revision, deletion timestamp, optional thumbnail, and optional relationships.

URL identity lowercases the scheme and host, removes fragments and default
ports, and preserves path case, query order, and query parameters. A live
normalized URL is unique. Saving a duplicate reports that it is already saved
instead of creating a second active bookmark.

## 6. Fixed folders

The library has these fixed destinations:

- Social Posts
- Articles
- Videos & Talks
- Code
- Docs & Reference
- Papers
- Websites & Apps
- Need for Review
- Unsorted

Unsorted is the intake folder. AI assigns a permanent destination only while a
bookmark remains there. Moving a bookmark out of Unsorted stops its active
organization work. Moving it back to Unsorted makes it eligible again.

X and Twitter status URLs are deterministically assigned to Social Posts when a
successful organization result commits. Provider output cannot override that
rule.

## 7. Dashboard behavior

The dashboard provides:

- list and card views;
- cursor pagination;
- search over title, description, note, hostname, URL, and semantic matches;
- filtering by folder, tag, favorite, site, AI state, notes, and date range;
- sorting by added, modified, source-created, hostname, or title;
- bookmark detail, editing, favorite toggling, and related-bookmark linking;
- explicit selection mode for bulk move, favorite, restore, and deletion;
- visible folder counts, automation progress, import progress, and provider
  state;
- light, dark, and system themes.

Bulk deletion never occurs from a single unconfirmed click. The owner selects
bookmarks or tags, reviews the action, and confirms irreversible deletion.
Ordinary bookmark deletion first moves the item to Trash so it can be restored.

## 8. Tags

Tags are normalized once at every write boundary. Normalization trims, lowers,
converts separators to hyphens, removes unsupported punctuation, collapses
repeated hyphens, and canonicalizes `ai` as `artificial-intelligence`.

The owner may add an existing tag or create a new tag from the bookmark editor.
Retiring a tag removes it from every bookmark and hides it from active use.
Restoring a retired tag makes it available again. Usage counts are maintained
from bookmark-tag relationships.

## 9. AI organization

Supported providers are Cloudflare Workers AI, OpenAI, and Anthropic. A provider
and model must pass a connection test before activation. External credentials
are encrypted before D1 storage.

Organization is sequential so provider pressure and results remain predictable.
The pipeline:

1. Loads the current job, bookmark revision, tags, profile instructions, and
   related bookmark context.
2. Resolves safe page evidence with bounded fetches and provider-specific
   metadata. Browser Rendering is a bounded fallback when ordinary retrieval
   cannot obtain primary content.
3. Sends a structured prompt to the active provider.
4. Validates the response with Zod.
5. Rechecks the bookmark revision and Unsorted eligibility.
6. Commits folder, tags, description policy, and completion state atomically.
7. Schedules semantic embedding and independent thumbnail work.

Invalid or insufficient output is retried within bounded quality attempts, then
sent to Need for Review. Temporary provider or transport failures retain work
for retry. A spent Workers AI allocation records a safe retry time and resumes
automatically when the waiting period has passed.

Need for Review identifies the durable category: Retrieval failure,
Insufficient evidence, Invalid AI response, or Destination already saved. Each
item exposes an opaque diagnostic ID. Redacted structured retrieval events use
that ID in Workers Logs and report only field lengths, counts, evidence
presence, and whether Browser Rendering was attempted.

Editing one bookmark never pauses unrelated automation. Revision mismatches
refresh the job against the new bookmark state instead of committing stale
output.

## 10. CSV import

The importer accepts a Raindrop CSV up to 10 MiB and 5,000 data rows. It validates
the header and every URL, reports invalid and duplicate rows, and writes valid
bookmarks in bounded chunks.

Both policies place bookmarks in Unsorted:

- `reorganize`: imported tags and excerpts are discarded; AI creates the
  description, tags, and permanent folder.
- `preserve`: normalized imported tags and excerpt-as-description are retained;
  AI chooses only the permanent folder.

Imports do not change the owner's explicit pause setting. Organization and
thumbnail dispatcher messages are sent after the direct import commit completes.
Progress is derived from the import session and committed bookmark counts; there
is no staged-row workflow.

## 11. Thumbnails

Thumbnail work uses a separate Queue so image failures cannot block AI
organization. Candidates come from capture hints, page metadata, oEmbed,
YouTube, page icons, and other safe sources. Fetches reject private-network and
unsafe targets, enforce redirects and size limits, validate image signatures,
and transform accepted images to bounded WebP previews.

Only optimized bytes are stored in Workers KV. D1 stores metadata and the
current thumbnail ID. Delivery requires an authenticated session and a matching
bookmark/thumbnail ID, and uses private immutable caching.

## 12. Capture surfaces

### Chrome extension

The owner generates
one connection code in Settings, loads the generated browser folder, and pastes
the code once. The extension stores only the deployment origin and scoped
capture token. It requests access to the active page when used and does not
request browsing history.

The popup can save the page to Unsorted for AI or directly to a fixed folder
with owner-selected tags and relationships. It reports saved, already saved,
temporary failure, and invalid-connection states accurately.

For an X post or author reply thread, the master link checkbox remains. Its
popover also gives every discovered link an individual checkbox. Only the
visible selected set is submitted. If a selected destination already exists,
the first request saves nothing and asks the owner to Save post and connect, Go
back to the unchanged selection, or Cancel without saving.

### iOS Share Sheet

The owner generates a scoped endpoint and token in Settings. The Shortcut sends
the shared URL with an idempotency key. It reports saved, already saved, or
failure and does not claim local queuing when the Worker is unreachable.

An X post saved through the Share Sheet resolves only the focal post, not its
replies. If a destination is already in D1, the organized post is held in Need
for Review without creating a duplicate destination or relationship. The X
review overlay shows the current post with a distinct border, the existing
destination, and locally saved X posts already connected to it. Keep connects
only checked destinations and moves the post to Social Posts; Remove moves the
post to Trash; Cancel leaves the review unchanged.

### MCP

MCP is read-only. Later Gator exposes one stable Streamable HTTP endpoint and
OAuth 2.1 discovery, registration, PKCE authorization, token, refresh, and
revocation flows. Tools may search bookmarks and read bookmark details; they
cannot mutate the library, credentials, setup, or automation state. The owner
approves each AI assistant using the existing Later Gator password. Settings
must show each active grant's assistant name, read-only scope, coarse last-used
activity, and an independent Disconnect action.

Setup guidance must distinguish installing the remote server, authorizing it,
and enabling its tools in a conversation. ChatGPT gets a direct route to its
connector settings with the stable endpoint copied; Claude gets a prefilled
custom-connector URL rather than desktop stdio configuration. A successful tool
call is the connection test; model self-report about whether a connector is
installed is not.

## 13. Search and relationships

Keyword search uses D1 FTS. Semantic search uses Vectorize embeddings and joins
result IDs back to live D1 rows, so deleted or inaccessible vectors cannot
return bookmark content. If AI or Vectorize is unavailable, keyword and filter
search continue to work.

Relationships are undirected `related` links between two distinct bookmarks.
Creating or removing a relationship increments both bookmark revisions so an
in-flight organization result cannot overwrite the relationship-aware state.

## 14. Settings and reset

Settings allows the owner to:

- edit personal AI instructions;
- test and activate providers and models;
- configure an optional Workers AI Gateway ID;
- pause or resume automation;
- import and export the library;
- generate or revoke capture credentials;
- connect, review, and independently disconnect OAuth MCP clients;
- review automation progress and safe provider errors;
- reset application content after typing the explicit confirmation phrase.

Reset removes bookmark data, tags, credentials, sessions other than the current
one, thumbnail objects, and semantic vectors. It returns setup and provider
state to their defaults without exposing deleted content in logs.

## 15. Privacy, safety, and accessibility

- Logs contain only safe event names, opaque IDs, counts, and approved error
  codes—never URLs, titles, notes, descriptions, excerpts, tokens, or paths.
- Remote URL retrieval blocks loopback, private, link-local, and credentialed
  destinations and revalidates redirects.
- API inputs, Queue messages, provider output, CSV content, and stored JSON are
  validated at their boundaries.
- Buttons, dialogs, selection controls, status messages, keyboard focus, and
  theme contrast must remain usable without overlap at supported widths.
- Setup topic selection, bookmark and tag deletion checkboxes, and confirmation
  dialogs are release-blocking interactions.

## 16. Acceptance gate

A change is complete only when:

- `npm run check` passes strict types, browser types, function documentation,
  lint, Worker tests, and browser tests;
- `npm run build` produces a Wrangler dry-run bundle;
- changed behavior has regression coverage;
- the three files in `docs/` agree with the implementation;
- no bookmark content or credential appears in logs or fixtures;
- the Chrome package is regenerated from the canonical extension source; and
- named production functions remain documented.
