# Later Gator — Product Requirements Document

**Product:** Private AI bookmark manager  
**Status:** Current consolidated product specification  
**Product generation:** v6  
**Supersedes:** All earlier Later Gator product-requirements documents  
**Revision focus:** Replace Raindrop-backed automation with a Later Gator-owned bookmark library, private thumbnail storage, and first-party capture surfaces on Cloudflare  
**Last external-constraint review:** 2026-07-28  
**Last consolidated:** 2026-07-31

---

## 1. Product overview

Later Gator is a private, single-user bookmark manager deployed into the user's own Cloudflare account.

It provides:

- A browser dashboard for saving, viewing, searching, sorting, filtering, editing, moving, tagging, and deleting bookmarks.
- Private bookmark thumbnails owned by the user's Later Gator deployment.
- A fixed folder taxonomy managed by Later Gator.
- AI-assisted bookmark descriptions, tags, and folder classification.
- Optional import from a Raindrop CSV export.
- Chrome and Firefox extensions for capturing the current page and an optional related URL.
- An iOS Share Sheet Shortcut for saving a shared link directly to Unsorted.
- Optional natural-language access from MCP-capable clients such as ChatGPT or Claude.
- A choice of Cloudflare Workers AI, OpenAI, or Anthropic for bookmark organization.

Later Gator owns its bookmark library after deployment. Raindrop is not a runtime dependency, source of truth, synchronization target, or credentialed integration.

Raindrop is supported only as an optional source of a user-uploaded CSV import. Later Gator never connects to the Raindrop API, changes the user's Raindrop account, or synchronizes changes back to Raindrop.

---

## 2. Product principles

- Later Gator is the bookmark system of record.
- The user owns the Cloudflare deployment and its stored data.
- Normal setup requires no terminal, local installation, or programming.
- The default Cloudflare path should remain usable without an OpenAI or Anthropic key.
- The default operating target is the Cloudflare free tier for an ordinary personal bookmark library.
- Free-tier compatibility is a bounded operating target, not a promise of unlimited storage, traffic, or AI usage.
- AI organizes bookmarks sequentially so each successful result can inform the vocabulary used for later bookmarks.
- Viewing is safe and non-mutating until the user opens an explicit bookmark
  editor or confirms a destructive tag action.
- The fixed folder taxonomy cannot be renamed or deleted.
- Tags remain user-controlled and may be added, removed from individual bookmarks, or deleted globally.
- Imported data is previewed before it is committed.
- Thumbnail binaries are stored separately from bookmark records.
- Capture surfaces confirm whether the bookmark was actually saved or failed.
- Later Gator does not maintain its own OpenAI or Anthropic usage ledger.
- Workers AI usage is presented as account-wide Cloudflare usage through Cloudflare's authoritative dashboard; Later Gator never substitutes a local neuron estimate.
- Import is optional during setup. MCP is configured later from Settings and
  never blocks setup.

---

## 3. Goals

### 3.1 Primary goals

- Replace the dependency on Raindrop with a complete Later Gator bookmark library.
- Let the user manage bookmarks from a private web dashboard.
- Organize new and imported bookmarks with AI.
- Maintain a coherent, personalized tag vocabulary.
- Keep folder classification stable through an immutable source-type taxonomy.
- Make ordinary manual edits safe and predictable.
- Remove Raindrop-specific concepts such as account binding, folder-ID repair, tag resynchronization, Raindrop rate limits, and source-of-truth races.
- Remove the 15-minute discovery delay for bookmarks already stored in Later Gator.
- Store and display thumbnails without consuming the primary bookmark database's limited per-database capacity.
- Provide convenient capture from Chrome, Firefox, and the iOS Share Sheet.

### 3.2 Secondary goals

- Import a Raindrop CSV without recreating the user's old folder hierarchy.
- Offer a migration choice between full AI reorganization and preservation-oriented organization.
- Support natural-language bookmark retrieval through MCP.
- Allow seamless AI provider and model switching for future work.
- Make provider usage and processing state understandable from the dashboard.
- Keep the product single-tenant and deployable from a public repository through Deploy to Cloudflare.
- Preserve explicit relationships between a source bookmark and another linked bookmark without replacing either URL.

### 3.3 Success criteria

- Visiting the deployment root always leads to a useful login or application page.
- A new user can finish required setup without importing a file. MCP is absent
  from setup and remains available in Settings.
- Every stored bookmark belongs to exactly one Later Gator folder or system view.
- A newly added Unsorted bookmark becomes eligible for AI processing immediately.
- AI processes no more than one bookmark at a time.
- Editing one bookmark does not pause organization of unrelated bookmarks.
- A user edit is never overwritten by an AI result started from an older bookmark revision.
- Deleting a tag globally removes it from every bookmark without deleting any bookmark.
- Deleted tags are not silently recreated by the AI.
- Fixed folders cannot be renamed or deleted through the application.
- Import preview reports valid rows, invalid rows, duplicates, and the chosen transformation before confirmation.
- AI provider switching affects the next eligible bookmark and does not rewrite completed bookmarks.
- Usage displays never present a rough token estimate as actual neurons or actual cost.
- The application remains usable for viewing and export when AI is unavailable.
- A missing or failed thumbnail never prevents a bookmark from being saved.
- Browser-extension capture confirms success only after Later Gator commits the bookmark.
- The iOS Shortcut always displays a clear saved or failed result.
- Saving a source URL with a linked-to URL preserves two distinct bookmarks and their relationship.

---

## 4. Product boundaries

### 4.1 Later Gator owns

- Bookmark records.
- Titles, URLs, descriptions, notes, tags, and folder placement.
- Favorite state, thumbnail metadata, and bookmark-to-bookmark relationships.
- Private thumbnail values stored outside the bookmark database.
- Bookmark lifecycle and AI-processing state.
- Import history and row-level import outcomes.
- Personalization and organization instructions.
- AI provider and model configuration.
- MCP connection configuration.
- User-facing usage information.
- Application preferences and authentication state.
- Browser-extension and iOS Shortcut capture credentials and revocation state.

### 4.2 Raindrop owns

Only the user's original Raindrop account and its export process.

Later Gator:

- Does not request a Raindrop token.
- Does not call the Raindrop API.
- Does not alter Raindrop bookmarks, folders, or tags.
- Does not keep Raindrop and Later Gator synchronized.
- Does not restore or delete anything in Raindrop.

### 4.3 User responsibility

- The user initiates and downloads their Raindrop export.
- The user retains any original export they want to keep as a backup.
- Later Gator does not create, verify, retain indefinitely, or restore Raindrop backup files.
- The user reviews the import preview and chooses the import behavior before committing it.

---

## 5. Deployment and authentication

### 5.1 Deploy to Cloudflare

The public repository README begins with a Deploy to Cloudflare button.

The deployment form asks for one user-created secret:

**Later Gator password**

Requirements:

- The field is blank by default.
- It is displayed as a password field.
- It is required.
- It is non-empty. The product strongly recommends 16 or more characters, but
  login does not impose a 10-character minimum because it must accept the
  bootstrap value already provisioned for the deployment.
- It is described in user language, not as `INSTALLATION_SECRET`.
- The underlying deployment secret may retain an implementation-specific binding name, but that name is not the primary user-facing label.

