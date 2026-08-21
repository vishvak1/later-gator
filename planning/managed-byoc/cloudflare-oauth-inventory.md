# Cloudflare OAuth authority, scope, and redirect inventory

**Verified:** 2026-08-20  
**Purpose:** authoritative platform inventory for `P0.6` and `P0.7`  
**Status:** current official Cloudflare endpoints and scope IDs; live client
registration remains an external acceptance action

## 1. Confirmed platform model

Cloudflare self-managed OAuth supports third-party Authorization Code clients,
public and private visibility, PKCE, and Cloudflare API permission scopes. Its
discovery document advertises OIDC endpoints, but live acceptance on 2026-08-20
proved that a dashboard-created resource client is not automatically allowed to
request `openid`: Cloudflare returned `invalid_scope` before consent.

Later Gator therefore anchors identity through the supported
`user-details.read` permission and `GET /client/v4/user`. The control plane
extracts only the stable Cloudflare user ID, immediately discards the access
token and all other response fields, and stores only a one-way subject hash.

Later Gator uses two clients:

1. **Confidential server client** — control-plane sign-in and later installer
   authorization; each request asks only for its required subset.
2. **Chrome client** — public PKCE client with no client secret; requests
   `user-details.read` for connection identity.

Two clients remain necessary because Cloudflare configures one token endpoint
authentication method per client. The server can protect a secret, while the
extension must use `none` with S256 PKCE.

Authoritative references:

