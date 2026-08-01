# Later Gator

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/vishvak1/later-gator)

Later Gator is a private, single-user bookmark manager that runs in your own
Cloudflare account. It stores the library in D1, stores normalized thumbnails
privately in Workers KV, and can organize new bookmarks with Cloudflare Workers AI,
OpenAI, or Anthropic.

Raindrop is optional and is used only as a CSV import source. Later Gator never
connects to, changes, or deletes data in your Raindrop account.

## Install

1. Press **Deploy to Cloudflare**.
2. Sign in to GitHub and Cloudflare and approve the requested resources.
3. In the blank **Later Gator password** field, choose a non-empty password.
   Sixteen or more characters is strongly recommended, and it should be saved
   somewhere safe. Login does not impose a 10-character minimum so an existing
   deployment password remains usable.
4. In the **Vectorize** section, enter these two values exactly:

   | Field | Value |
   |---|---|
   | Dimensions | `1024` |
   | Metric | `cosine` |

   Cloudflare's deploy form cannot read these from this repository
   ([workers-sdk#14075](https://github.com/cloudflare/workers-sdk/issues/14075)),
   so they are the only technical values you have to type. They match the
   `@cf/baai/bge-large-en-v1.5` embedding model used for search and **cannot be
   changed after the index is created** — a wrong value here means semantic
   search never returns results, and the index has to be deleted and recreated.
5. Finish the deployment and open the Worker URL.
6. Sign in. Later Gator automatically sends an unfinished installation to
   `/setup`; after setup it sends you to `/dashboard`.

Cloudflare provisions the Worker, D1 database, private Workers KV thumbnail namespace,
Workers AI binding, image transformation binding, Vectorize search index, and
sequential background Queue. There is no scheduled Cron trigger.

## Setup

The guided setup asks for:

- 5–20 topics most relevant to you.
- Your career and what you aspire to become.
- Optional personal instructions for the organizing AI.
- An optional Raindrop CSV import for either a full-library export or a
  single-folder/collection export.

For a Raindrop import, Later Gator offers two choices:

- **Reorganize:** remove imported tags and descriptions, place the bookmarks in
  Unsorted, and let AI classify them.
- **Preserve:** retain imported tags and descriptions, merge tags into the
  Later Gator vocabulary, place the bookmarks in Unsorted, and ask AI to choose
  permanent folders without removing imported tags.

The import is previewed before it is committed. Duplicate URLs inside the CSV
are skipped after the first valid row. If a URL already exists in Later Gator,
the current bookmark is kept unchanged. AI is paused while a set-based D1
operation adds accepted rows to Unsorted, then background organization resumes
according to the owner's pause setting. Imported CSV files are not retained.
Thumbnail discovery remains independent background work. The dashboard
preserves thumbnail aspect ratios in a masonry layout.

## Library behavior

- Permanent folders cannot be renamed or deleted.
- Tags can be retired globally without deleting bookmarks and can later be
  restored.
- Bookmark creation, editing, relationships, filtering, date ranges, sorting,
  Trash, restore, and permanent deletion are supported.
- Cards open in a details modal, and editing is scoped to that bookmark. There
  is no library-wide edit mode and editing one bookmark does not pause AI work
  for the rest of the library.
- New AI work is created immediately when a bookmark is saved. The Queue carries
  only opaque job IDs and processes one job at a time.
- Every AI proposal is schema-validated and applied only if the bookmark
  revision still matches. User edits therefore win over stale AI work, and the
  job is refreshed against the new revision instead of being orphaned.
- Settings shows organized, waiting, processing, provider-wait, review, and
  failed counts with live AI-sorting progress.
- Search matches meaning as well as words. Searching `ml` finds machine-learning
  bookmarks, and `machine learning` matches the `machine-learning` tag, because
  every bookmark is embedded into the Vectorize index alongside the lexical
  full-text index. If embeddings are unavailable, search quietly falls back to
  word matching instead of failing.
- X and Twitter URLs always route to Social Posts. When an X post links out to an
  article, Later Gator saves that destination as its own bookmark and relates the
  two instead of replacing the post URL.

## Capture and connections

Settings can create separately scoped credentials for:

- The included Chrome extension in `extension/chrome`.
- The included Firefox extension in `extension/firefox`.
- An iOS Share Sheet Shortcut that accepts only a URL and reports Saved or
  Failed.
- A read-only MCP URL for supported AI clients.

Generated credentials are shown once. They can be revoked or rotated without
changing the Later Gator password.

## AI providers and usage

Cloudflare Workers AI is the default. OpenAI and Anthropic credentials can be
tested and switched from Settings; credentials are encrypted before D1 storage.
Provider changes affect pending and future jobs without changing the library.

Later Gator does not record OpenAI or Anthropic usage. It also does not invent a
local token or neuron estimate for Workers AI. Settings links to Cloudflare's
account dashboard, which is the source for account-wide Workers AI usage.

## Local development

Use Node.js 22.18+ (or 24.11+) and install dependencies with `npm install`.

```sh
npm run db:migrate:local
npm run dev
npm run check
npm run build
```

`npm run build` is a dry-run production bundle and does not deploy. Production
deployment and migrations are deliberate release actions.

## Documentation

- [Product Requirements](docs/product-requirements.md)
- [Technical Design](docs/technical-design.md)
- [Developer Guide](docs/developer-guide.md)
- [Security status](SECURITY.md)

These three versionless files are the only active product, architecture, and
developer specifications. Superseded versions remain available through Git
history rather than as competing documents in `docs/`.

## Uninstall

Export the library first if you want to keep it. Then delete the Worker, D1
database, thumbnail Workers KV namespace, and Queue from the Cloudflare dashboard. Removing
Later Gator does not change the original Raindrop account or CSV export.