Later Gator generates any machine-to-machine MCP secret itself. The deploy form does not ask the user to invent an MCP secret.

### 5.2 Root URL behavior

The Worker root URL is the canonical URL the user is told to open after deployment.

When an unauthenticated user visits `/`:

1. Show the Later Gator login page.
2. Ask for the Later Gator password.
3. Establish an authenticated session after a valid password.
4. Redirect according to setup state:
   - Setup incomplete → `/setup`
   - Setup complete → `/dashboard`

The user must not need to discover or manually append `/setup`.

When an authenticated user visits `/`:

- Setup incomplete → redirect to `/setup`.
- Setup complete → redirect to `/dashboard`.

Direct visits behave as follows:

- `/setup` remains available while setup is incomplete.
- After setup, `/setup` redirects to the relevant settings or onboarding-summary area.
- `/dashboard` requires completed setup.
- `/settings` requires completed setup.
- Invalid or expired sessions immediately clear local session state and return
  to login without exposing private data or leaving an interactive stale page.

### 5.3 Session behavior

- The Later Gator password never appears in a URL.
- Authentication cookies are secure, HTTP-only, and same-site.
- State-changing actions require request-forgery protection.
- Logout is available from both dashboard and settings.
- Repeated failed login attempts receive bounded abuse protection.

---

## 6. Setup lifecycle

### 6.1 Setup definition

Setup personalizes the AI and introduces optional CSV migration. MCP is
configured later from Settings.

Setup does not mutate Raindrop because Later Gator has no Raindrop connection.

Setup is complete when the user has:

1. Selected at least five relevant tags.
2. Supplied career and aspiration context.
3. Chosen whether to add personal AI instructions.
4. Chosen whether to import a Raindrop CSV now or later.
5. Reached and confirmed the setup summary.

The optional steps never block completion.

### 6.2 Setup state

The application has these user-facing lifecycle states:

- `setup_incomplete`
- `ready`
- `ai_paused`
- `needs_attention`

Raindrop onboarding states, connected-account identity, account mismatch, and reset-and-seed migration states no longer exist.

### 6.3 Step 1 — Starting topics and subtopics

The first setup screen asks:

> Which topics are most relevant to what you save and want to learn?

Requirements:

- Select at least five distinct topics or subtopics from grouped, social-app-style choices.
- Suggested topics are grouped by broad area to reduce blank-page friction.
- The user may add custom tags.
- The custom-topic field accepts comma-separated values and updates the distinct
  selection count as the user types, adds, or removes values.
- Tags are previewed in their normalized form.
- Every tag is stored and displayed as a lowercase single word or as
  lowercase hyphen-separated words.
- The user can remove and replace selections before continuing.
- Selected tags become starting interests, not a closed vocabulary or allowlist.
- AI must create precise new tags when later bookmarks introduce subjects absent from the starting interests.
- These tags do not need to be attached to a bookmark immediately.
- Tag browsing, filtering, creation through bookmark editing, and global deletion live in the Library rather than Settings.

The setup screen should recommend a focused starting set rather than encouraging hundreds of tags.

### 6.4 Step 2 — Career and aspiration context

The second screen asks two plain-language questions:

1. What do you currently do?
2. What are you working toward or hoping to become?

Requirements:

- Each answer supports free-form text.
- The purpose is explained: this context helps the AI distinguish what is useful and choose more relevant descriptions and tags.
- The answers can be edited later.
- The answers are part of the organization context for future bookmarks.
- The product must not claim that these answers provide professional advice or determine the user's identity.

### 6.5 Step 3 — Personal AI instructions

The third screen provides an optional text area:

> Add any personal instructions for the AI managing your bookmark library.

Examples may include:

- Prefer practical implementation tags.
- Distinguish beginner material from advanced references.
- Tag job-search and university material separately.
- Keep descriptions concise.

Requirements:

- The field is optional.
- The user may skip it without warning or degraded status.
- The user may edit it later in Settings.
- The protected product rules remain active even when personal instructions are supplied.
- A future advanced full-prompt override is not required by this PRD.

### 6.6 Step 4 — Optional Raindrop CSV import

The fourth screen explains how to export bookmarks from Raindrop and asks whether the user wants to import now.

The instruction sequence includes screenshot placeholders:

1. Open Raindrop in a web browser.
   - `[Screenshot placeholder: Raindrop web application and Settings entry point]`
2. Open Settings and select Backups or Export.
   - `[Screenshot placeholder: Raindrop Settings showing Backups or Export]`
3. Create or download a CSV export.
   - `[Screenshot placeholder: Create export and CSV download controls]`
4. Return to Later Gator and upload the CSV.
   - `[Screenshot placeholder: Later Gator CSV upload area]`

Actions:

- **Import from Raindrop now**
- **Skip for now**

Skipping does not reduce Later Gator functionality. The same importer remains available in Settings.

### 6.7 Step 5 — Setup summary

The final screen shows:

- Selected starting tags.
- Career context.
- Aspiration context.
- Whether personal instructions were added.
- Import status: completed, pending, or skipped.
- Default AI provider and model status.

The default organization provider is Cloudflare Workers AI. Later Gator performs a small synthetic availability check without using a real bookmark.

The final action is:

**Finish setup and open dashboard**

After success:

- Setup is marked complete.
- The user is redirected to `/dashboard`.
- No separate Raindrop onboarding action exists.

---

## 7. Dashboard

### 7.1 Purpose

The dashboard is the primary Later Gator application and bookmark library.

It provides:

- Folder navigation.
- A browsable tag list with usage counts and tag filtering.
- Bookmark list and bookmark detail views.
- Search.
- Sorting and filtering.
- Bookmark details and per-bookmark editing.
- AI-processing status.
- Add-bookmark action.
- Import progress.
- A path to Settings.

### 7.2 Bookmark fields

Each bookmark supports:

- URL.
- Title.
- Description.
- User note.
- Tags.
- Folder.
- Favorite state.
- Thumbnail or a standard placeholder.
- Zero or more relationships to other Later Gator bookmarks.
- Site/normalized hostname.
- Date added to Later Gator.
- Date modified in Later Gator.
- Original creation date when supplied by an import.
- AI-processing state.
- Soft-deletion state.

Definitions:

- **Date added:** when the bookmark entered Later Gator.
- **Date created:** the source creation time from an import, or the date added for a bookmark created directly in Later Gator.
- **Date modified:** the last successful user or AI change in Later Gator.
- **Site:** normalized hostname derived from the bookmark URL.

### 7.3 Fixed folder taxonomy

Permanent organization folders:

1. Social Posts
2. Articles
3. Videos & Talks
4. Code
5. Docs & Reference
6. Papers
7. Websites & Apps
8. Need for Review

System views:

- Unsorted
- Trash
- All Bookmarks

Rules:

- Permanent folders cannot be renamed.
- Permanent folders cannot be deleted.
- Users may move bookmarks between permanent folders.
- Unsorted, Trash, and All Bookmarks cannot be renamed or deleted.
- Nested folders and user-created folders are not supported in v6.0.

### 7.4 View mode

View mode is the default.

In view mode, the user may:

