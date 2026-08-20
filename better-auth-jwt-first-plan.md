# JWT-first Backoffice authentication plan

Status: complete — Phases 1 through 7 implemented

## Goal

Keep Better Auth sessions behind the authentication boundary and issue a short-lived JSON Web Token
(JWT) immediately after authentication. The JWT becomes the credential for Backoffice application
requests and carries the selected organization.

The Better Auth session remains the renewable identity root. It creates, refreshes, and revokes
JWTs, but it does not define the active organization for application authorization.

## Architectural decisions

The implementation will enforce these rules:

1. Better Auth session cookies authenticate only requests under `/api/auth`.
2. Backoffice application routes authorize a short-lived JWT, not a Better Auth session.
3. The JWT contains one selected organization rather than every organization membership.
4. Selecting another organization replaces the JWT.
5. The browser never stores the JWT in `localStorage` or `sessionStorage`.
6. Browser requests carry the JWT in an HttpOnly access-token cookie.
7. Non-browser clients carry the same JWT in `Authorization: Bearer <token>`.
8. The local default-organization value is an untrusted preference. The token issuer validates it
   against current membership before signing a JWT.

## Credential model

| Credential          | Transport                                       | Purpose                                                                                           | Lifetime                                   |
| ------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Better Auth session | HttpOnly cookie restricted to `/api/auth`       | Sign-in continuity, token issuance, token refresh, sign-out, and Better Auth management endpoints | Seven days with normal Better Auth renewal |
| Backoffice JWT      | HttpOnly cookie for browsers                    | Backoffice loaders, actions, fragment proxies, and API requests                                   | 15 minutes                                 |
| Backoffice JWT      | `Authorization: Bearer` for non-browser clients | External and service integration                                                                  | 15 minutes                                 |

Application authorization must ignore the Better Auth session cookie. Possessing a session permits a
caller to request a JWT, but it does not directly grant access to Backoffice application routes.

## JWT claims

Replace the current all-memberships payload with a singular organization context:

```ts
type BackofficeJwtPayload = {
  sub: string;
  email: string;
  globalRole: "user" | "admin";
  organization: {
    id: string;
    roles: string[];
  } | null;
  iss: typeof ACCESS_TOKEN_ISSUER;
  aud: typeof ACCESS_TOKEN_AUDIENCE;
  iat: number;
  exp: number;
  jti: string;
};
```

The token rules are:

- `sub` identifies the authenticated user.
- `globalRole` authorizes system-level operations.
- `organization.id` defines the active organization for organization and project scopes.
- `organization.roles` records the membership roles used when the token was issued.
- `organization: null` permits user-scoped operations but no organization or project operation.
- The issuer signs tokens for 15 minutes.
- Role, ban, and membership changes do not revoke an issued token. They take effect when the token
  expires or the client requests a replacement.

## Token broker

Add a Backoffice-specific Better Auth endpoint:

```text
POST /api/auth/backoffice-token
```

Input:

```ts
type IssueBackofficeTokenInput = {
  organizationId?: string | null;
};
```

The endpoint will:

1. Require a valid Better Auth session.
2. Load the current user and current organization memberships.
3. Reject banned or deleted users.
4. Select the requested organization when the user is a member.
5. Otherwise select the first membership using deterministic `createdAt`, then `id` ordering.
6. Sign a JWT with the existing Better Auth JWT/JWKS configuration.
7. Set the JWT in a dedicated HttpOnly access-token cookie.
8. Return only bootstrap metadata, including the selected organization ID and token expiration.

Example response:

```ts
type IssueBackofficeTokenResult = {
  expiresAt: string;
  organizationId: string | null;
};
```

The browser endpoint should not return the raw JWT. Preventing JavaScript from reading the token
reduces the value of an injected script. A separate, deliberate flow can expose bearer tokens for
non-browser integrations if the Backoffice later needs token export.

## Browser access-token cookie

Use a separate cookie from the Better Auth session:

- Production name: `__Host-fragno-backoffice.access_token`
- Development name: `fragno-backoffice.access_token`
- `HttpOnly: true`
- `Secure: true` outside development
- `SameSite: Lax`
- `Path: /`
- `Max-Age`: equal to the JWT lifetime

Cookie-authenticated mutations must retain same-origin and CSRF checks. Bearer-authenticated
requests do not rely on cookies and must not fall back to cookie authentication after receiving a
malformed `Authorization` header.

## Authentication flow

### Password sign-in

