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
`scope: null` request selects the user's earliest organization, or the user's own scope when they
belong to none. Users create their organizations themselves; sign-up creates none. Explicit scopes
must be available to that user. An unavailable organization does not silently fall back to a
personal scope. Responses use `cache-control: no-store`.

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

| Client                                      | Policy             | Credential                                  |
| ------------------------------------------- | ------------------ | ------------------------------------------- |
| The deployment's Codemode client            | `first-party-user` | User JWT with a scope ceiling               |
| An enabled client registered as an app      | `installed-app`    | App-bound JWT for one scope under its owner |
| Any other, disabled, or unregistered client | none               | `401 authentication_failed`                 |

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
credential only when the request names an explicit scope other than System, the scope's root owner
(an organization or a user) has the app actively installed, and the scope is inside the
installation's approved resources (everything the owner has, or selected projects), or is the app's
own workspace there (`app:<owner>:<appId>`). The app then acts as one of:

| Token                                     | Acts as          | Kernel requires                                    |
| ----------------------------------------- | ---------------- | -------------------------------------------------- |
| User token (authorization code)           | the user         | user's current permissions ∩ installation's grants |
| Client-credentials token (`sub` = client) | the installation | installation's grants                              |

For a user token, the user must currently be an active member of that organization, or be the user
who owns the scope; the installing administrator's authority is irrelevant.

The credential has its own JWT audience, so every user-credential verifier rejects it. It names the
actor, app, scope, installation activation, and any linked external account, but carries no role or
grant snapshot. Each protected operation resolves the installation live: the grants, the approved
resources, and the activation must all still hold. Narrowing grants or resources, removing the
member, banning the user, or uninstalling therefore affects already-issued credentials immediately.
Each reinstallation increments the activation, so credentials and deferred work from an earlier
activation stay invalid. Installation management (`apps.*`) is never available to an app.

