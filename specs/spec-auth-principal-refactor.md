# Auth Principal + Credential Strategy Refactor — Spec

## 0. Open Questions

None.

## 1. Overview

This document specifies the refactor that decouples `@fragno-dev/auth` from its current
**session-row-first** architecture and introduces a stable **auth principal + credential strategy**
boundary.

Today, most authenticated routes and services in `packages/auth` assume that request authentication
is represented by a database-backed `session` row identified by a `sessionId` pulled from cookies,
query params, request bodies, or route-specific helpers. That coupling is spread across route
handlers, service methods, organization flows, OAuth linking, helper utilities, tests, and client
wrappers.

The purpose of this refactor is to make the rest of the auth fragment consume a normalized
**`AuthPrincipal`** and a centralized **credential issuance / credential resolution** layer, so that
multiple authentication strategies can exist behind the same route and service contracts.

This refactor does **not** implement JWTs. It introduces the shape that the later stateless-JWT
strategy will plug into. During this refactor, the only concrete strategy is the existing
database-backed session implementation, expressed as the first-class **session strategy**.

This refactor preserves current runtime behavior where practical, including the OAuth callback’s
existing redirect flow. It does **not** preserve the old `sessionId`-named public transport
contract, and it standardizes request authentication on cookies and `Authorization` headers only.
For cookie-based auth, it also standardizes on a single strategy-neutral cookie name, `fragno_auth`,
replacing the current session-specific cookie name.

## 2. References

- Auth fragment entry: `packages/auth/src/index.ts`
- Current session routes/services: `packages/auth/src/session/session.ts`
- Current sign-in/sign-up/change-password routes: `packages/auth/src/user/user-actions.ts`
- Current OAuth routes/services: `packages/auth/src/oauth/routes.ts`,
  `packages/auth/src/oauth/oauth-services.ts`
- Current organization routes/services: `packages/auth/src/organization/routes.ts`,
  `packages/auth/src/organization/organization-services.ts`,
  `packages/auth/src/organization/member-services.ts`,
  `packages/auth/src/organization/invitation-services.ts`,
  `packages/auth/src/organization/active-organization.ts`
- Current schema: `packages/auth/src/schema.ts`
- Cookie/session token parsing: `packages/auth/src/utils/cookie.ts`
- Auth README and docs: `packages/auth/README.md`, `apps/docs/content/docs/auth/index.mdx`,
  `apps/docs/content/docs/auth/oauth.mdx`, `apps/docs/content/docs/auth/organizations.mdx`

## 3. Terminology

- **Credential**: the serialized secret presented by the client on each request. In the current
  implementation this is the opaque session id; in later strategies it may be a JWT.
- **Credential strategy**: the implementation responsible for issuing credentials, resolving a
  request credential into a principal, and clearing or invalidating auth state.
- **Principal**: the normalized authenticated actor used by routes and services after auth has been
  resolved.
- **Actor**: the user performing a mutation. In this spec, actor data comes from the principal.
- **Auth context**: auth-specific per-request metadata such as credential kind, expiry, and active
  organization id.
- **Session strategy**: the current database-backed `session` table strategy.

## 4. Goals / Non-goals

### 4.1 Goals

1. Introduce a stable internal auth boundary that routes and services consume instead of raw
   `sessionId` values.
2. Centralize request credential extraction and validation in one place per route.
3. Centralize credential issuance and clearing so sign-up, sign-in, OAuth callback, sign-out, and
   active-organization changes do not each hand-roll response auth logic.
4. Replace service signatures that currently accept `sessionId` with signatures that accept a
   normalized principal or actor context.
5. Introduce a public response shape and auth transport contract that can work for both the session
   strategy and a future stateless JWT strategy.
6. Preserve current runtime behavior while the only installed strategy is the session strategy.
7. Prepare the fragment for the follow-up stateless-JWT spec without requiring another large API
   reshuffle.
8. Simplify the public auth contract instead of preserving old `sessionId`-named transport fields.
9. Make the public client helpers and generated route types follow the new strategy-neutral auth
   model.
10. Make the breaking-change and migration surface explicit.

### 4.2 Non-goals

