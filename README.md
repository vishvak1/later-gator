# Later Gator

Later Gator is a private, single-user bookmark manager that runs in your own
Cloudflare account. It stores the library in D1, stores normalized thumbnails
privately in Workers KV or R2, and can organize new bookmarks with Cloudflare
Workers AI, OpenAI, or Anthropic.

Raindrop is optional and is used only as a CSV import source. Later Gator never
connects to, changes, or deletes data in your Raindrop account.

## Single personal instance

Later Gator is maintained for one owner. One Cloudflare Worker serves sign-in,
the dashboard, capture APIs, MCP, and bookmark processing. There is no public
installer, management service, hosted catalog, or automatic release rollout.

Sign in directly with the `PASSWORD` Worker secret (at least 16 characters).
Provider credentials remain encrypted using `INSTANCE_MASTER_KEY`, independently
of the login password. Follow the [deployment guide](docs/developer-guide.md#15-direct-deployment-and-upgrades)
to configure resources and upgrade an existing instance safely.

## Setup

The guided setup asks for:

- At least five topics most relevant to you; the vocabulary can grow freely.
- Optional personal instructions for the organizing AI.
- An optional Raindrop CSV import for either a full-library export or a
  single-folder/collection export.

For a Raindrop import, Later Gator offers two choices:

- **Reorganize:** remove imported tags and descriptions, place the bookmarks in
  Unsorted, and let AI classify them.
- **Preserve:** retain imported tags and descriptions, merge tags into the
  Later Gator vocabulary, place the bookmarks in Unsorted, and ask AI to choose
  permanent folders without removing imported tags.

Duplicate URLs inside the CSV are skipped after the first valid row. If a URL
already exists in Later Gator, the current bookmark is kept unchanged. A direct,
chunked D1 operation adds accepted rows to Unsorted, then background
organization resumes according to the owner's pause setting. Imported CSV files
are not retained.
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

Run `npm run build:extensions` to generate the Chrome install folder. Settings
can then create separately scoped credentials for:

- The included Chrome extension in `extension/chrome`.
- An iOS Share Sheet Shortcut that accepts only a URL and reports Saved or
  Failed.
- Read-only OAuth connections for ChatGPT, Claude, and compatible MCP clients.

Capture credentials can be revoked independently. AI assistants use OAuth
instead of a copied secret.

Settings generates one copyable command for Codex and one for Claude Code. Each
command runs `mcp add` followed by `mcp login`, so installation immediately opens
the browser authorization flow. If the runtime browser session has expired, the
personal Worker shows its own password sign-in and resumes the pending MCP approval automatically. No developer
mode or copied secret is required. The stable MCP URL and all private MCP calls
remain on the personal Worker. Settings lists each active grant with last-used activity and an
independent Disconnect action.

The generated Claude command targets current Claude Code releases that expose
`claude mcp login`. Older releases can complete the same OAuth flow from `/mcp`
inside Claude Code after adding the server.

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
npm run db:init:local
npm run dev
npm run check
npm run build
```

Copy `apps/runtime/.dev.vars.example` to `apps/runtime/.dev.vars` and fill in
the two secrets before local development. `npm run build` validates a production
bundle without deploying. `npm run deploy` updates your Cloudflare instance.

## Documentation

- [Product Requirements](docs/product-requirements.md)
- [Technical Design](docs/technical-design.md)
- [Developer Guide](docs/developer-guide.md)
- [Security status](SECURITY.md)

These three files are the only active product, architecture, and developer
specifications for 1.0.0. Earlier history remains in Git rather than as
competing documents in `docs/`.

## Uninstall

Export the library first. Remove the Worker and its resources manually in your
Cloudflare account only when you intend to delete them. Removing Later Gator
does not change the original Raindrop account or CSV export.