1. Submit credentials to Better Auth.
2. Better Auth creates the server-side session cookie.
3. Redirect to `/backoffice/auth/bootstrap`.
4. The bootstrap client reads the remembered organization preference.
5. It posts the preference to `/api/auth/backoffice-token`.
6. The token broker validates membership and sets the JWT cookie.
7. Redirect to the requested Backoffice page.

### GitHub sign-in

1. Set the OAuth callback to `/backoffice/auth/bootstrap`.
2. Better Auth completes OAuth and creates the server-side session.
3. The bootstrap flow requests the first JWT exactly as password sign-in does.

### Sign-up without verification

Redirect successful sign-up to `/backoffice/auth/bootstrap` instead of `/backoffice`.

### Sign-up with verification

Verification continues to end at the login page. The first successful sign-in then enters the normal
bootstrap flow.

### Full page reload

A valid JWT cookie authorizes the request without consulting the Better Auth session. If the JWT is
missing or expired, redirect to `/backoffice/auth/bootstrap`; the bootstrap route uses the
server-side session to request a replacement.

### Token refresh

The bootstrap response exposes `expiresAt`, not the token. The client schedules a refresh shortly
before expiration by calling `/api/auth/backoffice-token` with the current organization ID.

If an application request returns `401 Authentication expired`, the client attempts one token
refresh and retries the request once. A failed refresh redirects to login.

### Organization switch

1. Send the selected organization ID to `/api/auth/backoffice-token`.
2. The token broker validates current membership.
3. It replaces the access-token cookie with a JWT scoped to the new organization.
4. Store the organization ID as the local preference only after issuance succeeds.
5. Revalidate Backoffice route data.

Do not call Better Auth's `/organization/set-active` endpoint for Backoffice scope selection. The
JWT claim is the sole active-organization authority.

### Sign-out

Sign-out must clear both credentials:

1. Revoke the Better Auth session.
2. Expire the Backoffice access-token cookie.
3. Keep or clear the local organization preference according to the existing product decision.

## Request credential resolution

Replace the current cookie-versus-authorization check with explicit JWT transport resolution:

1. If an `Authorization` header exists, require a syntactically valid bearer JWT and use it.
2. Otherwise, read the Backoffice access-token cookie.
3. Ignore the Better Auth session cookie and unrelated cookies.
4. Return `Authentication required` when neither JWT transport exists.
5. Return `Invalid credential` for malformed authorization or invalid signatures.
6. Return `Authentication expired` for expired JWTs.

An explicit `Authorization` header takes precedence over the JWT cookie. The resolver must never
fall back to cookies when the caller supplied an invalid authorization header.

Remove Better Auth's bearer-session plugin. An opaque Better Auth session token in an Authorization
header is not a supported Backoffice credential.

## Server-side application boundary

Rename the current access-token module and APIs so their names describe request authentication:

```text
app/fragno/auth/access-token.server.ts
  -> app/fragno/auth/request-auth.server.ts
```

Use these entry points:

```ts
requireBackofficePrincipal(request, context);
authorizeRequestForScope(request, context, scope);
authorizeRequestForOrganization(request, context, organizationId);
```

Rename execution-context concepts that still say `verifiedAccessToken` to
`verifiedRequestAuthority`. The authority snapshot may originate from either JWT transport, but it
must always contain the organization from the verified JWT.

Scope authorization becomes:

- User scope: `payload.sub === scope.userId`.
- Organization scope: `payload.organization?.id === scope.orgId`.
- Project scope: `payload.organization?.id === scope.orgId`.
- System scope: `payload.globalRole === "admin"`.

## Current-user data

Stop using Better Auth's custom session response as the primary Backoffice application model.

Add a JWT-authenticated Backoffice endpoint that returns current user and membership data:

```text
GET /api/backoffice/me
```

This endpoint may read current memberships for navigation and organization selection, but it must
report the active organization from the JWT claim. Membership discovery and active authorization
remain separate concepts:

- The response can list every current membership.
- The current request can act only within the organization carried by its JWT.

Better Auth session APIs remain available only for authentication management and token brokerage.

## Default-organization preference

Extract default-organization storage from `auth-client.ts` into a focused module.

The module will:

1. Migrate `fragno-auth.default-organization-id` to `fragno-backoffice-default-organization`.
2. Return the stored ID to the bootstrap flow.
3. Replace stale values with the organization selected by the token broker.
4. Clear the preference when the user has no memberships.

The server treats every stored organization ID as untrusted input.

## Implementation phases

Each phase is a vertical slice. It must be independently mergeable and testable, leave the
Backoffice usable, and remove the compatibility code that only its completed user journey no longer
needs. Temporary fallback behavior must be named in the phase that introduces it and removed by a
later phase.

