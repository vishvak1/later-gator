# Later Gator

Later Gator is a private, single-tenant Cloudflare Worker that steadily organizes Raindrop.io bookmarks and exposes safe, structured library search to MCP-capable clients such as ChatGPT and Claude.

The approved specifications are [PRD v5.4](docs/product-requirements-v5.4.md) and [Technical Design v1.4](docs/technical-design-v1.4.md).

## What it does

- Lets the owner enter and replace Raindrop, OpenAI, and Anthropic keys in the authenticated setup page. Keys are encrypted before KV storage and never displayed back.
- Offers Cloudflare Workers AI by default, with tested activation of OpenAI or Anthropic at any later time. Adding a key alone never changes providers.
- Handles onboarding exactly as specified:
  - An empty Raindrop account gets the eight seed folders and tag registry.
  - An existing account has bookmarks moved from owned folders to Unsorted, all Unsorted bookmark tags cleared, verified-empty owned folders deleted, and the seed folders and registry created.
- Discovers Unsorted bookmarks every 15 minutes, queues bookmark IDs only, and organizes one item at a time.
- Updates the original bookmark in place, preserving its original URL and excerpt in a protected note block.
- Routes known source domains deterministically, normalizes tags, reuses the live tag registry, and sends low-confidence or repeatedly failing items to Need for Review.
- Preserves the approved X/Twitter baseline: clean post titles and, when exactly one safe external destination is present, replace the bookmark URL and title while preserving the original post URL.
- Supports explicit faster backfill, pause/resume, rate-limit deferral, a conservative Workers AI daily budget, registry repair, redacted activity, and persistent-pause email alerts.
- Exposes exactly four MCP tools: `get_context`, `search_bookmarks`, `get_pipeline_status`, and `resume_pipeline`.

Raindrop remains the bookmark source of truth. Later Gator does not store bookmark content in KV, logs, or a separate search index.

> [!IMPORTANT]
> Existing-account onboarding is destructive to the old folder and tag organization. The owner is responsible for making any desired backup before confirming onboarding. Later Gator does not create, inspect, retain, validate, or restore backups.

## Deploy to Cloudflare

Publish this repository and use:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/vishvak1/later-gator)

The deployment needs:

- A KV namespace bound as `STATE`.
- Workers AI bound as `AI`.
- A Queue bound as `ORGANIZE_QUEUE`, with one-message batches and concurrency one.
- Email Sending bound as `EMAIL`.
- A 15-minute Cron Trigger.
- `INSTALLATION_SECRET`: a strong, unique password for `/setup` and credential encryption.
- `MCP_PATH_SECRET`: a separate cryptographically random string of exactly 64 characters.

The checked-in `wrangler.jsonc` declares these bindings and safe default limits. Cloudflare resource IDs and both secrets must be configured for the target account. Never commit real secret values.

## First setup

1. Open `https://<worker-host>/setup` and sign in with `INSTALLATION_SECRET`.
2. Enter and save the Raindrop token.
3. Keep Workers AI or enter an OpenAI/Anthropic key, test a model candidate, and activate it.
4. Optionally add personal instructions or acknowledge the warning before using a full prompt override.
5. Configure and test Cloudflare email, or explicitly acknowledge that intervention emails are unavailable.
6. Validate the installation.
7. Run the read-only onboarding check and confirm onboarding.
8. Continue the resumable onboarding action until complete.
9. Copy the private MCP URL into ChatGPT or Claude.
10. Let routine scheduling work through Unsorted, or start explicit backfill from the same page.

Entering or changing any credential, connecting an MCP client, or running Cron never starts onboarding.

## Permanent settings

After onboarding, `/setup` remains the private control centre. It shows lifecycle and automation state, leases, deferrals, AI provider and prompt revision, email readiness, folder IDs, tag registry, registry resync, redacted recent activity, backfill controls, the MCP connection URL, and uninstall instructions.

Changing the Raindrop token to a different account fails the account guard and does not initialize or mutate that account. Reset and onboarding remain explicit confirmed actions.

To rotate the MCP secret, replace `MCP_PATH_SECRET` in Cloudflare and update the connected clients. To rotate `INSTALLATION_SECRET`, replace it in Cloudflare and then re-enter stored credentials because the old encrypted envelopes intentionally become unreadable.

## Local development

Use Node.js 22.18+ or 24.11+ to satisfy the current dependency engine ranges.

```sh
npm install
cp .dev.vars.example .dev.vars
npm run types
npm test
npm run dev
```

Set two distinct local secrets in `.dev.vars`; the MCP value must contain exactly 64 characters. Raindrop and external-provider keys are entered through `/setup`.

Release gates:

```sh
npm run check
npm run build
npm run audit:production
```

Use only a dedicated Raindrop test account until all deployment gates in the Technical Design pass. Production-library experiments are prohibited.

## Operating behavior

- Temporary rate limits, overload, and daily Workers AI allowance stops defer work without email or item-failure promotion.
- Persistent credential, model, account, or configuration failures pause the pipeline and send one safe email when email is ready.
- Queue retries are bounded and honor provider reset timing when supplied.
- Registry counts are repaired from Raindrop once daily and can be rebuilt manually.
- Backfill dispatches bounded groups to the same sequential Queue and can safely continue after closing the browser.
- Search uses Raindrop’s supported search and filters endpoints, reports a true filters-derived total, returns at most 25 items for overly broad queries, and never creates an embedding index.

See [SECURITY.md](SECURITY.md) for dependency and release-security notes.