- Open bookmarks.
- Open a bookmark card in an in-app details modal that shows its description,
  note, tags, folder, dates, site, relationships, and thumbnail.
- Open the source URL through an explicit external-link action in that modal.
- Open the per-bookmark editor directly from the details modal.
- Search.
- Sort.
- Filter.
- Change folder views.
- Inspect tags and descriptions.
- See the thumbnail and related bookmarks.
- Mark or unmark a bookmark as favorite.
- See AI status and usage.
- Edit the selected bookmark.
- Add a new bookmark through a focused add action.

View mode does not expose bulk mutation controls.

### 7.5 Bookmark editing

The explicit editor permits:

- Edit bookmark title.
- Edit URL.
- Edit description.
- Edit user note.
- Add or remove tags.
- Move bookmarks between folders.
- Delete bookmarks.
- Delete a tag globally.
- Replace or remove a thumbnail.
- Add or remove a linked-bookmark relationship.
- Mark or unmark a bookmark as favorite.

Opening an editor never establishes a global lock or pauses unrelated AI work.
Every save carries the bookmark revision that the modal loaded. If AI committed
first, the save receives a revision conflict and reloads current data. If the
user save commits first, the stale AI result cannot overwrite it and its job is
refreshed against the current revision when organization is still required.

### 7.6 Adding bookmarks

The dashboard provides an **Add bookmark** action.

Minimum input:

- Valid HTTP or HTTPS URL.

Optional input:

- Title.
- Description.
- Note.
- Initial tags.
- Linked-to URL.

Default behavior:

- The bookmark is stored immediately.
- It appears in Unsorted.
- It becomes eligible for sequential AI organization immediately.
- The user can choose **Save without AI organization** when manually filing it.

A bookmark is never lost merely because metadata extraction or AI processing fails.

### 7.7 Search, sort, and filter

Dashboard search covers:

- Title.
- URL.
- Site.
- Description.
- Note.
- Tags.

Typing `#` in the search box opens a dynamic, narrowing tag picker. Selecting a
suggestion applies that tag as a removable search filter without requiring the
user to know its exact spelling. An empty `#` query shows every active tag.
The sidebar shows a compact topic summary and a **View all** action opens the
complete topic vocabulary in a modal rather than a locally scrolling sidebar.

Sort options:

- Date added, newest or oldest. Date added newest-first is the default.
- Date modified, newest or oldest.
- Date created, newest or oldest.
- Site, ascending or descending.
- Title, ascending or descending.

Filter options:

- Folder or system view.
- One or more tags.
- Site.
- Date-added range.
- Date-modified range.
- Date-created range.
- AI-processing state.
- Favorite state.
- Thumbnail available or unavailable.

Sort and filter controls open in one clear in-app modal. Site filtering is part
of that modal alongside sort order, dates, and favorite state. Active tag
filters remain visible and individually removable. Empty-result states explain
which filters are active.

The folder sidebar displays the total non-trashed bookmark count for All
Bookmarks and each fixed folder, plus the deleted-bookmark count for Trash.
Library results use cursor pagination and display `shown of total`; a fixed
100-result window must never be presented as the full library.

### 7.8 Bookmark deletion

Deleting a bookmark moves it to Trash.

Trash behavior:

- Trashed bookmarks are excluded from normal search, AI processing, tag counts, and MCP results.
- The user may restore a bookmark to its prior folder.
- The user may permanently delete one or more Trash items after confirmation.
- Empty Trash is a separate confirmed action.

The product must not permanently delete a bookmark from an ordinary list action without a confirmation or recoverable Trash step.

### 7.9 Thumbnails

Every bookmark may have one Later Gator-owned thumbnail.

Thumbnail source order:

1. A valid Raindrop `cover` image supplied during CSV import.
2. A valid preview image exposed by the saved page, such as Open Graph or equivalent metadata.
3. A bounded page-generated preview when the configured Cloudflare allowance and destination safety rules permit it.
4. A site icon or standard Later Gator placeholder.

Requirements:

- The bookmark save succeeds even when thumbnail retrieval or generation fails.
- Imported or remotely fetched images are copied into the user's Later Gator storage; dashboard cards do not depend indefinitely on third-party image URLs.
- Thumbnails are normalized to a bounded, web-friendly representation before permanent storage.
- Thumbnail binaries are stored as private Workers KV values, not as database blobs.
- A preview preserves the source image's natural aspect ratio and is never center-cropped into a fixed card ratio.
- Dashboard cards use a responsive masonry layout so portrait, landscape, and document-shaped previews remain legible.
- The bookmark database stores only the thumbnail storage key, media type, dimensions, byte size, source type, and timestamps.
- The dashboard serves thumbnails only to an authenticated application request or another explicitly authorized Later Gator client.
- Changing a bookmark URL marks its existing automatically generated thumbnail as stale and offers regeneration.
- A user-uploaded replacement thumbnail is not overwritten automatically.
- Moving a bookmark to Trash retains its thumbnail for restoration.
- Permanently deleting the bookmark also deletes its stored thumbnail.
- Removing or regenerating a thumbnail must not alter the bookmark's title, description, tags, note, folder, favorite state, or relationships.

Cloudflare Workers KV is the product assumption for thumbnail binaries. At the
current review date, Workers Free includes 1 GB of KV storage, 100,000 reads per
day, and 1,000 writes, deletes, and list operations per day. Later Gator caps each
stored preview at 500 KiB, keeps bookmark metadata in D1, and must degrade to a
bookmark without a preview when image processing or KV storage fails.

### 7.10 Linked bookmarks

A bookmark may be related to another bookmark through an optional **Linked to** URL.

Capture semantics:

- **Source URL** is the primary bookmark being saved.
- **Linked to** is an optional URL for another bookmark related to the source.
- The two URLs must not be identical after normalization.
- Neither URL replaces the other.
- The relationship is visible from both bookmarks as **Related bookmarks**.

Save behavior:

- If the linked-to URL already exists in Later Gator, connect the source bookmark to the existing bookmark.
- If it does not exist, create it as a separate Unsorted bookmark and connect the two.
- Duplicate prevention applies independently to both URLs.
- Failure to create or resolve the linked bookmark must not silently report the complete two-bookmark operation as successful.
- The result clearly distinguishes:
  - Source saved and linked.
  - Source saved but linked bookmark failed.
  - Source failed.

For X handling, the X post and its externally linked destination remain separate bookmarks connected through this relationship. Later Gator does not replace the X bookmark URL with the destination URL.

Deleting one bookmark removes the active relationship from ordinary views but does not delete the other bookmark. Restoring it from Trash restores eligible relationships. Permanent deletion removes its relationship records.

---

## 8. Tag behavior

### 8.1 Open vocabulary

Tags classify topic, use, skill, domain, or other retrieval-relevant meaning.

The vocabulary begins with the user's five-or-more setup selections and can grow through:

- User-created tags.
- Retained imported tags.
- AI-proposed tags accepted during organization.

The setup selection must never constrain AI to existing tags. Reuse is preferred
only when a current tag accurately fits; otherwise AI creates a new active tag.

### 8.2 Individual bookmark tag edits

In the bookmark editor, the user may:

- Add an existing tag.
- Create and add a new tag.
- Remove a tag from one bookmark.
- Replace all tags on a bookmark.

