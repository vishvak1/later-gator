# Later Gator

Later Gator is a private, single-user bookmark manager that runs in your own
Cloudflare account. It stores the library in D1, stores normalized thumbnails
privately in Workers KV or R2, and can organize new bookmarks with Cloudflare
Workers AI, OpenAI, or Anthropic.

Raindrop is optional and is used only as a CSV import source. Later Gator never
connects to, changes, or deletes data in your Raindrop account.

## Architecture and availability

The managed product has two deliberately separate Workers:

- `latergator.app` is the control plane. It signs owners in with Cloudflare,
  provisions installations, records content-free resource/release metadata,
  pairs the official Chrome extension, and manages runtime releases.
- Each owner has a personal runtime Worker in their own Cloudflare account. It
  serves the dashboard, capture APIs, MCP, and all bookmark processing. Private
  library data, thumbnails, provider credentials, prompts, responses, and
  application logs stay there.

The development control plane and the first disposable KV installation have
passed their initial connected-account test. The public OAuth clients, clean R2
installation, prior-version update/rollback drill, and Chrome Web Store release
are still release gates. The managed installer is therefore not yet presented
here as a public production service.

When public installation opens, the owner will sign in at `latergator.app`,
choose thumbnail storage, and approve the exact Cloudflare permissions shown in
the consent screen. Later Gator then provisions the personal Worker, D1, private
OAuth KV, optional thumbnail KV or R2, Vectorize index, and two Queues. No GitHub
fork, Wrangler command, resource ID, Later Gator password, or manual Vectorize
configuration is part of the managed owner journey.

The control plane redirects the owner to the personal runtime using a short-lived,
installation-bound assertion. Ordinary dashboard, extension, MCP, AI-provider,
and storage traffic goes directly to that runtime rather than through the
control plane.

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

In Settings, select **Connect ChatGPT** or **Connect Claude**. Claude opens with
the connector name and stable `/mcp` address prefilled; ChatGPT opens its
connector settings and Later Gator copies the address for the remaining paste.
The provider then redirects to the personal runtime, where the owner signs in
through Cloudflare and approves read-only access. Settings lists each grant independently, including last-used
activity and a Disconnect action. A successful install is confirmed by a Later
Gator tool call—not by asking the model whether a connector is installed. Enable
Later Gator's tools in each chat before using them.

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
npm run check:managed-byoc
npm run build
```

`npm run build` and `npm run check:managed-byoc` perform dry-run bundles and do
not deploy. Runtime and control-plane deployment commands mutate Cloudflare and
are deliberate release/acceptance actions.

## Documentation

- [Product Requirements](docs/product-requirements.md)
- [Technical Design](docs/technical-design.md)
- [Developer Guide](docs/developer-guide.md)
- [Security status](SECURITY.md)

These three files are the only active product, architecture, and developer
specifications for 1.0.0. Earlier history remains in Git rather than as
competing documents in `docs/`.

## Uninstall

Export the library first if you want to keep it. Managed uninstall requires a
separate confirmation before deleting personal Cloudflare resources. Managed
updates cannot be disabled independently because runtime, UI, AI-provider, and
schema compatibility must move together. Removing Later Gator does not change
the original Raindrop account or CSV export.
