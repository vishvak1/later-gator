# Later Gator control plane

This Worker owns Cloudflare identity sessions, installation-management metadata,
and public signing keys. It never receives bookmark content, thumbnails, AI
provider keys, prompts, or responses.

Production requires six secrets:

- `CLOUDFLARE_IDENTITY_CLIENT_ID`;
- `CLOUDFLARE_IDENTITY_CLIENT_SECRET`; and
- `CLOUDFLARE_ACCESS_TEAM_DOMAIN`, the exact `https://<team>.cloudflareaccess.com` issuer;
- `CLOUDFLARE_ACCESS_AUD`, the audience tag for the protected `/auth/access` application;
- `INSTALLER_TOKEN_ENCRYPTION_KEY`; and
- `OWNER_ASSERTION_SIGNING_KEYS`, a bounded JSON ES256 key ring whose
  `activeKid` selects one private P-256 key and whose retained keys publish
  through `/.well-known/later-gator-jwks.json` for rotation-safe verification.

Generate signing keys offline, add a new active key before removing an old
public key, and retain the previous public key beyond the maximum five-minute
assertion lifetime and deployment propagation window. Never place production
private JWK material in source, Wrangler vars, logs, or the browser.

The current private and public OAuth client definitions, scopes, and callbacks
are recorded in the control-plane section of
[`docs/developer-guide.md`](../../docs/developer-guide.md).

This package implements the managed-BYOC control plane. It is not deployed by
the repository's root `deploy` command; development deployment uses the
dedicated commands below and the main-branch workflow.

## Present scope

- Cloudflare Access login through the Cloudflare identity provider;
- RS256 Access application-token verification against the configured team
  issuer, application audience, and rotating remote JWKS;
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

Create a Cloudflare Access self-hosted application for the development hostname
with the exact protected path `/auth/access`. Use an Allow policy for everyone
who successfully authenticates, select only the Cloudflare identity provider,
and disable **Restrict to account members** so owners of other Cloudflare
accounts can sign in. Copy its team domain and Application Audience tag into
the Worker secrets named above.

Register a private development OAuth client only for installer authorization,
with this exact callback:

```text
https://later-gator-control-plane-dev.vishvak-v.workers.dev/install/cloudflare/callback
```

The production installer callback is
`https://latergator.app/install/cloudflare/callback`. The authoritative Access,
installer, and Chrome redirect inventory is in
[`docs/developer-guide.md`](../../docs/developer-guide.md).

The OAuth client is used only for installation and managed updates. Its
`user-details.read` scope binds installer consent to the verified Access email;
the remaining scopes manage the declared Cloudflare resources. Ordinary login
never opens an OAuth consent screen and never returns an OAuth token to Later
Gator.

Create `apps/control-plane/.dev.vars` locally and do not commit it:

```dotenv
CLOUDFLARE_IDENTITY_CLIENT_ID="..."
CLOUDFLARE_IDENTITY_CLIENT_SECRET="..."
CLOUDFLARE_ACCESS_TEAM_DOMAIN="https://<team>.cloudflareaccess.com"
CLOUDFLARE_ACCESS_AUD="..."
INSTALLER_TOKEN_ENCRYPTION_KEY="..."
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

Local tests use signed fake Access tokens, fake provider responses, and
test-only key material. Live acceptance requires both the Access path and the
registered installer callback; never place client secrets in `wrangler.jsonc`
or a shell command.

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
- the renewable managed-update authorization remains active.

The managed product exposes no update opt-out or release pin. If authorization
is revoked directly in Cloudflare, the dashboard requires re-authorization
before the installation is considered managed again.

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
