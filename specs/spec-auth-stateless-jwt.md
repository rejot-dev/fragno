# Auth Stateless JWT Strategy — Spec

## 0. Open Questions

None.

## 1. Overview

This document specifies a **fully stateless JWT authentication strategy** for `@fragno-dev/auth`
built on top of the auth-boundary refactor described in
[`spec-auth-principal-refactor.md`](./spec-auth-principal-refactor.md).

The goal is to let authenticated requests be authorized from a signed JWT credential rather than a
server-managed `session` row. In the stateless strategy, the `session` table is no longer part of
request authentication, sign-in, sign-up, sign-out, organization context selection, or OAuth
callback issuance.

This spec intentionally keeps the rest of the auth fragment database-backed where it already must
be: users, OAuth accounts/states, organizations, memberships, invitations, and user role/banned
state still live in the database. What becomes stateless is the **credential** used to authenticate
a request.

## 2. Dependency on the Refactor Spec

This spec assumes the contracts from:

- [`spec-auth-principal-refactor.md`](./spec-auth-principal-refactor.md)

In particular, it depends on:

- `authentication.strategy`
- strategy-neutral `AuthPrincipal`
- centralized request credential resolution
- centralized credential issuance / clearing
- `authToken` request vocabulary
- `auth.token` response vocabulary
- actor/principal-based service signatures

This spec must not be implemented directly against the current session-coupled code without first
landing the refactor seam.

## 3. References

- Refactor spec: `specs/spec-auth-principal-refactor.md`
- Auth fragment entry: `packages/auth/src/index.ts`
- Current session schema: `packages/auth/src/schema.ts`
- Current session routes/services: `packages/auth/src/session/session.ts`
- Current user mutation routes/services: `packages/auth/src/user/user-actions.ts`
- Current OAuth routes/services: `packages/auth/src/oauth/routes.ts`,
  `packages/auth/src/oauth/oauth-services.ts`
- Current organization routes/services: `packages/auth/src/organization/routes.ts`,
  `packages/auth/src/organization/organization-services.ts`,
  `packages/auth/src/organization/member-services.ts`,
  `packages/auth/src/organization/invitation-services.ts`,
  `packages/auth/src/organization/active-organization.ts`
- Current auth hooks/types: `packages/auth/src/hooks.ts`
- Current cookie helper: `packages/auth/src/utils/cookie.ts`
- Fragno client customization docs:
  `apps/docs/content/docs/fragno/for-users/client-customization.mdx`

## 4. Terminology

- **JWT strategy**: the stateless auth strategy where the client credential is a signed JWT.
- **Session strategy**: the first-class database-backed auth strategy that continues to use the
  `session` table.
- **Auth token**: the serialized credential presented via `Authorization: Bearer ...`, cookie, or
  explicit `authToken` input.
- **Token claims**: the signed fields embedded in the JWT payload.
- **Token version**: the per-user integer used to invalidate all previously issued JWTs.
- **Credential id**: the JWT `jti`, exposed through normalized auth APIs and hooks.

## 5. Goals / Non-goals

### 5.1 Goals

1. Add `authentication.strategy = "stateless-jwt"` to `@fragno-dev/auth`.
2. Ensure no authenticated request path depends on the `session` table when the stateless strategy
   is active.
3. Represent the current active organization as a JWT claim so organization context remains
   per-credential rather than globally stored on the user.
4. Support both cookie transport and `Authorization: Bearer` transport with the same JWT.
5. Preserve the shared route/auth contract from the refactor spec so session and JWT remain
   first-class strategies behind one public shape.
6. Introduce global JWT invalidation through a user-scoped version field so password changes, bans,
   and explicit sign-out can invalidate previously issued tokens.
7. Keep OAuth linking and callback flows working under the new strategy.

### 5.2 Non-goals

- Per-token revocation lists or deny-lists.
- Server-stored refresh token tables.
- A JWKS/JWK rotation control plane in the first implementation.
- Eliminating all database reads during authenticated requests.
- Removing the session strategy in the same change.
- Preserving old `sessionId`-named request/response fields for backward compatibility.

## 6. Public Config Surface

The `authentication` config added by the refactor spec expands to support the stateless JWT mode.