These edits update the current Later Gator library directly. No external registry resynchronization is required.

### 8.3 Global tag deletion

The user may delete a tag globally from the tag-management screen.

Before confirmation, show:

- Tag name.
- Number of affected bookmarks.
- Explanation that bookmarks will remain.
- Explanation that the AI will stop using the tag.

After confirmation:

- Remove the tag from every active bookmark.
- Keep all affected bookmarks in their current folders.
- Exclude the tag from future AI prompts.
- Record the tag as retired so the AI cannot silently recreate it.
- Exclude it from suggestions and MCP context.

The user may explicitly recreate or restore a retired tag later.

### 8.4 Tag normalization

User and AI tags follow the same visible normalization rules:

- Case-normalized.
- Whitespace normalized.
- Duplicate tags prevented.
- Empty tags rejected.
- Clearly equivalent formatting variants merged.

The UI previews normalization before a newly typed tag is committed.

---

## 9. AI organization

### 9.1 Organization responsibility

For a bookmark requiring full organization, the AI proposes:

- A retrieval-friendly description.
- Relevant tags.
- One permanent content folder.
- Confidence.
- Optional review reason.

The application validates the proposal before saving it.

### 9.2 Sequential processing

Later Gator processes at most one bookmark at a time.

Sequential processing applies to:

- Newly added Unsorted bookmarks.
- Full-reorganization CSV imports.
- Preservation-oriented CSV imports waiting in Unsorted.
- Retried bookmarks.

There is no user-visible 15-minute discovery schedule. A stored pending bookmark becomes eligible immediately.

The product requires processing to continue safely after the dashboard is closed. The later technical design will select the simplest Cloudflare mechanism that meets this requirement within the supported operating envelope.

The PRD does not require:

- A 15-minute Cron Trigger.
- Raindrop discovery.
- Dispatch leases.
- A Raindrop synchronization registry.
- A specific Queue implementation.

An internal Queue or another durable execution mechanism may be selected later if it is the simplest safe way to satisfy background continuation. It must not reintroduce Raindrop-specific complexity into the user experience.

### 9.3 Bookmark revision safety

Every AI job is based on a specific bookmark revision.

Before applying an AI result:

- Confirm the bookmark still exists.
- Confirm it is not in Trash.
- Confirm the bookmark revision has not changed since AI work began.

If the bookmark changed:

- Discard the stale AI proposal and refresh the same job against the current
  revision when the bookmark still requires organization.
- Preserve the user's edit.
- Return the bookmark to the appropriate pending state only when it still requires organization.

The AI must never overwrite a newer user edit.

### 9.4 Full organization behavior

For ordinary Unsorted bookmarks and full-reorganization imports:

- Generate or replace the AI-managed description.
- Choose normalized tags.
- Choose one permanent content folder.
- Route low-confidence or repeatedly invalid results to Need for Review.
- Preserve the URL, user note, date added, and source creation date.

### 9.5 Preservation-oriented behavior

For bookmarks imported through the preservation option:

- Preserve the imported description.
- Preserve the imported user note.
- Preserve imported tags after normalization.
- Allow the AI to add relevant new tags.
- Never remove an imported tag merely because the AI did not suggest it.
- Never reactivate a globally retired tag.
- Choose one permanent content folder.
- Remove the bookmark from Unsorted after successful classification.

### 9.6 Folder routing

Folders describe source type. Tags describe topic and use.

Deterministic URL rules may override the AI for obvious source types, including:

- GitHub and similar code hosts → Code.
- YouTube and similar video hosts → Videos & Talks.
- arXiv and direct research-paper sources → Papers.
- Official documentation sites → Docs & Reference.
- X and Twitter hosts → Social Posts through a deterministic rule that the
  model cannot override.
- Reddit, LinkedIn, and similar social sources → Social Posts.
- Direct PDF documents → Papers unless a more specific supported rule applies.

Unknown or invalid classification falls back to Websites & Apps unless confidence requires Need for Review.

### 9.7 Simple failure experience

The dashboard exposes only product-relevant states:

- **Organizing**
- **Waiting for AI**
- **Needs attention**
- **Need for Review**

Raindrop deferral timestamps, dispatch leases, Queue revisions, and tag-resynchronization status do not exist in the product.

Temporary provider or network failure:

- Leaves the bookmark pending.
- Does not increment a bookmark-quality failure count.
- Does not change bookmark content.
- Retries through the background-processing mechanism.
- Displays a concise provider status when the interruption persists.

Invalid structured AI output:

- Receives one corrective retry for that processing attempt.
- If it remains invalid, the bookmark remains pending for a bounded later attempt.
- After the configured quality-attempt limit, move it to Need for Review with a safe reason.

Authentication, billing, inaccessible-model, or persistent configuration failure:

- Stops new AI work.
- Keeps the bookmark library fully viewable and editable.
- Shows a clear Settings action to repair or switch the provider.

### 9.8 Owner pause

The user may pause AI explicitly from Settings.

- Owner pause persists until resumed.
- Viewing, searching, importing for later processing, exporting, and manual editing remain available while AI is paused.

---

## 10. Raindrop CSV import

### 10.1 Availability

Import is available:

- During setup.
- Later from Settings → Import and Export.

Import never requires a Raindrop token.

### 10.2 Supported source fields

Later Gator supports both Raindrop export layouts supplied for this revision:

- A full-library export with a `folder` column.
- A single-folder or collection export without a `folder` column.

The representative full-library export contains these columns:

- `id`
- `title`
- `note`
- `excerpt`
- `url`
- `folder`
- `tags`
- `created`
- `cover`
- `highlights`
- `favorite`

Observed field coverage:

| Field | Non-empty rows | Later Gator treatment |
|---|---:|---|
| `id` | 659 | Retain only as a source identifier in the import report; never use it as the Later Gator bookmark ID |
| `title` | 659 | Import as title |
| `note` | 13 | Ignore |
| `excerpt` | 468 | Treat as imported description |
| `url` | 659 | Required bookmark URL |
| `folder` | Optional; present in full-library exports | Show in preview/report but do not recreate the folder |
| `tags` | 383 | Remove under Option A or normalize and retain under Option B |
| `created` | 659 | Ignore |
| `cover` | 607 | Ignore; normal thumbnail discovery runs independently |
| `highlights` | 0 | Unsupported in v6.0; warn and report rather than silently discarding if a future import contains data |
| `favorite` | 659 | Ignore |

The sample contains 656 unique non-empty URLs, so duplicate preview and deterministic duplicate handling are required.

The importer may accept harmless additional export columns but must not silently treat an unknown column as a supported bookmark field.

### 10.3 File validation

Before import:

- Validate that the upload is a CSV.
- Enforce a documented file-size limit within the deployment's request and storage limits.
- Detect character encoding where practical and require UTF-8 when ambiguous.
- Require a recognizable URL column.
- Validate every URL.
- Parse quoted commas and multiline fields correctly.
- Normalize tag delimiters and whitespace.
- Treat `note`, `created`, `cover`, and `favorite` as ignored text fields.
- Detect non-empty unsupported `highlights` and require the user to acknowledge that they are not imported.
- Never execute spreadsheet formulas, HTML, or scripts from imported cells.