- Implementing JWT signing, verification, or JWT-specific config.
- Removing the `session` table.
- Changing organization semantics in this refactor.
- Redesigning OAuth provider contracts.
- Introducing refresh tokens or token rotation.
- Preserving old request/response field names for backward compatibility.

## 5. Packages / Components

All work lives in `packages/auth`.

### 5.1 New internal modules

The refactor introduces the following internal modules (names can vary slightly, responsibilities
may not):

- `src/auth/types.ts`
  - shared principal, actor, credential, resolution, and issuance types.
- `src/auth/request-auth.ts`
  - route-boundary helpers that extract request credentials and resolve request auth.
- `src/auth/credential-strategy.ts`
  - strategy interface plus session-strategy implementation registration.
- `src/auth/response-auth.ts`
  - helpers for building response payloads and headers from issued credentials.
- `src/auth/actor.ts`
  - helpers for narrowing principal-to-actor data used by services.

Existing `src/utils/cookie.ts` may remain cookie-specific, but it must stop being the generic place
where all auth resolution decisions are made.

### 5.2 Existing modules updated

- `src/user/user-actions.ts`
- `src/session/session.ts`
- `src/oauth/routes.ts`
- `src/oauth/oauth-services.ts`
- `src/organization/routes.ts`
- `src/organization/organization-services.ts`
- `src/organization/member-services.ts`
- `src/organization/invitation-services.ts`
- `src/organization/active-organization.ts`
- `src/client/default-organization.ts`
- `src/index.ts`
- related tests, docs, and client helpers

## 6. Public Config Surface

`AuthConfig` gains an explicit authentication strategy section even though, in this refactor, only
one strategy exists.

```ts
export interface AuthConfig<TRole extends string = DefaultOrganizationRole> {
  authentication?: {
    strategy?: "session";
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

- Omitting `authentication` behaves the same as `{ strategy: "session" }`.
- The strategy selection is public config because the follow-up stateless-JWT spec depends on it.
- Cookie-based auth uses the strategy-neutral cookie name `fragno_auth`.
- This refactor renames the current cookie from `sessionid` to `fragno_auth`.
- Cookie naming is not strategy-specific.

## 7. Principal, Actor, and Credential Types

### 7.1 `AuthPrincipal`

Routes and services must normalize authenticated requests into this conceptual shape:

```ts
export interface AuthPrincipal {
  user: {
    id: string;
    email: string;
    role: Role;
  };
  auth: {
    strategy: "session" | "stateless-jwt";
    credentialKind: "session" | "jwt";
    credentialSource: "cookie" | "authorization-header";
    credentialId: string | null;
    expiresAt: Date | null;
    activeOrganizationId: string | null;
  };
}
```

Rules:

- `AuthPrincipal` is the only auth shape that route handlers may pass into authenticated services.
- Services must not parse cookies, headers, query params, or request bodies for authentication.
- Services must not require access to the raw credential string.
- `credentialId` is an opaque identifier for hooks, logging, and observability. In the session
  strategy it is the existing session id.
- Strategy implementations may use richer private resolution data internally, but that richer shape
  must not leak across the route/service boundary in place of `AuthPrincipal`.

### 7.2 `AuthActor`

For mutation-focused services, a narrowed actor type is used:

```ts
export interface AuthActor {
  userId: string;
  email: string;
  role: Role;
  activeOrganizationId: string | null;
}
```

Rules:

- If a service only needs actor identity and current active org context, it takes `AuthActor`.
- If a service needs auth metadata such as expiry or credential id, it takes `AuthPrincipal`.

### 7.3 Issued credential envelope

All credential-issuing routes must return a normalized envelope, regardless of strategy:

```ts
export interface IssuedAuthCredential {
  token: string;
  kind: "session" | "jwt";
  expiresAt: Date | null;
  activeOrganizationId: string | null;
}
```

### 7.4 Request auth resolution result

The shared request-auth helper must return a normalized success/failure shape.

Conceptual shape:

```ts
export type ResolveRequestAuthResult =
  | {
      ok: true;
      principal: AuthPrincipal;
    }
  | {
      ok: false;
      reason: "missing" | "malformed" | "invalid";
    };