```ts
export interface AuthConfig<TRole extends string = DefaultOrganizationRole> {
  authentication?: {
    strategy?: "session" | "stateless-jwt";
    jwt?: {
      issuer: string;
      audience: string;
      secret: string;
      expiresInSeconds?: number; // default: 30 days
      acceptBearer?: boolean; // default: true
      issueCookie?: boolean; // default: true
    };
  };
  cookieOptions?: CookieOptions;
  hooks?: AuthHooks;
  beforeCreateUser?: BeforeCreateUserHook;
  organizations?: OrganizationConfig<TRole> | false;
  emailAndPassword?: {
    enabled?: boolean;
  };
  oauth?: AuthOAuthConfig;
}
```

Rules:

- `authentication.strategy = "stateless-jwt"` requires `authentication.jwt`.
- `expiresInSeconds` defaults to `30 * 24 * 60 * 60` to preserve current session duration unless the
  user configures otherwise.
- `issueCookie = true` means the same JWT is written into the auth cookie using existing
  `cookieOptions`.
- `acceptBearer = true` means the request resolver accepts `Authorization: Bearer <jwt>`.
- Cookie transport and bearer transport are not separate credential types; they are transport modes
  for the same JWT.

## 7. Token Format

### 7.1 Claims

The stateless strategy uses a signed JWT with the following payload shape:

```ts
export interface AuthJwtClaims {
  iss: string;
  aud: string;
  sub: string; // user id
  exp: number;
  iat: number;
  jti: string;

  typ: "fragno-auth";
  email: string;
  role: Role;
  ver: number; // user.authVersion
  aorg: string | null; // active organization id
}
```

Rules:

- `sub` is always the external user id.
- `jti` is the credential id surfaced through `AuthPrincipal.auth.credentialId`.
- `ver` is the user’s current auth version at issuance time.
- `aorg` stores the active organization id for this credential only.
- `email` and `role` are included for observability and compatibility with the normalized auth
  model, but request resolution must still load the current user row and not blindly trust stale
  role/email claims.

### 7.2 Algorithm and library

The initial implementation uses a vetted JWT library such as `jose`; do not implement JWT signing or
verification manually.

Initial algorithm scope is intentionally narrow:

- symmetric signing with a shared secret (`HS256`)

The strategy interface introduced by the refactor may later expand to other algorithms, but this
spec does not require that.

## 8. Principal Resolution

### 8.1 Request extraction

When `authentication.strategy = "stateless-jwt"`, request auth resolution follows the same input
precedence defined in the refactor spec:

1. `Authorization: Bearer <token>` if enabled
2. cookie value if present
3. query `authToken`
4. body `authToken`

### 8.2 Validation steps

The JWT resolver must:

1. parse the serialized token
2. verify signature
3. verify `iss`
4. verify `aud`
5. verify `exp`
6. verify `typ === "fragno-auth"`
7. load the current user row by `sub`
8. reject if the user does not exist
9. reject if `user.bannedAt` is set
10. reject if `user.authVersion !== claims.ver`
11. construct `AuthPrincipal` using current user data plus JWT auth metadata

Important: request validation may read the `user` table, but it must not query the `session` table.

### 8.3 Current user source of truth

After token verification:

- `AuthPrincipal.user.id` comes from the current DB row / `sub`
- `AuthPrincipal.user.email` comes from the current DB row
- `AuthPrincipal.user.role` comes from the current DB row
- `AuthPrincipal.auth.activeOrganizationId` comes from `claims.aorg`
- `AuthPrincipal.auth.expiresAt` comes from `claims.exp`
- `AuthPrincipal.auth.credentialId` comes from `claims.jti`

This ensures user role changes or email changes are reflected immediately once the token version
check passes.

## 9. Data Model / Schema Changes

### 9.1 User table additions

The `user` table gains a version field used for stateless invalidation:

```ts
user.authVersion: integer, default 1
```

Rules:

- `authVersion` increments whenever all currently issued stateless JWT credentials for a user must
  stop working.
- At minimum it must increment on:
  - password change
  - user role change
  - user ban
  - explicit sign-out route
- It may also increment on other future auth-sensitive mutations.

### 9.2 Session table status

The existing `session` table remains in the schema because it is still the implementation of the
first-class session strategy, even though the stateless JWT strategy does not use it.

Rules:

- when the JWT strategy is active, the fragment must not create new `session` rows
- when the JWT strategy is active, the fragment must not validate requests through `session` rows
- sign-out in JWT mode must not delete `session` rows because none are created in this strategy
- tests must assert that stateless flows do not hit session-backed code paths