### 10.4 Import preview

Uploading a file does not immediately commit bookmarks.

Preview shows:

- Total rows.
- Valid bookmark rows.
- Invalid rows and safe reasons.
- Duplicate URLs within the file.
- Number of folders represented in the export.
- Number of unique imported tags.
- Rows with descriptions.
- Rows with notes.
- Rows with usable created dates.
- Rows with cover images.
- Rows marked favorite.
- Rows containing unsupported highlights.
- A sample of the transformed result.

The user may download an error report before committing.

### 10.5 Duplicate behavior

Default duplicate identity is normalized URL.

- Within one CSV, keep the first valid occurrence and report later occurrences as duplicates.
- If the URL already exists in Later Gator, keep the existing bookmark unchanged
  and report the imported row as skipped after commit.
- Import never opens a per-bookmark conflict-resolution workflow.

### 10.6 Imported folders

Raindrop folder names and nested folder paths are never recreated as Later Gator folders.

The preview explains:

> Later Gator uses a fixed folder system. Folder names from your CSV will not be created. Choose how the imported bookmarks should be reorganized.

The original folder column may be used only in the import preview and import report. It does not become a user-created folder or automatic tag.

### 10.7 Import option A — Reorganize everything

User-facing option:

**Reorganize with Later Gator**

For every imported bookmark:

- Preserve URL.
- Preserve title when present.
- Set date added to the Later Gator import time.
- Remove imported tags.
- Remove the imported description or excerpt.
- Do not import note, favorite, source-created date, folder, cover, or other
  Raindrop metadata.
- Ignore the imported folder.
- Place the bookmark in Unsorted.
- Attempt to copy a valid imported cover into Later Gator thumbnail storage independently of AI organization.
- Let the AI create the description, choose tags, and select the permanent folder.

Before confirmation, warn clearly that imported tags and descriptions will not be retained in Later Gator. The user's original CSV remains their external backup.

### 10.8 Import option B — Preserve and classify

User-facing option:

**Keep my tags and descriptions**

For every imported bookmark:

- Preserve URL.
- Preserve title when present.
- Preserve description or excerpt.
- Normalize and retain imported tags.
- Do not import note, favorite, source-created date, folder, cover, or other
  Raindrop metadata.
- Ignore the imported folder.
- Place the bookmark in Unsorted.
- Attempt to copy a valid imported cover into Later Gator thumbnail storage.
- Ask the AI to choose a permanent folder.
- Allow the AI to add relevant new tags.
- Never delete an imported tag merely because the AI did not choose it.
- Remove the bookmark from Unsorted after classification.

If the AI cannot classify with sufficient confidence, move the bookmark to Need for Review while retaining its imported data.

### 10.9 Import commit and progress

Before commit, show:

- Selected import option.
- Number of bookmarks to create.
- Number of within-file duplicates that will be skipped.
- Number of invalid rows.
- Exact preservation/removal behavior.

Import commit:

- Is one set-based D1 operation from the user's perspective.
- Pauses AI before preview/commit and keeps it paused until every accepted row
  reaches a terminal import outcome.
- Keeps library mutations read-only while allowing the user to browse the
  application. Progress is shown in a non-blocking status dock after confirmation.
- Shows an in-progress state in setup and Settings, then the final imported,
  duplicate, existing-library-skip, and invalid counts.
- Stores every accepted bookmark in Unsorted before AI organization resumes.
- Produces an import session with visible counts.
- Does not call the normal per-bookmark creation repository, read provider or
  application state per row, create one job per row through application code,
  or use Queue messages to perform CSV insertion.
- Creates all required AI job rows with one set-based post-insert D1 operation,
  then signals background AI dispatch once after the import commits.
- Does not require the browser to remain open for later AI organization.
- Is transactionally committed or left uncommitted; retrying the same session is
  idempotent because normalized URLs and job idempotency keys remain unique.
- Allows the user to cancel uncommitted rows.
- Does not delete already committed bookmarks when AI processing is stopped.

### 10.10 Import completion

Completion summary shows:

- Imported.
- Duplicate CSV rows skipped.
- Existing library bookmarks kept.
- Invalid.
- Organized.
- Waiting for AI.
- Sent to Need for Review.
- Thumbnails copied.
- Thumbnails unavailable or failed.
- Unsupported highlights detected.

The user may download the import report.

---

## 11. Chrome and Firefox extensions

### 11.1 Purpose and support

Later Gator provides browser extensions for current stable Chrome and Firefox.

Clicking the toolbar icon opens a compact bookmark-capture popup inspired by the supplied reference:

- Thumbnail preview.
- Page title.
- Short description preview when available.
- Note.
- Folder.
- Tags.
- Source URL.
- Linked-to URL.
- Favorite control.
- Save action.

The Later Gator extension uses its own visual identity and does not copy another product's branding.

### 11.2 Popup fields

**Source URL**

- Required.
- Automatically populated from the active browser tab.
- Editable before save.
- Must be a valid HTTP or HTTPS URL.

**Linked to**

- Optional.
- Accepts one HTTP or HTTPS URL.
- Creates the linked-bookmark behavior defined in Section 7.10.
- Is labelled with explanatory help:
  > Save another bookmark related to this page, such as the article linked from an X post.

**Note**

- Optional user note.
- Saved exactly as user-authored content.

**Folder**

- Defaults to Unsorted.
- Offers only the immutable Later Gator folders.
- Saving directly to a permanent content folder is treated as manual filing and does not allow AI to move that bookmark automatically.

**Tags**

- Optional.
- Suggests active tags from the Later Gator library.
- Allows new tags using the same normalization rules as the dashboard.

**Favorite**

- Optional toggle.
- Defaults to off.

### 11.3 Metadata and thumbnail preview

When the popup opens:

- Show the active-tab URL immediately.
- Request title, description preview, and preview image when browser permissions allow.
- Show a placeholder while metadata is unavailable.
- Never delay URL capture indefinitely while waiting for metadata.
- Let the user save even when title, description, or thumbnail lookup fails.

The preview image is not considered permanently saved until Later Gator has validated, normalized, and stored it under the thumbnail rules.

### 11.4 Save behavior and feedback

The Save button has explicit states:

- Ready.
- Saving.
- Saved.
- Partially saved.
- Failed.

Requirements:

- Disable duplicate Save submissions while one request is active.
- Report **Saved** only after Later Gator confirms the source bookmark commit.
- If a linked-to URL was supplied, report **Saved and linked** only after both bookmark existence and relationship creation are confirmed.
- If the source bookmark is already present, treat the request idempotently and show **Already saved** as a successful outcome.
- If the source saves but the linked bookmark fails, show **Source saved; link failed** with a retry action.
- A failure message contains a safe reason such as authentication required, invalid URL, unavailable deployment, or storage limit reached.
- Closing the popup after a confirmed save does not cancel AI processing.
- Saving from the dashboard never pauses unrelated AI work.

### 11.5 Extension connection and security

The extension never stores the Later Gator password or MCP secret.

Settings provides a dedicated browser-extension connection flow:

- Pair extension.
- Show connected browser/device label.
- Show last successful capture time.
- Revoke one connection.
- Revoke all capture connections.

The capture credential is scoped only to the minimum extension actions required to:

- Read fixed folders and active tags for the popup.
- Save a bookmark.
- Create the optional linked bookmark and relationship.
- Check the result of its own save.

It cannot:

- Delete bookmarks or tags.
- Change AI provider or personalization.
- Import CSV files.
- Read arbitrary bookmark content.
- Access MCP.

### 11.6 Extension installation

Settings and the README provide Chrome and Firefox installation instructions.

The final distribution channel—official browser stores or a documented self-install path—must be decided before implementation. The user-facing installation must explain permissions before installation and must not request browsing-history access beyond what capture requires.

---

## 12. iOS Share Sheet Shortcut

### 12.1 Purpose

Later Gator provides an installable Apple Shortcut that appears in the iOS and iPadOS Share Sheet.

It saves the shared link directly to Unsorted with minimal interaction.

### 12.2 Input and save behavior

The Shortcut:

- Accepts one shared HTTP or HTTPS URL.
- Does not ask for a note.
- Does not ask for tags.
- Does not ask for a folder.
- Does not accept a linked-to URL.
- Saves to Unsorted.
- Makes the bookmark eligible for normal sequential AI organization.
- Treats an already-saved URL as a successful idempotent outcome.

If the shared item does not contain a usable URL, the Shortcut fails without creating a bookmark.

### 12.3 User feedback

The Shortcut always ends with visible feedback.

Success:

- Display **Saved to Later Gator** only after the bookmark is committed.
- An already existing bookmark may display **Already saved in Later Gator** while remaining a successful result.

Failure:

- Display **Failed to save to Later Gator**.
- Include a short safe reason when available.
- Offer to open Later Gator Settings when the connection needs repair.

The Shortcut must not show success merely because it sent a network request. A confirmed application response is required.

### 12.4 Shortcut connection and security

Settings provides:

- **Install iOS Shortcut** instructions.
- A generated capture endpoint or installation payload.
- Connection test.
- Connected/not-configured state.
- Last successful iOS capture time.
- Rotation or revocation.

The Shortcut does not contain the Later Gator password or MCP secret. Its credential is scoped only to idempotently add one URL to Unsorted and receive that operation's result.

### 12.5 Offline and unavailable behavior

- The initial v6.0 Shortcut does not claim a bookmark is queued locally when the Later Gator deployment cannot be reached.
- An offline or timed-out request reports failure.
- The iOS share sheet remains responsive and allows the user to dismiss the result.
- Automatic offline retry is deferred unless separately approved.

---

## 13. AI provider and model management

### 13.1 Supported providers

- Cloudflare Workers AI, default.
- OpenAI with the user's API key.
- Anthropic with the user's API key.

### 13.2 Provider switching

Settings separates:

- Active provider/model.
- Candidate provider/model.

Switching sequence:

1. Choose a provider and model.
2. Enter or replace the provider key when required.
3. Run a synthetic connection and structured-output test.
4. Activate only after success.

Rules:

- The current provider remains active if candidate testing fails.
- A switch affects the next bookmark that starts processing.
- An in-progress bookmark finishes under its captured provider/model unless a
  newer bookmark revision requires the stale result to be discarded and retried.
- Switching never reprocesses completed bookmarks.
- Switching never changes imported preserved data retroactively.
- Later Gator never silently falls back to another provider.

### 13.3 Usage reporting

Later Gator presents account-wide Workers AI usage through Cloudflare's authoritative dashboard.

Requirements:

- Do not estimate tokens from character counts.
- Do not display an estimate as actual neurons.
- Do not maintain or display a Later Gator usage ledger for OpenAI or Anthropic.
- Do not claim that Later Gator-only requests equal account-wide Cloudflare usage.
- Link clearly to the Cloudflare dashboard when the platform does not expose authoritative account-wide neuron consumption to the Worker.
- Provider/model and safe operational outcomes may be logged, but token and neuron usage are not persisted.

### 13.4 Limits

Cloudflare Workers AI:

- Respect Cloudflare's actual free-allocation response.
- When the free allocation is exhausted, leave bookmarks pending until service becomes available after the UTC reset.
- Show the authoritative Cloudflare dashboard link.

OpenAI and Anthropic:

- Later Gator imposes no application-level daily token budget.
- Provider rate limits, account billing, and provider access remain authoritative.

All providers:

- Retain bounded per-request context and output sizes.
- Those request bounds protect schema reliability and do not represent a daily user quota.

---

## 14. Settings

Settings contains:

### 14.1 Profile and personalization

- Career context.
- Aspiration context.
- Personal AI instructions.

Changes apply to bookmarks whose AI work starts afterward.

### 14.2 AI provider

- Active provider and model.
- Candidate provider and model.
- External-provider key replacement/removal.
- Connection test.
- Activation.
- Provider status.
- Account-wide Workers AI usage entry point.
- Provider dashboard links.

### 14.3 Import and export

- Upload a Raindrop CSV.
- Review prior import sessions and reports.
- Export the Later Gator library in a documented portable format.
- Explain that Raindrop is an import source, not a synchronized connection.

### 14.4 MCP

- Generate and copy the MCP URL.
- Show ChatGPT and Claude setup instructions.
- Test the connection.
- Rotate the MCP connection address.
- Show connected/not-configured status.

### 14.5 Reset for testing

- A strongly confirmed **Delete everything and restart setup** action is available
  for test deployments.
- It deletes bookmarks, tags, thumbnails, imports, capture/MCP connections,
  provider credentials, and personalization, then returns the deployment to setup.
- It retains only the Later Gator password configuration and current authenticated
  session needed to complete the redirect.

### 14.6 Automation

- AI running/paused status.
- Pause or resume.
- Current bookmark.
- Pending count.
- Organized count and percentage.
- Processing, provider-wait, paused, review, and failed counts.
- Need for Review count.
- Persistent provider problem and remediation.

### 14.7 Capture surfaces

- Pair, inspect, and revoke Chrome and Firefox extension connections.
- Install or repair the iOS Share Sheet Shortcut.
- See the last successful capture from each connected surface.
- Rotate capture credentials without rotating MCP or changing the Later Gator password.

### 14.8 Security

- Change the Later Gator password through the supported Cloudflare/application flow.
- Log out.
- Rotate MCP address.
- Review active session information where available.

---

## 15. MCP

### 15.1 Purpose

MCP lets an authorized ChatGPT or Claude client search and inspect the Later Gator library.

### 15.2 Initial tool surface

- `get_context()` — returns current date, timezone, fixed folders, active tags, and tag counts.
- `search_bookmarks(...)` — searches Later Gator bookmarks using text, tags, folder, site, and dates.
- `get_bookmark(id)` — returns one bookmark's approved fields, thumbnail availability, favorite state, and related bookmark summaries.
- `get_library_status()` — reports bookmark counts, AI status, import progress, and provider status.

MCP search queries the Later Gator-owned library. It never calls Raindrop.

### 15.3 MCP mutation boundaries

MCP cannot:

- Delete bookmarks.
- Delete tags.
- Import a CSV.
- Change provider or model.
- Change personalization.
- Reset setup.
- Rotate its own secret.

Bookmark mutation tools are outside v6.0 unless separately approved.

### 15.4 MCP security

