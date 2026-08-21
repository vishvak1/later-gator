# Later Gator control plane

This Worker owns Cloudflare identity sessions, installation-management metadata,
and public signing keys. It never receives bookmark content, thumbnails, AI
provider keys, prompts, or responses.

Production requires three secrets:

- `CLOUDFLARE_IDENTITY_CLIENT_ID`;
- `CLOUDFLARE_IDENTITY_CLIENT_SECRET`; and
- `OWNER_ASSERTION_SIGNING_KEYS`, a bounded JSON ES256 key ring whose
  `activeKid` selects one private P-256 key and whose retained keys publish
  through `/.well-known/later-gator-jwks.json` for rotation-safe verification.

Generate signing keys offline, add a new active key before removing an old
public key, and retain the previous public key beyond the maximum five-minute
assertion lifetime and deployment propagation window. Never place production
private JWK material in source, Wrangler vars, logs, or the browser.

The current private and public OAuth client definitions, scopes, and callbacks
are recorded in
`../../planning/managed-byoc/cloudflare-oauth-inventory.md`.

This package implements the managed-BYOC control plane. It is not deployed by
the repository's root `deploy` command; development deployment uses the
dedicated commands below and the main-branch workflow.

## Present scope

- Cloudflare OpenID Connect identity login using Authorization Code, state,
  nonce, and S256 PKCE;
- RS256 ID-token verification against Cloudflare's pinned discovery/JWKS
  endpoints;
- opaque, hashed control-plane sessions with same-origin CSRF logout;
- short-lived installation-bound ES256 owner assertions and a rotation-safe
  public JWKS endpoint;
- explicit deletion of control-plane identity metadata;
- a D1 schema containing identity sessions and content-free audit events; and
- a signed-out landing page plus an authenticated `no installation` shell.

The control plane has no bookmark, thumbnail, model-choice, provider-key,
prompt, response, or capture tables and does not proxy personal application
traffic.

## Development setup

Register a private development OAuth client in Cloudflare with the exact HTTPS
callback URL that serves the development Worker:

```text
https://later-gator-control-plane-dev.vishvak-v.workers.dev/auth/cloudflare/callback
```

The public callback is
`https://latergator.app/auth/cloudflare/callback`. The authoritative identity,
installer, and Chrome client/redirect inventory is
[`cloudflare-oauth-inventory.md`](../../planning/managed-byoc/cloudflare-oauth-inventory.md).

The private development OAuth client is used for two purpose-separated flows:
identity requests only `user-details.read`, while installation and managed
updates request the declared Cloudflare resource-management scopes. The control
plane never treats identity authorization as deployment authorization.

Create `apps/control-plane/.dev.vars` locally and do not commit it:

```dotenv
CLOUDFLARE_IDENTITY_CLIENT_ID="..."
CLOUDFLARE_IDENTITY_CLIENT_SECRET="..."
OWNER_ASSERTION_SIGNING_KEYS='{"activeKid":"...","keys":[...]}'
```

Generate the ES256 key ring offline. Do not paste it into chat, source control,
Wrangler vars, or shell history; store its production value as a Worker secret.

From the repository root:

```bash
npm run types --workspace @later-gator/control-plane
npm run db:init:local --workspace @later-gator/control-plane
npm run dev --workspace @later-gator/control-plane
```

Local tests use fake provider responses and test-only key material. Live OAuth
acceptance uses the registered HTTPS development Worker callback; never place
client secrets in `wrangler.jsonc` or a shell command.

`wrangler.dev.jsonc` isolates the connected test-account Worker, origin, and D1
name from the future production configuration. The deliberately non-validation
commands `db:init:development` and `deploy:development` mutate remote state and
must run only during an explicitly authorized acceptance session.

## Main-branch deployment and managed updates

`.github/workflows/deploy-control-plane-dev.yml` validates pull requests into
`main`. After every push to `main`, it applies the additive control-plane schema
and deploys `later-gator-control-plane-dev`. The GitHub environment or
repository must provide these encrypted Actions secrets:

- `CLOUDFLARE_ACCOUNT_ID` for the development Cloudflare account; and
- `CLOUDFLARE_API_TOKEN`, restricted to that account and only the permissions
  required to apply the control-plane D1 schema and deploy the Worker.

The deployed development control plane runs its managed-update scheduler at
minute 17 of every hour. A control-plane-only commit never rewrites personal
Workers. Personal Workers are candidates only when all of these are true:

- `ACTIVE_RUNTIME_RELEASE` names a newer immutable runtime release;
- the installation is ready and belongs to the active rollout cohort; and
- the owner has not revoked the renewable managed-update authorization.

Never replace the bytes of a published release version. Runtime changes must be
published under a new release identifier, validated, and then selected through
`ACTIVE_RUNTIME_RELEASE`; the cohort health and rollback rules remain the
deployment gate.

## Validation

```bash
npm run check:managed-byoc
```

This runs contract validation, generated binding checks, strict TypeScript,
Workers-runtime tests, and a Wrangler dry-run bundle. It does not deploy.