### 9.3 OAuth tables

The existing `oauthAccount` and `oauthState` tables remain in use.

- `oauthState.linkUserId` continues to support provider linking.
- OAuth callback issues a JWT instead of creating a `session` row.

## 10. Credential Issuance

### 10.1 Issuing routes

Under the stateless strategy, these routes issue a JWT through the shared issuance helper:

- `POST /sign-up`
- `POST /sign-in`
- `GET /oauth/:provider/callback`
- `POST /organizations/active` when the active org changes
- `POST /change-password` if the route continues to return an updated auth credential

### 10.2 Issuance inputs

The issuing helper needs:

- current user id
- current user email
- current user role
- current `authVersion`
- chosen `activeOrganizationId`
- configured issuer/audience/ttl

### 10.3 Issuance outputs

Routes must return the normalized envelope from the refactor spec:

```ts
{
  auth: {
    token: string;
    kind: "jwt";
    expiresAt: string;
    activeOrganizationId: string | null;
  }
  userId: string;
  email: string;
  role: "user" | "admin";
}
```

Rules:

- if `issueCookie = true`, the route also sets the auth cookie using the same JWT string
- `onSessionCreated` continues to fire for compatibility with the fragment lifecycle model, with
  `session.id = jti`
- the JWT strategy uses the same `auth.token` response contract as the session strategy

## 11. Sign-up and Sign-in Semantics

### 11.1 Sign-up

Email/password sign-up changes from “create user + create session row” to:

1. create user
2. determine initial active organization id using the existing session-seed logic semantics
3. issue JWT
4. optionally set cookie
5. trigger hooks

### 11.2 Sign-in

Email/password sign-in changes from “validate password + create session row” to:

1. validate password
2. load memberships needed to resolve initial active organization id
3. issue JWT
4. optionally set cookie
5. trigger hooks

The current `session` seed concept survives, but it becomes **credential seed** behavior rather than
session-row behavior.

## 12. Sign-out and Invalidation Semantics

Stateless auth cannot revoke a single already-issued JWT without server-side token storage. This
spec chooses a secure, explicit model:

### 12.1 `POST /sign-out`

When the stateless strategy is active, `POST /sign-out` means:

1. resolve current principal
2. increment `user.authVersion`
3. clear cookie if cookie transport is enabled
4. return `{ success: true }`
5. trigger `onSessionInvalidated`

Effect:

- all currently issued stateless JWT credentials for that user become invalid, not just the current
  browser tab or device
- this is the server-enforced replacement for per-session invalidation in JWT mode

### 12.2 Local-only sign-out

If an app wants local-device-only logout without global invalidation, it may clear its stored token
or cookie without calling the server route. That behavior is outside the fragment contract.

## 13. Password Change, Role Change, and Ban Semantics

### 13.1 Password change

`POST /change-password` must:

1. resolve current principal
2. update password hash
3. increment `authVersion`
4. issue a replacement JWT for the current user if the route remains logged-in-after-change
5. fire hooks

The route must not create a `session` row.

### 13.2 Role changes

When an admin changes a user’s role:

1. update the target user role
2. increment the target user’s `authVersion`
3. fire hooks

This ensures previously issued tokens with stale role claims stop working.

### 13.3 User bans

Banning a user must increment `authVersion` in addition to setting `bannedAt`, so outstanding tokens
are rejected even before route-specific logic runs.

## 14. Organization Semantics Under JWT

### 14.1 Active organization lives in the token

The active organization becomes a credential-scoped claim (`aorg`), not a persisted session row
field.

This preserves an important existing property:

- different browser tabs / devices / clients may carry different active organization selections

### 14.2 `POST /organizations/active`

Under the stateless strategy, setting the active organization means:

1. resolve current principal
2. validate membership for the requested organization
3. issue a replacement JWT with `aorg = organizationId`
4. optionally set cookie
5. return the replacement credential through the normalized auth envelope

No session row is updated.

### 14.3 `/me`

`GET /me` continues to compute organizations from current DB memberships. It determines
`activeOrganization` by matching the principal’s `activeOrganizationId` claim against the fetched
organization list.

Rules:

- if the claim refers to an organization the user no longer belongs to, `/me` returns
  `activeOrganization: null`
- route and service logic may repair the value on next issuance, but request validation does not
  need to pre-validate `aorg` against memberships on every request