- Later Gator generates the machine secret.
- The user copies one complete connection URL.
- The secret can be rotated from Settings.
- Invalid credentials reveal no library or account detail.
- Raw MCP URLs and secrets are excluded from application logs.

---

## 16. Free-tier operating target

### 16.1 Product target

The default deployment targets an ordinary personal bookmark library on Cloudflare's free services without requiring a credit card.

The target assumes:

- Single user.
- Text bookmark metadata, not archived copies of entire web pages.
- One small normalized thumbnail per bookmark.
- No uploaded PDFs, videos, or large binary files.
- Indexed, paginated dashboard queries.
- Sequential AI work.
- Modest MCP and dashboard traffic.

### 16.2 Current verified external envelope

At the 2026-07-29 review:

- Cloudflare D1 Free documents 5 million rows read per day, 100,000 rows written per day, and 5 GB total account storage.
- Cloudflare documentation also retains a 500 MB per-database limit for Workers Free accounts.
- Workers KV on Workers Free currently includes 1 GB stored data, 100,000 reads per day, and 1,000 writes, deletes, and list operations per day; an individual value may be up to 25 MiB.
- Cloudflare Images Free currently includes 5,000 unique transformations per month and can transform image streams supplied by the Worker.
- Browser Run Free currently includes 10 minutes of browser execution per day
  and three concurrent browsers. The current deployment does not bind or consume
  Browser Rendering; these limits matter only if screenshot generation is
  reconsidered later.
- Workers Free documents 100,000 dynamic requests per day.
- Static asset requests are free and unlimited.
- Workers AI provides 10,000 free neurons per UTC day, subject to current model rates and plan rules.

These values can change and must be rechecked before implementation and release.

### 16.3 Limit behavior

Later Gator must not claim unlimited free capacity.

If a storage or daily database limit is reached:

- Preserve existing data.
- Keep the application read-only where Cloudflare permits.
- Block new mutations with a clear message.
- Provide export and cleanup guidance.
- Never silently discard an import or bookmark.
- Never opt the user into a paid plan automatically.

If the Workers KV storage or operation allowance is reached:

- Continue saving bookmark metadata without a thumbnail when database capacity remains.
- Show that thumbnail capture is unavailable.
- Provide thumbnail cleanup and export guidance.
- Never block a bookmark solely because its thumbnail could not be stored.

If a Workers or AI limit is reached:

- Keep stored bookmarks intact.
- Explain which capability is temporarily unavailable.
- Resume normal behavior when the external service becomes available.

### 16.4 Launch validation

Before claiming free-tier suitability, test representative libraries at:

- 1,000 bookmarks.
- 10,000 bookmarks.
- The largest library expected for the initial target user.

Measure:

- Database size.
- Indexed search rows read.
- Writes per import and AI organization.
- Dashboard request volume.
- AI usage per bookmark.
- Export size and duration.
- Average and maximum thumbnail size.
- Workers KV storage and object-operation usage.
- Thumbnail cache behavior.
- Browser-extension and iOS capture traffic.

---

## 17. Privacy, data ownership, and export

- Bookmark content stays inside the user's Cloudflare deployment except when sent to the user-selected AI provider for organization.
- Provider selection explains that bookmark content will be sent to that provider.
- API keys are encrypted before application storage and never returned to the browser.
- Logs exclude bookmark titles, descriptions, notes, full URLs, provider keys, Later Gator password, and MCP secret.
- Thumbnail objects remain private and are served only through an authorized Later Gator path.
- Browser-extension and iOS capture credentials are separate, scoped, and independently revocable.
- The user can export their Later Gator library.
- Uninstall instructions warn the user to export first.
- Deleting the Cloudflare data store deletes the Later Gator library and cannot be reversed by the application.
- Later Gator does not retain a hidden copy outside the user's deployment.

---

## 18. Accessibility and interaction requirements

- Setup and dashboard are usable with keyboard navigation.
- Forms have visible labels and validation summaries.
- Read-only details and editable bookmark forms are communicated by text and
  structure, not color alone.
- Destructive tag, bookmark, Trash, and import actions require clear confirmation.
- Long imports expose progress without trapping keyboard or screen-reader users.
- Empty, loading, waiting, paused, error, and success states are distinct.
- Mobile layout supports viewing, search, simple edits, and bookmark creation.
- Desktop layout supports efficient bulk selection and filtering.
- Browser-extension popup controls are keyboard accessible and fit within common extension-popup dimensions without clipped actions.
- iOS Shortcut feedback uses explicit text and does not rely only on sound, vibration, or color.

---

## 19. Testing requirements

### 19.1 Deployment and authentication

- Deploy form shows an empty **Later Gator password** field.
- Root URL shows login without requiring `/setup`.
- Successful login routes to setup or dashboard according to state.
- Invalid sessions expose no private data.

### 19.2 Setup

- Fewer than five tags cannot complete the tag step.
- Career and aspiration context persists.
- Personal instructions can be skipped.
- Import can be skipped.
- MCP controls are absent from setup and available in Settings.
- Setup completes and redirects to dashboard.

### 19.3 Dashboard

- All required sort orders work.
- Filters compose and can be cleared.
- Fixed folders cannot be renamed or deleted.
- Bookmark moves preserve bookmark identity.
- Delete and restore through Trash work.
- Per-bookmark editing never pauses unrelated AI work.
- Thumbnail display, replacement, regeneration, Trash restoration, and permanent cleanup work.
- Favorite state persists and filters correctly.
- Linked bookmarks display from both records without replacing either URL.

### 19.4 Tag behavior

- Individual tag add/remove works.
- Global deletion removes the tag from every bookmark.
- Global deletion does not remove bookmarks.
- Retired tags are not recreated by AI output.
- Explicit restore makes the tag usable again.

### 19.5 AI processing

- Processing is sequential.
- New Unsorted bookmarks become eligible immediately.
- Stale AI results cannot overwrite a user edit.
- Provider switching affects the next item only.
- Temporary provider failures preserve pending work.
- A stale or cancelled job cannot leave a bookmark pending without a live
  replacement job.
- Invalid output cannot reach stored bookmark fields.
- Repeated invalid output routes to Need for Review.

### 19.6 Import

- CSV parsing supports quoted commas, multiline notes, Unicode, and common Raindrop headers.
- Preview performs no bookmark commit.
- Invalid rows, within-file duplicates, and existing-library conflicts are reported.
- Option A removes imported tags/descriptions and queues Unsorted organization.
- Option B retains imported tags/descriptions and uses Unsorted until classification.
- Imported folders are not created.
- Interrupted commit can resume without duplicates.
- Closing the dashboard does not cancel already committed AI processing.
- The supplied `id`, `excerpt`, `cover`, `favorite`, and empty `highlights` columns receive the documented treatment.
- Valid covers are copied into private thumbnail storage without depending permanently on the remote URL.
- Non-empty unsupported highlights produce a visible preview warning.

### 19.7 Browser-extension capture

- Chrome and Firefox popups prefill the active-tab Source URL.
- Source URL and Linked to are validated independently.
- Saving a new linked-to URL creates a second Unsorted bookmark and a relationship.
- Saving an existing linked-to URL reuses it without duplication.
- Identical source and linked URLs are rejected.
- Partial source/link failure is reported accurately.
- Duplicate clicks do not create duplicate bookmarks.
- Capture remains independent of an open dashboard editor.
- Revoked capture credentials cannot save or read suggestions.