```

Rules:

- `missing` means no credential was provided in any supported transport.
- `malformed` means a credential transport was present but could not be parsed, for example an
  invalid `Authorization` header format.
- `invalid` means a credential was parsed successfully but did not resolve to an authenticated
  principal, including expired credentials.

## 8. Route Contract Changes

This refactor establishes the route shapes that later strategies must reuse.

### 8.1 Auth transport contract

Authenticated routes must support only header-based or cookie-based request authentication.

Rules:

- `Authorization: Bearer <token>` and cookie transport are the only supported request credential
  transports in this refactor.
- Route implementations must call a shared helper that knows the accepted transports and their
  precedence.
- Existing `sessionId`-named query/body fields are removed from the shared public contract.
- No query-string auth field is supported.
- No request-body auth field is supported.
- If multiple credential sources are present, the highest-precedence supported source wins and lower
  precedence sources are ignored for this refactor.
- Precedence is:
  1. `Authorization: Bearer <token>`
  2. Cookie

### 8.2 Auth output vocabulary for issuing routes

Credential-issuing routes must expose `auth` in their JSON body.

Required shape for:

- `POST /sign-up`
- `POST /sign-in`
- `GET /oauth/:provider/callback` when it returns JSON

Conceptual response:

```ts
{
  auth: {
    token: string;
    kind: "session" | "jwt";
    expiresAt: string | null;
    activeOrganizationId: string | null;
  };
  userId: string;
  email: string;
  role: "user" | "admin";
  returnTo?: string | null; // callback only
}
```

Rules:

- `auth.token` is the source of truth for the issued credential.
- The normalized response helper is responsible for producing the `auth` envelope consistently
  across session and JWT strategies.
- Existing `sessionId` response fields are removed from the shared public contract.

### 8.3 OAuth callback redirect behavior

The OAuth callback preserves its existing redirect behavior.

Rules:

- When the callback result includes `returnTo`, the route may respond with `302` and `Location`
  rather than a JSON body.
- Redirect responses still go through the shared response-auth helper so credential transport is
  applied consistently, including cookie issuance for the session strategy.
- When the callback responds with a redirect, it does **not** also serialize a JSON `auth` body.
- When the callback responds with JSON, it must use the normalized `auth` envelope from §8.2.

### 8.4 Auth replacement vocabulary for non-login routes

Some authenticated mutations may need to return updated auth state after the mutation changes auth
context.

Rules:

- Routes that may re-issue or materially update auth state may include an optional `auth` field in
  their JSON response using the same envelope as §8.2.
- In this refactor, `POST /organizations/active` must be wired through the shared response-auth
  helper and may include `auth` when the active organization change requires credential re-issuance
  for the installed strategy.
- Under the session strategy, changing the active organization updates the existing session row in
  place and does **not** require a new credential token, so `POST /organizations/active` does not
  need to include `auth` in normal session-strategy responses.
- Sign-out does not return an `auth` field.

### 8.5 Public client API migration

The public client helpers and generated route types must follow the new strategy-neutral contract.

Rules:

- Public client method parameters that currently accept `sessionId` for query/body forwarding must
  be removed rather than renamed.
- Public client outputs that currently expose `sessionId` from credential-issuing routes must be
  replaced with the normalized `auth` envelope.
- `createAuthFragmentClients()` and related helper types must be updated to match the new request
  and response contracts.
- Client flows that currently forward auth explicitly through route params must instead rely on
  ambient cookies or request-level `Authorization` headers.
- Default-organization client helpers that currently forward `sessionId` must be updated to stop
  threading auth through route params.
- This refactor does **not** provide compatibility aliases for the old `sessionId` public client
  contract.

## 9. Strategy Interface

Internally, auth resolution and issuance must be delegated through a strategy interface.

Conceptual shape:

```ts
export interface AuthCredentialStrategy {
  name: "session" | "stateless-jwt";
  resolveRequestAuth(input: ResolveRequestAuthInput): Promise<ResolveRequestAuthResult>;
  issueCredential(input: IssueCredentialInput): Promise<IssuedAuthCredential>;
  clearCredential(input: ClearCredentialInput): Promise<{ headers?: HeadersInit }>;
  maybeReissueCredential?(input: MaybeReissueCredentialInput): Promise<IssuedAuthCredential | null>;
}
```

The exact method breakdown may vary, but the following responsibilities must be centralized:

- resolve a request credential into `AuthPrincipal`
- issue a credential after sign-up, sign-in, or OAuth callback
- optionally re-issue a credential after active-org changes or other auth-affecting mutations
- clear response transport state on sign-out

### 9.0 Example strategy implementation

The following example is illustrative pseudocode showing how the session strategy can implement the
`AuthCredentialStrategy` interface while keeping route/service code strategy-neutral.

```ts
const AUTH_COOKIE_NAME = "fragno_auth";