### Phase 1: Exchange a session for an organization-scoped JWT

**Status:** Implemented on August 11, 2026.

**User-visible outcome:** An authenticated user can request a Backoffice JWT and use it to read
their Backoffice identity without changing existing login or application routes.

Implement the complete exchange path:

- Add one token-lifecycle module that owns claims, the 15-minute lifetime, signing, verification,
  JWKS refresh, and access-token cookie operations.
- Add `POST /api/auth/backoffice-token`.
- Accept an optional organization preference and validate it against current membership.
- Fall back using deterministic membership `createdAt`, then `id` ordering.
- Issue the singular `organization` claim and set the browser access-token cookie.
- Add `GET /api/backoffice/me`, authorized by the new JWT, returning the current user, memberships,
  invitations, and active organization from the token.
- Keep existing session-authorized application paths unchanged during this phase.

**Phase tests:**

- Complete sign-up or sign-in, exchange the session, then call `/api/backoffice/me` with only the
  JWT cookie.
- Issue for a valid requested membership and reject a non-membership.
- Verify deterministic fallback, banned-user rejection, singular claims, cookie attributes, and JWKS
  rotation.
- Verify that the existing Backoffice continues to work through its pre-existing authentication
  path.

### Phase 2: Enter the Backoffice through password authentication

**Status:** Implemented on August 11, 2026.

**User-visible outcome:** Password sign-in and immediate sign-up enter the Backoffice with a JWT;
OAuth continues through its existing path until Phase 3.

Implement one complete browser journey:

- Add `/backoffice/auth/bootstrap`.
- Extract the organization preference into a focused client module and migrate the legacy storage
  key.
- Route successful password sign-in and sign-up without verification through bootstrap.
- Have bootstrap exchange the Better Auth session for a JWT before entering the application.
- Make the Backoffice layout and current-user navigation consume `/api/backoffice/me` when a JWT is
  present.
- Keep an explicitly temporary session fallback for users arriving through GitHub.
- Remove the password form's hidden organization field and password-login session organization
  initialization.

**Phase tests:**

- Password sign-in reaches bootstrap, receives a JWT, and opens the requested return path.
- Immediate sign-up follows the same journey.
- Reload succeeds with the JWT cookie after removing the Better Auth session cookie from the
  application request.
- A stale preference receives a validated fallback and repairs client storage.
- The existing GitHub sign-in journey still works through the temporary fallback.

### Phase 3: Complete every authentication lifecycle with a JWT

**Status:** Implemented on August 11, 2026.

**User-visible outcome:** Password, GitHub, verification-followed-by-login, refresh, expiry
recovery, and sign-out all use the same JWT bootstrap lifecycle.

Complete the remaining lifecycle paths:

- Send the GitHub callback to `/backoffice/auth/bootstrap`.
- Route the first login after email verification through the same bootstrap.
- Add proactive refresh using the current preferred organization.
- On an expired application request, attempt one session-backed refresh and one request retry.
- Redirect to login when refresh cannot recover a session.
- Make sign-out revoke the Better Auth session and expire the JWT cookie.
- Remove the temporary GitHub session fallback introduced in Phase 2.

**Phase tests:**

- Password, GitHub, and post-verification login all produce the same JWT-backed result.
- Refresh replaces the cookie while preserving a valid organization preference.
- An expired JWT recovers once through the session.
- A missing session after JWT expiry redirects to login without a loop.
- Sign-out makes both refresh and application authorization fail.

### Phase 4: Switch organizations by replacing the JWT

**Status:** Implemented on August 11, 2026.

**User-visible outcome:** Selecting an organization immediately changes the active Backoffice scope
and survives JWT refresh through the separate client preference.

Move active-organization behavior end to end:

- Rename the client concept from default organization to preferred organization.
- Replace organization switching with a call to `/api/auth/backoffice-token` for the selected
  organization.
- Store the preference only after token issuance succeeds.
- Revalidate route and current-user data after replacing the token.
- Report the active organization exclusively from the JWT claim.
- Remove application calls to `/organization/set-active` and session `activeOrganizationId`.
- Pass explicit organization IDs to Better Auth organization operations that still require them.

**Phase tests:**

- Switching replaces the JWT and changes the singular organization claim.
- A token for organization A cannot access organization B.
- Removed memberships are rejected without changing the stored preference.
- Successful switching repairs preference state and revalidates visible data.
- Refresh preserves the selected organization after revalidating membership.

### Phase 5: Run every browser application path on the JWT cookie

**Status:** Implemented on August 11, 2026.

