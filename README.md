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
3. In the blank **Later Gator password** field, choose a password of at least
   10 characters and save it somewhere safe.
4. Finish the deployment and open the Worker URL.
5. Sign in. Later Gator automatically sends an unfinished installation to
   `/setup`; after setup it sends you to `/dashboard`.

Cloudflare provisions the Worker, D1 database, private Workers KV thumbnail namespace,
Workers AI binding, image transformation binding, and sequential background
Queue. There is no scheduled Cron trigger.

## Setup

The guided setup asks for:

- 5–20 topics most relevant to you.
- Your career and what you aspire to become.
- Optional personal instructions for the organizing AI.
- An optional Raindrop CSV import.
- Optional read-only MCP configuration.

For a Raindrop import, Later Gator offers two choices:

- **Reorganize:** remove imported tags and descriptions, place the bookmarks in
  Unsorted, and let AI classify them.
- **Preserve:** retain imported tags and descriptions, merge tags into the
  Later Gator vocabulary, place the bookmarks in Imports, and ask AI only to
  choose permanent folders.

The import is previewed before it is committed. Imported CSV files are not kept
after staging; bookmark data becomes part of the D1 library and thumbnail
candidates are converted to bounded, uncropped WebP previews and stored as private
Workers KV values. The dashboard preserves their natural aspect ratios in a masonry
layout.

## Library behavior

- Permanent folders cannot be renamed or deleted.
- Tags can be retired globally without deleting bookmarks and can later be
  restored.
- Bookmark creation, editing, relationships, filtering, date ranges, sorting,
  Trash, restore, and permanent deletion are supported.
- View mode is the default. Entering edit mode pauses AI writes; leaving edit
  mode safely resumes eligible work.
- New AI work is created immediately when a bookmark is saved. The Queue carries
  only opaque job IDs and processes one job at a time.
- Every AI proposal is schema-validated and applied only if the bookmark
  revision still matches. User edits therefore win over stale AI work.

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

- [Product Requirements v6](docs/product-requirements-v6.md)
- [Technical Design v2](docs/technical-design-v2.md)
- [Developer Guide v2](docs/later-gator-developer-guide-v2.md)
- [Security status](SECURITY.md)

The older v5 documents remain in `docs/` as migration history, not as the active
product specification.

## Uninstall

Export the library first if you want to keep it. Then delete the Worker, D1
database, thumbnail Workers KV namespace, and Queue from the Cloudflare dashboard. Removing
Later Gator does not change the original Raindrop account or CSV export.