export const sessionCredentialStrategy: AuthCredentialStrategy = {
  name: "session",

  async resolveRequestAuth({ headers, services }): Promise<ResolveRequestAuthResult> {
    const authorization = headers.get("Authorization");
    const bearerToken = parseBearerToken(authorization);
    const cookieToken = parseCookie(headers.get("Cookie"), AUTH_COOKIE_NAME);
    const token = bearerToken ?? cookieToken;
    const source = bearerToken ? "authorization-header" : cookieToken ? "cookie" : null;

    if (!token || !source) {
      return { ok: false, reason: "missing" };
    }

    if (authorization && bearerToken === "malformed") {
      return { ok: false, reason: "malformed" };
    }

    const session = await services.validateSession(token);
    if (!session) {
      return { ok: false, reason: "invalid" };
    }

    return {
      ok: true,
      principal: {
        user: {
          id: session.user.id,
          email: session.user.email,
          role: session.user.role,
        },
        auth: {
          strategy: "session",
          credentialKind: "session",
          credentialSource: source,
          credentialId: session.id,
          expiresAt: session.expiresAt,
          activeOrganizationId: session.activeOrganizationId,
        },
      },
    };
  },

  async issueCredential({ userId, activeOrganizationId, services }): Promise<IssuedAuthCredential> {
    const result = await services.createSession(userId, { activeOrganizationId });
    if (!result.ok) {
      throw new Error(`Unable to create session: ${result.code}`);
    }

    return {
      token: result.session.id,
      kind: "session",
      expiresAt: result.session.expiresAt,
      activeOrganizationId: result.session.activeOrganizationId,
    };
  },

  async clearCredential({ principal, services, cookieOptions }) {
    if (principal?.auth.credentialId) {
      await services.invalidateSession(principal.auth.credentialId);
    }

    return {
      headers: {
        "Set-Cookie": buildClearCookieHeader({
          ...cookieOptions,
          name: AUTH_COOKIE_NAME,
        }),
      },
    };
  },

  async maybeReissueCredential() {
    return null;
  },
};
```

Key points shown by the example:

- routes never parse session ids directly
- routes call the strategy once, then pass `principal` / `actor` into services
- the session strategy owns cookie parsing, session lookup, issuance, and clearing
- the strategy returns normalized auth data even though the underlying implementation is still
  backed by the `session` table
- future strategies can swap out the internal token format while preserving the same route/service
  boundary

### 9.1 Session strategy

The refactor must wrap the current behavior as the `session` strategy.

Behavior to preserve:

- session ids remain the credential value
- sessions are created in the `session` table
- sessions are validated against `expiresAt`
- sign-out deletes the session row
- cookie issuance/clearing behavior remains identical aside from the standardized cookie name change
  from `sessionid` to `fragno_auth`
- org-scoped context still comes from the current session row
- active-organization changes update the session row in place rather than creating a new session id

### 9.2 Cookie transport standardization

Cookie handling uses a single strategy-neutral cookie name across strategies.

Rules:

- All cookie-based auth strategies must use the cookie name `fragno_auth`.
- The request-auth helper reads the same cookie name regardless of the installed strategy.
- The cookie name is part of the public browser-facing auth contract in this refactor.
- Strategies may differ in cookie value format and issuance/clearing internals, but not in the
  cookie name.
- The session strategy adopts `fragno_auth` even though its credential value remains a session id.
- Future strategies such as stateless JWT reuse `fragno_auth` rather than introducing a new
  strategy-specific cookie name.

## 10. Route Lifecycle Rules

### 10.1 One auth resolution per route

Each authenticated route resolves auth exactly once at the route boundary.

Pattern:

1. parse headers as needed
2. call shared request-auth helper
3. if auth fails, return route error
4. call services with `principal` / `actor`
5. optionally issue replacement credential using shared response-auth helper

Routes must not:

- call `extractSessionId()` directly
- perform ad hoc session lookups in multiple helpers
- parse `Authorization` headers themselves

The shared entry point is conceptually:

```ts
getRequestAuth({
  headers,
});
```

In this refactor it is a headers-based helper because the only supported request auth transports are
`Authorization` and cookies.

### 10.2 Optional-auth routes

Some routes only require authentication in certain modes.

Rules:

- Routes with conditional auth, such as OAuth authorize with `link=true`, must still use the shared
  request-auth helper when auth is required.
- Conditional-auth routes must not manually parse cookies or bearer headers just because auth is
  optional in some branches.
- The route owns the decision of whether auth is required for the current branch; the shared helper
  owns auth transport parsing and resolution.

### 10.3 Auth error mapping

Routes must map normalized auth-resolution failures consistently.

Rules:

- `missing` → route-level auth required error, typically `400` for current route contracts that
  require explicit auth presence.
- `malformed` → `400`.
- `invalid` → `401`.
- Permission and domain checks after successful auth resolution remain `403` or route-specific
  domain errors.

### 10.4 Services own domain checks, not transport checks

After a principal has been resolved:

- services may check actor role, membership, organization ownership, invitation state, etc.
- services may not care whether auth came from cookie or bearer
- services may not assume a backing `session` row exists in future strategies

## 11. Service Signature Refactor Scope

The following signature class changes are required.

### 11.1 User/session services

Examples:

- `updateUserRoleWithSession(sessionId, userId, role)` → `updateUserRole({ actor, userId, role })`
- `changePasswordWithSession(sessionId, passwordHash)` → `changePassword({ actor, passwordHash })`
- route/service consumers should use the shared request-auth helper as the auth entry point rather
  than relying on `getSession(headers)` as the cross-strategy helper.

### 11.2 Organization services

All organization and invitation services that currently take `sessionId` must instead take a
principal or actor input.

Examples:

- `createOrganizationWithSession({ sessionId, input })` → `createOrganization({ actor, input })`
- `listOrganizationMembersWithSession({ sessionId, organizationId, ... })` →
  `listOrganizationMembers({ actor, organizationId, ... })`
- `setActiveOrganization(sessionId, organizationId)` →
  `setActiveOrganization({ principal, organizationId })`

### 11.3 OAuth services

Examples:

- `createOAuthState({ sessionId, link, ... })` must accept actor/principal context rather than a raw
  session id.
- OAuth linking becomes a generic “authenticated principal required” flow instead of a
  route-specific session-cookie flow.

## 12. Hook Semantics

This refactor renames the public auth lifecycle hooks to strategy-neutral names:

- `onCredentialIssued`
- `onCredentialInvalidated`

Rules:

- hooks operate on the normalized auth lifecycle, not directly on `session` table behavior
- the old public hook names `onSessionCreated` and `onSessionInvalidated` are removed as part of
  this breaking change
- hook payloads remain structurally compatible with the current `SessionHookPayload` shape in this
  refactor, but the semantics are credential-lifecycle based rather than row-lifecycle based
- `SessionSummary.id` becomes an opaque credential identifier, not a promise of a row that can be
  reloaded later
- the session strategy continues to use the real session id as that identifier
- the later JWT strategy may use a token `jti`
- sign-up, sign-in, and successful OAuth callback continue to fire `onCredentialIssued`
- sign-out and explicit credential invalidation continue to fire `onCredentialInvalidated`
- deleting expired session rows continues to count as invalidation for the session strategy where
  the existing implementation already emits that lifecycle event
- updating auth context in place without issuing a new credential identifier, such as the session
  strategy’s active-organization update, does **not** fire either hook
- if a future strategy re-issues a new credential identifier for an auth-context change, hook
  behavior must be defined in that strategy’s spec rather than guessed in this refactor

This refactor intentionally takes the full breaking change on hook names so the lifecycle contract
is strategy-neutral before JWTs are added.

## 13. API Normalization Direction

The repo standardizes on:

- cookie or `Authorization: Bearer ...` for request authentication
- `auth.token` for credential-issuing response payloads
- shared request-auth helpers as the server-side auth entry point

This refactor intentionally does not preserve the old `sessionId`-named request/response transport
fields in the shared public contract, and it does not introduce a replacement query/body auth field.

## 14. Versioning / Migration

This refactor is a breaking public API change.

Rules:

- The release must be treated as a breaking change for `@fragno-dev/auth`.
- A changeset must be added describing the request/response/client API contract changes.
- Migration notes must call out the removal of explicit `sessionId` query/body auth passing, the
  replacement of `sessionId` response fields with `auth.token`, the cookie rename from `sessionid`
  to `fragno_auth`, and the hook rename from `onSessionCreated` / `onSessionInvalidated` to
  `onCredentialIssued` / `onCredentialInvalidated`.
- Docs and examples must be updated in the same change so the published contract is internally
  consistent.

## 15. Testing Requirements

Update tests so the new boundary is enforced.

Required coverage:

1. request-auth helper precedence (`Authorization`, cookie)
2. request-auth helper failure categories (`missing`, `malformed`, `invalid`)
3. credential issuance helper used by sign-up, sign-in, and OAuth callback
4. sign-out uses shared credential clearing path
5. organization routes work without parsing raw session ids in services
6. OAuth link flow uses resolved principal instead of route-specific session parsing
7. OAuth callback preserves redirect behavior and still uses shared response-auth logic
8. public client helpers and route types remove `sessionId` request params and use `auth` instead of
   `sessionId` in credential-issuing responses
9. default-organization client flows still work without explicit auth route params
10. cookie issuance, lookup, and clearing use the renamed strategy-neutral cookie `fragno_auth`
11. session strategy behavior remains unchanged behind the new auth boundary aside from the cookie
    rename
12. renamed hook payload compatibility and hook firing behavior remain correct
13. code-level enforcement that authenticated routes/services no longer import or rely on
    `extractSessionId()` outside the request-auth / strategy layer

## 16. Locked Decisions

1. The auth fragment will expose a strategy-neutral auth boundary before JWTs are implemented.
2. Routes resolve authentication once and pass principals/actors into services.
3. Request authentication supports only cookies or `Authorization: Bearer ...`.
4. All cookie-based auth strategies use the strategy-neutral cookie name `fragno_auth`.
5. Credential-issuing JSON responses expose `auth.token` as the canonical credential field.
6. OAuth callback preserves its current redirect behavior; JSON normalization applies when the
   callback returns JSON.
7. Public auth lifecycle hooks are renamed to `onCredentialIssued` and `onCredentialInvalidated` as
   part of this breaking change.
8. The session implementation is preserved as a first-class concrete strategy behind the new
   boundary.
9. The refactor does not preserve the old `sessionId` transport contract and does not add a new
   query/body auth transport.
10. The public client helpers are updated to the new auth model in the same breaking change.

## 17. Documentation Updates

Update the following once this refactor lands:

- `packages/auth/README.md`
  - document `auth.token`
  - describe session and JWT as strategies behind the same auth contract
  - document that request authentication uses cookies or `Authorization` headers only
  - document the strategy-neutral cookie name `fragno_auth`
  - document the hook rename to `onCredentialIssued` / `onCredentialInvalidated`
- `apps/docs/content/docs/auth/index.mdx`
- `apps/docs/content/docs/auth/oauth.mdx`
- `apps/docs/content/docs/auth/organizations.mdx`
- `apps/docs/content/docs/fragno/for-users/services.mdx`
  - use `auth.token` in examples that forward response bodies
- any backoffice or example-app usage that explicitly stores/forwards `sessionId`
- migration notes / changelog entry for the breaking transport and hook changes