- [Create a Cloudflare OAuth client](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)
- [Cloudflare OAuth/OIDC endpoints](https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/)
- [Cloudflare OIDC discovery document](https://dash.cloudflare.com/.well-known/openid-configuration)
- [Cloudflare authorization and revocation UX](https://developers.cloudflare.com/fundamentals/oauth/authorizing-an-application/)

## 2. Client definitions

| Client | Grant and response | Token authentication | PKCE | Registered scope ceiling |
| --- | --- | --- | --- | --- |
| Confidential server | `authorization_code`, `refresh_token`, `code` | `client_secret_post` | S256 | `user-details.read d1.write workers-kv-storage.write vectorize.write workers-scripts.write workers-r2.write`; `offline_access` is protocol-managed by the grant configuration |
| Chrome identity | `authorization_code`, `code` | `none` | S256 required | `user-details.read` |

Control-plane sign-in requests only `user-details.read`, creates a short-lived
Later Gator session, and retains no Cloudflare token. Installer authorization
later requests `user-details.read` plus the exact resource subset. Durable
refresh remains a Phase 4 acceptance item and must not be assumed from the
current Authorization Code-only private-client configuration.

## 3. Installer scope matrix

The exact public scope IDs were confirmed against Cloudflare's authenticated,
read-only [`GET /client/v4/oauth/scopes`](https://developers.cloudflare.com/api/resources/iam/subresources/oauth_scopes/methods/list/)
catalog on 2026-08-20. Display names are informative; code and client
registration use the IDs.

| Scope ID | Cloudflare display name | Why Later Gator needs it | When requested |
| --- | --- | --- | --- |
| `user-details.read` | User Details Read | Read only the stable current-user ID so the grant can be bound to the signed-in owner; discard email, name, memberships, and the token | Control-plane sign-in and every installer authorization |
| `offline_access` | OIDC protocol scope | Receive renewable installer authorization for resumable jobs and owner-approved managed updates | Every installer authorization |
| `d1.write` | D1 Write | Create the personal D1 database, initialize its schema, apply migrations, and perform explicit uninstall cleanup | Initial install |
| `workers-kv-storage.write` | Workers KV Storage Write | Create the mandatory private OAuth namespace and, in KV thumbnail mode, the thumbnail namespace | Initial install in every storage mode |
| `vectorize.write` | Vectorize Write | Create and inspect the personal Vectorize index | Initial install |
| `workers-scripts.write` | Workers Scripts Write | Upload versions/assets, attach bindings, create secrets, configure Queue consumers, enable `workers.dev`, deploy updates, and perform explicit uninstall cleanup | Initial install and managed updates |
| `workers-r2.write` | Workers R2 Storage Write | Create/delete the private thumbnail bucket and bind it to the personal runtime | Initial R2 choice or later explicit KV-to-R2 authorization |

Cloudflare currently accepts `Workers Scripts Write` as an authorization for
Queue creation as well as Worker deployment, so `queues.write` is not in the
minimum scope set. If disposable-account acceptance contradicts that API
contract, the client ceiling may add `queues.write`, but it must not be added
speculatively.

The control plane does not request `ai.write`, `browser-rendering.write`, or
`images.write`. It declares Workers AI, Browser Rendering, and Images bindings
inside the Worker upload; it does not call those product APIs on the owner's
behalf. The Worker upload API documents `Workers Scripts Write` for that
operation.

The live scope catalog was checked again on 2026-08-21 and contains no
`account.read` scope. `account-settings.read` is a different, broader permission
and is not a substitute. The disposable-account acceptance must establish how
the authorized account ID is returned or resolved under the selected product
scopes before any personal resource is created.

Operation references:

- [Create D1 database — D1 Write](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/)
- [Create KV namespace — Workers KV Storage Write](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/methods/create/)
- [Create R2 bucket — Workers R2 Storage Write](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/)
- [Create Vectorize index — Vectorize Write](https://developers.cloudflare.com/api/resources/vectorize/subresources/indexes/methods/create/)
- [Create Queue — Queues Write or Workers Scripts Write](https://developers.cloudflare.com/api/resources/queues/methods/create/)
- [Upload Worker module — Workers Scripts Write](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)
- [Add Worker secret — Workers Scripts Write](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/update/)
- [Enable Worker subdomain — Workers Scripts Write](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/create/)

### Storage-specific authorization

| Owner choice | Requested installer scopes |
| --- | --- |
| KV thumbnails | Base installer scopes without `workers-r2.write` |
| R2 thumbnails | Base installer scopes plus `workers-r2.write` |
| Thumbnails disabled | Base installer scopes without `workers-r2.write`; KV remains required for the runtime's private OAuth namespace |
| Later KV-to-R2 migration | New consent request adds `workers-r2.write`; the runtime copies bytes through its own KV and R2 bindings, so the control plane never receives thumbnail bytes |

The installer must store the actually granted scope and account set and reject a
job step whose required scope is absent. Scope names are configuration, never a
substitute for validating each Cloudflare API response.

## 4. Redirect URI inventory

Cloudflare requires registered redirect URLs. No wildcard callback is used.

### Confidential server client

| Environment | Redirect URI | Post-logout redirect URI |
| --- | --- | --- |
| Connected private test account | `https://later-gator-control-plane-dev.vishvak-v.workers.dev/auth/cloudflare/callback` | `https://later-gator-control-plane-dev.vishvak-v.workers.dev/` |
| Public production | `https://latergator.app/auth/cloudflare/callback` | `https://latergator.app/` |

The same client later also registers the installer callbacks:

| Environment | Redirect URI | Post-logout redirect URI |
| --- | --- | --- |
| Connected private test account | `https://later-gator-control-plane-dev.vishvak-v.workers.dev/install/cloudflare/callback` | `https://later-gator-control-plane-dev.vishvak-v.workers.dev/` |
| Public production | `https://latergator.app/install/cloudflare/callback` | `https://latergator.app/` |

### Chrome identity client

The extension uses
`chrome.identity.getRedirectURL("cloudflare")`, yielding the exact form:

```text
https://<CHROME_EXTENSION_ID>.chromiumapp.org/cloudflare
```

The development and store build must use the same extension ID. The final URI
cannot be registered until an unpublished Chrome Web Store draft supplies the
extension public key/ID and that public key is pinned in the development
manifest. This is an external `P7.2` gate, not a reason to use a wildcard or a
localhost redirect.

Chrome's official reference confirms that `getRedirectURL()` produces
`https://<app-id>.chromiumapp.org/*` callbacks for `launchWebAuthFlow`:
[Chrome Identity API](https://developer.chrome.com/docs/extensions/reference/api/identity).

## 5. Visibility and rollout gates

- Both clients start private. Private clients can be authorized only by
  members of the client owner's Cloudflare account, which is sufficient for the
  connected test account.
- Public visibility requires client URL domain verification.
- Cloudflare documents public promotion as permanent; do not promote during
  development.
- The confidential control-plane client may register both private-test and
  production HTTPS callbacks before promotion.
- The Chrome client stays blocked on its exact extension ID; never place a
  client secret in the extension.

## 6. Acceptance still required

Documentation establishes the supported design, but it does not prove every
product combination in the connected account. Before provisioning is accepted:

1. add `user-details.read` to the private confidential client and complete one
   login while proving no Cloudflare token or profile data is retained;
2. enable and verify refresh support before Phase 4 managed-update acceptance;
3. verify that consent returns only selected accounts and requested scopes;
4. provision disposable KV resources with the base scope set;
5. verify Queue creation under `workers-scripts.write` without `queues.write`;
6. repeat R2 consent only after the account has R2 enabled; and
7. revoke each authorization and prove Later Gator stops using it.