## 15. OAuth Flows Under JWT

### 15.1 Authorize / link flow

`GET /oauth/:provider/authorize` with `link=true` uses the resolved principal from the auth
boundary.

- no session-row lookup is allowed
- `oauthState.linkUserId` stores the authenticated user id directly

### 15.2 Callback flow

`GET /oauth/:provider/callback` changes from “create session row + set cookie” to:

1. validate OAuth state
2. resolve or create user
3. update/create `oauthAccount`
4. determine active organization id
5. issue JWT
6. optionally set cookie
7. return or redirect as today

The callback continues to support `returnTo` redirects. If a redirect is returned, the response must
still carry the cookie when `issueCookie = true`.

## 16. Client and DX Changes

### 16.1 Client defaults

`createAuthFragmentClients()` keeps `credentials: "include"` as the default because the JWT strategy
may still use cookie transport.

### 16.2 Bearer-token consumers

Bearer-token consumers continue to use Fragno’s existing client customization support by injecting
an `Authorization` header via `fetcherConfig`.

### 16.3 Client helper cleanup

The auth client APIs move to the strategy-neutral parameter names introduced in the refactor spec.

Examples:

- `me({ authToken })`
- `signOut({ authToken })`
- `oauth.getAuthorizationUrl({ authToken, link: true })`

The shared public contract does not preserve `sessionId`-named request parameters.

## 17. Strategy Coexistence and Shared Surface

### 17.1 Strategy coexistence

The session and stateless-JWT strategies may coexist behind `authentication.strategy` during
rollout.

This spec does not require removing the session strategy in the same release.

### 17.2 Shared public auth contract

Both strategies use the same shared contract from the refactor spec:

- `authToken` for explicit request transport
- `auth.token` for issued credentials
- `getAuthPrincipal()` as the shared server-side auth entry point

### 17.3 Strategy-specific internals

Strategy-specific helpers such as session-row creation or session-row validation may continue to
exist inside the session strategy implementation, but they are not part of the shared auth surface
used by routes and cross-strategy services.

## 18. Testing Requirements

Required coverage for the stateless strategy:

1. sign-up issues JWT and does not create a session row
2. sign-in issues JWT and does not create a session row
3. OAuth callback issues JWT and does not create a session row
4. authenticated route resolution works from bearer token
5. authenticated route resolution works from cookie token
6. invalid issuer/audience/signature/expiry are rejected
7. banned user is rejected after token verification
8. stale `authVersion` token is rejected
9. sign-out increments `authVersion`, clears cookie, and invalidates prior tokens
10. active-org change reissues token with a new `aorg` claim
11. `/me` derives active organization from the token claim
12. organization routes work without session-table access
13. session strategy and JWT strategy share the same `auth.token` / `authToken` public contract

## 19. Locked Decisions

1. The stateless strategy authenticates requests from a signed JWT, not a session row.
2. The existing `session` table remains the implementation of the first-class session strategy and
   is not used by the stateless JWT strategy.
3. Token invalidation is user-version based (`user.authVersion`), not per-token deny-list based.
4. `POST /sign-out` in stateless mode performs global user-token invalidation by incrementing
   `authVersion`.
5. Active organization is stored in the JWT claim set and updated by token reissuance.
6. The same JWT may be transported via cookie or bearer header.
7. Request validation still loads the current user row so role, email, ban state, and auth version
   stay authoritative.
8. OAuth linking and callback flows must work without any session-table dependency.
9. The public auth contract is unified around `authToken` and `auth.token`; it does not preserve the
   old `sessionId` transport naming.

## 20. Documentation Updates

Update the following when the stateless strategy ships:

- `packages/auth/README.md`
  - add stateless JWT configuration
  - explain cookie vs bearer transport
  - document `auth.token` / `authToken`
  - describe session and JWT as first-class strategies
- `apps/docs/content/docs/auth/index.mdx`
  - mention selectable auth strategies
- `apps/docs/content/docs/auth/oauth.mdx`
  - explain callback JWT issuance and linking without session rows
- `apps/docs/content/docs/auth/organizations.mdx`
  - explain active organization as token-scoped context
- `apps/docs/content/docs/fragno/for-users/client-customization.mdx`
  - show bearer token usage with the auth client
- any examples or backoffice code that currently assumes `sessionId` is a DB session row