### 19.8 iOS Shortcut

- One shared URL saves to Unsorted.
- The Shortcut never asks for note, tags, folder, or linked URL.
- Confirmed commit shows **Saved to Later Gator**.
- Duplicate URL is an idempotent successful outcome.
- Invalid, offline, unauthorized, and unavailable requests show failure.
- The Shortcut never returns success without application confirmation.
- Revocation prevents later saves.

### 19.9 Usage

- Character-count estimates are never displayed as real usage.
- OpenAI and Anthropic usage are not recorded by Later Gator.
- Account-wide Workers AI usage is shown through Cloudflare's authoritative dashboard.
- Missing platform usage data is shown as unavailable, not guessed or reconstructed.

### 19.10 Free-tier validation

- Indexed queries remain within measured read budgets.
- Large imports fail safely before exceeding storage.
- Cloudflare limit errors preserve existing bookmarks.
- The application never requests or performs an automatic paid-plan upgrade.
- Thumbnail storage is measured separately from bookmark database storage.
- Workers KV capacity or operation-limit failure does not prevent bookmark metadata from being saved.

---

## 20. Out of scope for v6.0

- Runtime Raindrop API integration.
- Raindrop token storage.
- Two-way or one-way continuous Raindrop synchronization.
- Recreating imported Raindrop folder hierarchies.
- User-created or nested folders.
- Multi-user accounts, sharing, or collaboration.
- User-uploaded PDF, video, or arbitrary binary-file storage beyond one supported thumbnail per bookmark.
- Full archived copies of web pages.
- A native iOS, iPadOS, Android, macOS, Windows, or Linux application.
- Vector database or embedding-based semantic search.
- AI bulk rewriting of already organized bookmarks.
- Automatic duplicate merging.
- Arbitrary bookmark mutation through MCP.
- Automatic external email alerts unless separately approved.
- A user-visible Queue, lease, dispatch revision, tag resynchronization, or deferral-time system.
- Automatic paid-plan upgrades.

---

## 21. Deliberately deferred

- Saved searches and smart folders.
- Tag rename and bulk merge.
- Duplicate-review workflow.
- Bookmark highlights and annotations beyond a note.
- Full-text extraction from destination pages.
- Full-page screenshot archives and multiple images per bookmark.
- Automatic offline retry for the iOS Shortcut.
- Safari extension and Android Share Sheet integration.
- AI reorganization of selected existing bookmarks.
- Multi-select AI actions.
- Email or push notifications.
- OAuth-based MCP authorization.
- User-configurable folder taxonomy.
- Multi-user deployments.

---

## 22. Settled decisions in v6.0

1. Later Gator, not Raindrop, is the bookmark system of record.
2. Raindrop is supported only through optional CSV import.
3. The application does not request or store a Raindrop token.
4. Root URL handles login and routes automatically; the user does not append `/setup`.
5. The deploy form calls the blank required secret **Later Gator password**.
6. Setup requires at least five relevant tags plus career and aspiration context.
7. Personal AI instructions are optional.
8. CSV import is optional during setup and remains available later.
9. MCP configuration is available only in Settings.
10. Successful setup routes to `/dashboard`.
11. The dashboard is the Later Gator bookmark manager.
12. Folder names and folder existence are immutable.
13. Tags may be removed from individual bookmarks or deleted globally.
14. Globally deleted tags are retired and cannot be silently recreated by AI.
15. View mode is the default.
16. Per-bookmark revision checks protect user edits without a global edit mode.
17. The 15-minute Raindrop discovery schedule is removed from the product.
18. AI processing begins from stored pending state and remains sequential.
19. Import option A removes imported tags/descriptions and organizes from Unsorted.
20. Import option B retains imported tags/descriptions, allows additional AI tags, and classifies from Unsorted.
21. Imported Raindrop folders are not recreated.
22. Cloudflare Workers AI remains the default provider.
23. OpenAI and Anthropic remain optional bring-your-own-key providers.
24. Provider/model switching affects future processing only.
25. Rough character-based AI usage estimates are prohibited.
26. OpenAI and Anthropic have no Later Gator daily token budget.
27. Free-tier operation is a measured target, not an unlimited-capacity promise.
28. Bookmark thumbnail binaries are stored as private Workers KV values rather than in the bookmark database.
29. Imported Raindrop `cover` values are candidate thumbnail sources.
30. Chrome and Firefox extensions are in scope.
31. The browser-extension popup contains separate Source URL and Linked to fields.
32. Linked URLs remain separate bookmarks connected by a relationship.
33. For X handling, the X post and external destination are not collapsed into one bookmark.
34. An iOS Share Sheet Shortcut saves one URL directly to Unsorted without note or tag input.
35. Browser-extension and iOS capture surfaces must report confirmed success or failure.
36. Capture credentials are separate from the Later Gator password and MCP secret.
37. The supplied CSV's `excerpt`, `cover`, and `favorite` fields receive explicit import treatment.

---

## 23. Resolved implementation decisions

The implemented product resolves the earlier open questions as follows:

1. Career and aspiration answers are required during setup.
2. Setup accepts 5–20 distinct normalized topics.
3. A Raindrop CSV may be at most 10 MiB and 5,000 rows.
4. Reorganize import does not retain a hidden description, tags, notes, or
   discarded CSV content after commit.
5. Duplicate identity normalizes scheme/hostname case, fragments, default
   ports, and an empty path; it does not silently remove tracking parameters.
6. Dashboard creation uses the supplied title or hostname fallback. It does not
   block saving on destination-title extraction.
7. Imports is a hidden compatibility row, not a user-visible destination. New
   imports of either type are stored in Unsorted.
8. Saving directly into a permanent folder is a manual organization decision
   and does not create an AI organization job.
9. Portable launch exports are JSON and CSV.
10. Email alerts remain deferred.
11. Browser Rendering screenshot capture is omitted from the current deployment;
    page metadata and provided cover candidates are used instead.
12. Chrome and Firefox begin with documented self-installation.
13. Linked bookmarks use one generic `related` relationship.
14. A newly created Linked to bookmark always begins in Unsorted.
15. The iOS Shortcut uses guided manual installation and a scoped generated
    credential.

---

## 24. External references requiring revalidation

Cloudflare:

- [D1 pricing and free limits](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 release notes and per-database Free-plan limit](https://developers.cloudflare.com/d1/platform/release-notes/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers static assets](https://developers.cloudflare.com/workers/static-assets/)
- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Workers KV pricing](https://developers.cloudflare.com/kv/platform/pricing/)
- [Workers KV platform limits](https://developers.cloudflare.com/kv/platform/limits/)
- [Cloudflare Images transformations pricing](https://developers.cloudflare.com/images/pricing/)
- [Browser Run pricing](https://developers.cloudflare.com/browser-run/pricing/)

Raindrop import/export reference:

- [Raindrop export and backup](https://help.raindrop.io/export)
- [Raindrop CSV import field reference](https://help.raindrop.io/import)

External constraints are not permanent product facts. Recheck them before technical design completion and release.
