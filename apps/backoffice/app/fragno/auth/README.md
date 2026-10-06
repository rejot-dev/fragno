# Backoffice execution credentials

OAuth authenticates a user and client. Backoffice separately resolves the authority that may execute
operations in a System, organization, project, or user scope. Codemode consumes this execution flow;
it does not own token verification or scope-token issuance.

## OAuth execution token exchange

```text
OAuth access token
  → verify issuer, signature, audience, expiry, and backoffice scope
  → resolve the verified client ID's server-controlled execution policy
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
- Invalid OAuth credentials or ineligible clients return `401` with `authentication_failed`.
- Unavailable user authority or scopes return `403` with `scope_unavailable`.

Callers cannot supply a user ID, client ID, or execution policy. Auth validates its internal RPC
input as well as the route validating the HTTP body.

The canonical Auth command is `exchangeBackofficeExecutionToken`. The old CLI-specific route and
command have been removed, and `@rejot-dev/backoffice-local` uses the shared route.

## Explicit first-party policy

The only implemented OAuth execution policy is `first-party-user`. Auth currently assigns it only to
the active deployment Codemode client. Its bootstrap reference owner distinguishes it from managed
clients that copy its name or software metadata. Disabled clients are ineligible.

This policy resolves authority from the authenticated user's current role, banned status, and
organization membership. JWT claims remain user authority snapshots, with the existing scope ceiling
and verification/kernel behavior; the refactor does not change the revocation semantics of already
issued JWTs.

App registration and even an active organization installation do **not** confer first-party policy.
Installed-app delegation is not implemented yet. It must preserve app and installation identity and
constrain user authority by current organization-approved grants; it cannot reuse unrestricted user
JWTs as app credentials. App-only background execution remains a separate, unimplemented authority
model.

## Codemode and browser entry points

The CLI still discovers its device-flow configuration through `/api/backoffice/cli-config`, obtains
OAuth access/refresh tokens through the internal Codemode client, and exchanges an access token at
the shared execution-token route. Device approval and refresh behavior are unchanged.

Codemode HTTP entry points keep their `@rejot.dev` account restriction. That product restriction is
not part of OAuth verification or generic execution-token issuance. System scope still requires a
global administrator, and scoped runtime tools remain kernel-authorized.

The browser `/api/auth/backoffice-token` session exchange reuses the same user-grant resolver and
JWT issuer. Its cookie transport, organization selection/provisioning response, and unrestricted
credential-scope behavior are unchanged.

## Implementation ownership

- `execution-token.ts`: HTTP/RPC schemas, result, and execution-token errors.
- `workers/auth/backoffice-execution-token.ts`: OAuth proof verification, policy dispatch, and
  scoped credential issuance.
- `workers/auth/better-auth-oauth.ts`: provider/bootstrap setup, client management, and explicit
  Codemode client-policy resolution.
- `workers/auth/backoffice-user-token-grant.ts`: the shared browser/first-party user-grant contract;
  `workers/auth.do.ts` supplies the live Auth-backed resolver.
- `token-lifecycle.ts`: the existing JWT signer, verifier, and cookie primitives.

`app/routes/api/backoffice-execution-token.scenario.test.ts` exercises real SQLite-backed OAuth,
Auth, route, and kernel boundaries, including scope restrictions, forged input, audience/signature
validation, live authority removal, and denial of installed external clients.
