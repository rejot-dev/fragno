# Backoffice execution credentials

OAuth authenticates a user and client. Backoffice separately resolves the authority that may execute
operations in a System, organization, project, or user scope. Codemode consumes this execution flow;
it does not own token verification or scope-token issuance.

## OAuth execution token exchange

```text
OAuth access token
  → verify issuer, signature, audience, expiry, and backoffice scope
  → resolve the verified client ID's server-controlled execution policy
  → require the user's current OAuth consent for that client and token scopes
  → resolve current user authority for the requested scope
  → issue a short-lived, scope-restricted Backoffice JWT
  → authorize operations through the existing kernel
```

`POST /api/backoffice/execution-token` accepts an OAuth bearer token and a strict JSON body:

```json
{ "scope": { "kind": "org", "orgId": "organization-id" } }
```

It returns `{ accessToken, expiresAt, scope }`. The credential lifetime remains 15 minutes. A
`scope: null` request selects the user's preferred available organization; explicit scopes must be
available to that user. An unavailable organization does not silently fall back to a personal scope.
Responses use `cache-control: no-store`.

- Malformed request bodies return `400` with `invalid_request`.
- Invalid OAuth credentials, ineligible clients, or revoked consent return `401` with
  `authentication_failed`. The message identifies the failed boundary instead of assuming expiry.
- Unavailable user authority, scopes, app installations, or approved resources return `403` with
  `scope_unavailable`.

Callers cannot supply a user ID, client ID, or execution policy. Auth validates its internal RPC
input as well as the route validating the HTTP body.

The canonical Auth command is `exchangeBackofficeExecutionToken`. The old CLI-specific route and
command have been removed, and `@rejot-dev/backoffice-local` uses the shared route.

## Execution policies

Auth selects the policy from the verified OAuth client ID. Callers never choose it.

| Client                                      | Policy             | Credential                                    |
| ------------------------------------------- | ------------------ | --------------------------------------------- |
| The deployment's Codemode client            | `first-party-user` | User JWT with a scope ceiling                 |
| An enabled client registered as an app      | `installed-app`    | App-bound JWT for one organization or project |
| Any other, disabled, or unregistered client | none               | `401 authentication_failed`                   |

User tokens require current OAuth consent for the client and token scopes; revoking consent prevents
further issuance, even with an unexpired OAuth JWT. Client-credentials tokens (whose subject is the
client itself) carry no user and no consent, and are accepted only for installed apps.

### First-party user

Auth assigns `first-party-user` only to the active deployment Codemode client, and only for user
tokens. Its bootstrap reference owner distinguishes it from managed clients that copy its name or
software metadata. Disabled clients are ineligible.

Authority comes from the authenticated user's current role, banned status, and organization
membership. Already-issued execution JWTs remain user authority snapshots with the existing scope
ceiling and maximum 15-minute lifetime.

### Installed apps

Registering an app never confers first-party policy. A registered app's client receives an app-bound
credential only when the request names an explicit organization or project scope, the organization
has the app actively installed, and the scope is inside the installation's approved resources (the
whole organization, or selected projects). The app then acts as one of:

| Token                                     | Acts as          | Kernel requires                                    |
| ----------------------------------------- | ---------------- | -------------------------------------------------- |
| User token (authorization code)           | the user         | user's current permissions ∩ installation's grants |
| Client-credentials token (`sub` = client) | the installation | installation's grants                              |

For a user token, the user must currently be an active member of that organization; the installing
administrator's authority is irrelevant.

The credential has its own JWT audience, so every user-credential verifier rejects it. It names the
actor, app, scope, installation activation, and any linked external account, but carries no role or
grant snapshot. Each protected operation resolves the installation live: the grants, the approved
resources, and the activation must all still hold. Narrowing grants or resources, removing the
member, banning the user, or uninstalling therefore affects already-issued credentials immediately.
Each reinstallation increments the activation, so credentials and deferred work from an earlier
activation stay invalid. Installation management (`apps.*`) is never available to an app.

Installed-app credentials are accepted only by:

```http
POST /api/backoffice/scopes/:scopeSegment/events
Authorization: Bearer <installed-app credential>
Content-Type: application/json

{ "eventType": "bookkeeping.connection.tested", "payload": { "message": "Hello" } }
```

`:scopeSegment` is `org:<orgId>` or `project:<orgId>:<projectId>` and must equal the credential's
scope; archived projects return `404`. The body may contain only `eventType` and a `payload` object;
source, actors, and scope come from the credential. Events use source `app:<appId>`. Acting for a
user, the actors are the app (initiator), the user (principal), and the installation activation
(restricting delegate). Acting as the installation, the linked external account (or the app) is the
initiator and the installation activation is the principal. Automation started from these events
keeps the same restrictions. The response is `202` with
`{ accepted, eventId, scope, source, eventType }` once the event is durably stored and queued; it
does not mean downstream automation has completed. Failures return `401 authentication_failed`,
`403 forbidden`, `400 invalid_request`, `404 not_found`, or `422 invalid_payload` for a registered
event definition's payload schema.

### App-initiated installation

An app links its own tenant (for example, a Bookkeeping organization) to a Backoffice organization:

```text
app server ──redirect──► /backoffice/apps/install?client_id&redirect_uri&state
  owner/admin picks organization, permissions, and resources; kernel checks live apps.manage
◄──redirect── redirect_uri?code&state          (or ?error=access_denied&state)
app server ──POST /api/backoffice/app-installations/claim──►
  Authorization: Bearer <client-credentials token>
  { "code": "…", "externalAccount": { "id": "…", "label": "…" } }
◄── { id, appId, organizationId, grantedPermissions, resourceScope, externalAccount, activation }
```

- `redirect_uri` must share an origin with one of the client's registered OAuth redirect URIs.
- The code is a 5-minute signed proof of one activation's approval, not a credential. Only the app
  whose client-credentials token matches can redeem it.
- An installation links at most one external account. Re-claiming the same account refreshes its
  label; a different account returns `409 app_installation_already_claimed` until the app is
  uninstalled, which clears the link. A stale activation returns
  `409 app_installation_activation_stale`; an uninstalled one `409 app_installation_inactive`.
- The app must verify its own `state` before claiming, so a code cannot be injected into another
  user's flow.

### OAuth resource

Each served origin is registered as an OAuth resource when its OAuth or device endpoints are first
used, independently of Codemode. Request `resource=<Backoffice origin>` at authorization and token
time to receive a JWT access token that the exchange accepts. The resource allows every Backoffice
scope; Better Auth intersects requested scopes with it, so a narrower resource would silently strip
`profile` and `email` from apps that also request `backoffice`.

## Codemode and browser entry points

The CLI still discovers its device-flow configuration through `/api/backoffice/cli-config`, obtains
OAuth access/refresh tokens through the internal Codemode client, and exchanges an access token at
the shared execution-token route. Device approval now records a user consent in Better Auth's
`oauthConsent` model, so it can be reviewed and revoked alongside authorization-code grants.

The selected origin is preserved through configuration, browser approval links, OAuth issuance,
refresh, and execution-token exchange. `localhost` and `127.0.0.1` are distinct issuer and browser
session origins; neither is rewritten to the other. Sign in using the same hostname as the CLI.

Codemode HTTP entry points keep their `@rejot.dev` account restriction. That product restriction is
not part of OAuth verification or generic execution-token issuance. System scope still requires a
global administrator, and scoped runtime tools remain kernel-authorized.

The browser `/api/auth/backoffice-token` session exchange reuses the same user-grant resolver and
JWT issuer. Its cookie transport, organization selection/provisioning response, and unrestricted
credential-scope behavior are unchanged.

## Browser consent and revocation

`/backoffice/device` handles first-party device approval; `/backoffice/oauth/consent` handles
provider-signed authorization-code consent. Both require a live Better Auth browser session and
explicit same-origin approval/denial. The OAuth login page preserves the signed query through
password login rather than substituting a Backoffice JWT for the browser session.

Users manage their own authorizations at `/backoffice/settings/authorized-applications`, accessible
from the account menu and Settings. Listing is credential-free and cursor-bound to the session user.
Revocation derives the user ID from that session and transactionally removes that client's consents,
stored access tokens, refresh tokens, and pending/approved device codes for that user. Other users,
browser sessions, and organization installations are unaffected.

Provider claim issuance and userinfo also require current consent. Self-contained JWTs accepted by
external verifiers remain subject to their expiry; the UI does not promise global immediate token
revocation. Device approvals made before tracking must be repeated explicitly, not inferred from old
tokens.

## Implementation ownership

- `execution-token.ts`: HTTP/RPC schemas, result, and execution-token errors.
- `workers/auth/backoffice-execution-token.ts`: OAuth proof verification, policy dispatch, and
  scoped credential issuance.
- `workers/auth/better-auth-oauth.ts`: provider/bootstrap setup, OAuth resource setup, client
  management, and client-policy resolution.
- `app/fragno/app-installations/authority.ts`: installed-app execution and live installation grant
  and resource resolution.
- `app/routes/api/backoffice-scoped-events.ts`: the installed-app event endpoint.
- `app/routes/backoffice/app-install.tsx` and `app-install.server.ts`: the app-initiated install
  page.
- `app/routes/api/backoffice-app-installation-claim.ts`: installation claims by the app's server.
- `workers/auth/better-auth-oauth-consent.ts`: provider-owned consent review, listing, device
  tracking, revocation, same-origin decisions, and live consent enforcement.
- `oauth-consent.ts`: credential-free review/list contracts and revocation inputs.
- `workers/auth/backoffice-user-token-grant.ts`: the shared browser/first-party user-grant contract;
  `workers/auth.do.ts` supplies the live Auth-backed resolver.
- `token-lifecycle.ts`: user and installed-app JWT signers, verifiers, and cookie primitives.

`app/routes/api/backoffice-execution-token.scenario.test.ts` exercises real SQLite-backed OAuth,
Auth, route, and kernel boundaries, including scope restrictions, forged input, audience/signature
validation, live authority removal, and app-bound credentials for external clients.
`app/routes/api/backoffice-scoped-events.scenario.test.ts` drives an external confidential client
through authorization code, exchange, and event delivery, including revocation and reinstallation,
and through the install page, claim, and client-credentials delivery limited to approved projects.