**User-visible outcome:** All Backoffice pages, actions, and browser-initiated application requests
use the JWT cookie. Better Auth sessions remain available only to `/api/auth` operations.

Migrate the browser application boundary:

- Move every Backoffice loader and action to the JWT-authenticated principal and current-user
  endpoint.
- Move browser calls through fragment proxies and application APIs to JWT-cookie authorization.
- Replace `getAuthMe()` and `authClient.useMe()` with the JWT-backed current-user client.
- Remove `customSession()`, `buildAuthMe()`, and session membership/invitation enrichment.
- Remove application reads of Better Auth session `activeOrganizationId`.
- Keep Better Auth session cookies working for token exchange, refresh, sign-out, and management
  endpoints under `/api/auth`.

**Phase tests:**

- Exercise one representative loader, action, fragment proxy, and application API with only the JWT
  cookie.
- Verify that the full browser Backoffice journey works without session authorization.
- Verify that current-user membership discovery remains current while active scope comes from the
  JWT.
- Verify that Better Auth management endpoints still work with the session.

### Phase 6: Support service bearer JWTs through the same authority path

**Status:** Implemented on August 11, 2026.

**User-visible outcome:** Non-browser clients can use the same organization-scoped JWT through an
Authorization header, while opaque Better Auth bearer sessions are unsupported.

Complete the shared request-authentication boundary:

- Replace `access-token.server.ts` with `request-auth.server.ts`.
- Resolve an explicit bearer JWT first; otherwise resolve the browser JWT cookie.
- Reject malformed authorization without falling back to cookies.
- Ignore Better Auth session cookies and unrelated cookies during application authorization.
- Remove Better Auth's `bearer()` plugin and the `"bearer"` credential kind.
- Rename `verifiedAccessToken` to `verifiedRequestAuthority` and update the discriminator.
- Replace plural `organizationIds` scope checks with the singular organization claim.
- Migrate every public API, development route, and scoped fragment proxy to the shared resolver.

**Phase tests:**

- Bearer JWTs work with unrelated and Better Auth session cookies present.
- Authorization takes precedence over the JWT cookie.
- Malformed authorization never falls back to a valid cookie.
- Opaque bearer session tokens fail.
- User, organization, project, and global-admin system scopes enforce the new claims.
- Expired bearer and cookie JWTs return the same expiration response.

### Phase 7: Close legacy paths and leave one supported architecture

**Status:** Implemented on August 11, 2026.

**User-visible outcome:** Only the documented session-to-JWT exchange and JWT application boundary
remain available.

Remove the final compatibility surface:

- Disable Better Auth's default `/token` endpoint and set `disableSettingJwtHeader: true`.
- Keep `/jwks` enabled and remove `jwtClient()` from the browser.
- Remove session handling from application request authorization and remove the `"session"`
  credential kind.
- Remove `AuthObject.authenticateRequest()` or reduce it to a private authentication-internal
  operation.
- Remove unused `authMeDataSchema`, custom-session contracts, active-session organization code, and
  compatibility tests.
- Restrict the Better Auth session cookie to `/api/auth`.
- Expire obsolete session and access-token cookie names in secure and development forms.
- Clear rejected access-token cookies, set `Cache-Control: no-store` on auth bootstrap responses,
  and verify that logs never contain credentials.
- Move durable decisions into `app/fragno/auth/README.md` or an ADR and mark Better Auth work items
  3, 4, and 9 complete.

**Phase tests:**

- Better Auth's session cookie alone cannot authorize any application route.
- Default Better Auth JWT issuance paths are unavailable.
- Only `/api/auth/backoffice-token` issues an accepted Backoffice JWT.
- Historical cookie names are expired during cutover.
- The full password, GitHub, refresh, organization-switch, browser-cookie, and service-bearer
  journeys pass together.

Finish the phase with targeted dead-code searches:

```bash
rg "activeOrganizationId|set-active|organizationIds"
rg "verifiedAccessToken|verified-access-token"
rg "authorizeAccessToken|access-token.server"
rg "customSession|getAuthMe|authMeDataSchema"
rg "bearer\\(\\)|credentialKind.*bearer|jwtClient"
```

Every remaining occurrence must have a deliberate, documented reason to exist.

## Acceptance criteria

The work is complete when:

- Every successful authentication flow issues a Backoffice JWT before entering the application.
- Backoffice application routes never authorize Better Auth session cookies.
- The verified JWT is the only source of active organization state.
- Changing organization always replaces the JWT.
- Browser JWTs remain HttpOnly and never enter browser storage.
- External callers can use the same JWT format through an Authorization header.
- The complete Backoffice test suite and type checks pass.