Installed-app credentials are accepted only by the [versioned HTTP API](#versioned-http-api), in
organization or project scopes inside the credential's scope:

```http
POST /api/v0/scopes/:scope/events.fire
Authorization: Bearer <installed-app credential>
Content-Type: application/json

{ "eventType": "bookkeeping.connection.tested", "payload": { "message": "Hello" } }
```

Actors come from the credential, and events always use source `app:<appId>`; a request naming
another source is `403 forbidden`. No other caller may name an `app:` source, so automations can
trust it; an automation started by an app's event still inherits that source when it names none.
Acting for a user, the actors are the app (initiator), the user (principal), and the installation
activation (restricting delegate). Acting as the installation, the linked external account (or the
app) is the initiator and the installation activation is the principal. Automation started from
these events keeps the same restrictions. The response is `200` with
`{ accepted, eventId, scope, source, eventType }` once the event is durably stored and queued; it
does not mean downstream automation has completed.

### App-initiated installation

An app links its own tenant (for example, a Bookkeeping organization) to a Backoffice organization,
or to a user who installs it for themselves:

```text
app server ──redirect──► /backoffice/apps/install?client_id&redirect_uri&state
  user picks an organization they own or administer, or themselves, then permissions and
  resources; kernel checks live apps.manage
◄──redirect── redirect_uri?code&state          (or ?error=access_denied&state)
app server ──POST /api/backoffice/app-installations/claim──►
  Authorization: Bearer <client-credentials token>
  { "code": "…", "externalAccount": { "id": "…", "label": "…" } }
◄── { id, appId, owner, grantedPermissions, resourceScope, externalAccount, activation }
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

Codemode HTTP entry points authorize like every other scoped entry point: system scope requires a
global administrator, and scoped runtime tools remain kernel-authorized.

The browser `/api/auth/backoffice-token` session exchange reuses the same user-grant resolver and
JWT issuer. It sets the credential as a cookie, selects an organization the same way, and does not
restrict the credential's scope. Protected pages call it on the server: without a valid access
token, or when the URL names another of the user's organizations, the page reopens itself with a new
one (`app/fragno/auth/browser-credential.server.ts`). The Better Auth session's
`activeOrganizationId` remembers the organization of the last token, so a replacement keeps it; a
`preferred` exchange uses it and a `required` exchange moves it.

## Versioned HTTP API

`/api/v0/…` (`app/backoffice-api/backoffice-api-router.ts`) serves the `@fragno-dev/backoffice-api`
contract. It accepts bearer credentials only, never the session cookie: user credentials act with
the user's live permissions in the requested scope, and installed-app credentials act through their
installation, inside the scope they were issued for. Both verify against the same JWKS in one pass,
distinguished by audience. Each operation runs the runtime tool of the same id, so the kernel
authorizes it exactly as it does in Bash and Codemode; installed apps can emit events only under
their own `app:<appId>` source. `admin` and `internal` tools are never exposed; `cloudflare` tools
wait for real Browser Run result schemas in their fragment. Byte-oriented operations exchange base64
through v0 adapters (`app/backoffice-api/v0-adapters.ts`) until dedicated file transfer APIs exist.

## Browser consent and revocation

`/backoffice/device` handles first-party device approval; `/backoffice/oauth/consent` handles
provider-signed authorization-code consent. Both require a live Better Auth browser session and
explicit same-origin approval/denial. The OAuth login page preserves the signed query through
password login rather than substituting a Backoffice JWT for the browser session.

A [first-party app](../apps/README.md#first-party-apps) is not reviewed: the consent page approves
its request through the same Better Auth consent endpoint as an approval, so the consent is recorded
and enforced like any other. Auth leaves its consents out of listings and refuses to revoke them.

### Signing in through a first-party app

People a first-party app sends here may not know Backoffice, so when `/backoffice/login` receives a
signed authorization request from a first-party app, it shows the app's sign-in instead
(`app/routes/backoffice/app-sign-in*`): the app's branding, an email field, then a 6-digit code.

- **Codes come from Better Auth's `emailOTP`** (`workers/auth/better-auth-app-sign-in.ts`), and
  Backoffice queues them through Resend in the app's name: its branding, and the configured sending
  address under the app's display name. On a loopback origin (development or preview), Auth prints
  each code first, since a local Backoffice rarely has Resend configured.
- **Only first-party apps' requests get codes.** A hook after the OAuth Provider, which verifies the
  request's signature, refuses code requests and sign-ins whose request names no first-party client,
  so codes are no way around invitation-only sign-up. The other `emailOTP` endpoints are disabled.
- **A correct code signs up a new address,** already verified, even where Backoffice's own sign-up
  needs an invitation. An existing unverified account is taken over by whoever proves the address,
  as Better Auth does.
- **The authorization continues at once.** The new session lets the OAuth Provider resume the app's
  request, and the consent page approves first-party apps, so people land back in the app.

Users manage their own authorizations at `/backoffice/settings/authorized-applications`, accessible
from the account menu and Settings. Listing is credential-free and cursor-bound to the session user.
Revocation derives the user ID from that session and transactionally removes that client's consents,
stored access tokens, refresh tokens, and pending/approved device codes for that user. Other users,
browser sessions, and app installations are unaffected.

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
- `app/backoffice-api/backoffice-api-router.ts`: the versioned HTTP API, the only endpoint that
  accepts installed-app credentials.
- `app/routes/backoffice/app-install.tsx` and `app-install.server.ts`: the app-initiated install
  page.
- `app/routes/api/backoffice-app-installation-claim.ts`: installation claims by the app's server.
- `app/backoffice-api/provisioning-router.ts`: the
  [provisioning API](../apps/README.md#provisioning-api) for first-party apps; Auth's side is
  `provisionAppOrganization`, `confirmAppOrganizationMember`, `findInvitation`, and
  `acceptAppInvitation` in `workers/auth.do.ts`.
- `workers/auth/better-auth-oauth-consent.ts`: provider-owned consent review, listing, device
  tracking, revocation, same-origin decisions, and live consent enforcement.
- `oauth-consent.ts`: credential-free review/list contracts and revocation inputs.
- `workers/auth/backoffice-user-token-grant.ts`: the shared browser/first-party user-grant contract;
  `workers/auth.do.ts` supplies the live Auth-backed resolver.
- `token-lifecycle.ts`: user and installed-app JWT signers, verifiers, and cookie primitives.

`app/routes/api/backoffice-execution-token.scenario.test.ts` exercises real SQLite-backed OAuth,
Auth, route, and kernel boundaries, including scope restrictions, forged input, audience/signature
validation, live authority removal, and app-bound credentials for external clients.
`app/backoffice-api/installed-app.scenario.test.ts` drives an external confidential client through
authorization code, exchange, and event delivery with the published API client, including revocation
and reinstallation, and through the install page, claim, and client-credentials delivery limited to
approved projects.
