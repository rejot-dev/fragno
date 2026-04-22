# Fragno Auth Fragment

The Auth fragment is a full-stack library: a single package that bundles backend routes, database
schema, and frontend hooks so you can drop authentication into any TypeScript app without wiring
everything by hand. It ships with typed routes, hooks, and client helpers.

- Email/password sign-up, sign-in, and sign-out
- Strategy-neutral auth cookies (`fragno_auth`) with configurable security attributes
- Organizations, roles, invitations, and active organization context
- OAuth providers (GitHub built-in)
- Hooks for user/credential/org lifecycle events

## Install

```bash
npm install @fragno-dev/auth @fragno-dev/db
```

## Quickstart

### 1. Create the fragment server

```ts
import { createAuthFragment } from "@fragno-dev/auth";
import { fragmentDbAdapter } from "./db";

export const authFragment = createAuthFragment(
  {
    cookieOptions: {
      secure: true,
      sameSite: "Lax",
    },
  },
  {
    databaseAdapter: fragmentDbAdapter,
    mountRoute: "/api/auth",
  },
);
```

### 2. Mount routes (React Router example)

```ts
import { authFragment } from "@/lib/auth";

export const handlers = authFragment.handlersFor("react-router");
export const action = handlers.action;
export const loader = handlers.loader;
```

### 3. Create a client

```ts
import { createAuthFragmentClient } from "@fragno-dev/auth/react";

export const authClient = createAuthFragmentClient();

const { data: me } = authClient.useMe();
const { mutate: signIn } = authClient.useSignIn();
const { mutate: signOut } = authClient.useSignOut();
```

Other clients:

- `@fragno-dev/auth/vanilla`
- `@fragno-dev/auth/solid`
- `@fragno-dev/auth/svelte`
- `@fragno-dev/auth/vue`

## Route Surface

Auth:

- `GET /me`
- `POST /sign-up`
- `POST /sign-in`
- `POST /sign-out`
- `POST /change-password`
- `GET /users`
- `PATCH /users/:userId/role`

Organizations (enabled by default):

- `POST /organizations`
- `GET /organizations`
- `GET /organizations/:organizationId`
- `PATCH /organizations/:organizationId`
- `DELETE /organizations/:organizationId`
- `GET /organizations/active`
- `POST /organizations/active`
- `GET /organizations/:organizationId/members`
- `POST /organizations/:organizationId/members`
- `PATCH /organizations/:organizationId/members/:memberId`
- `DELETE /organizations/:organizationId/members/:memberId`
- `GET /organizations/:organizationId/invitations`
- `POST /organizations/:organizationId/invitations`
- `GET /organizations/invitations`
- `PATCH /organizations/invitations/:invitationId`

OAuth:

- `GET /oauth/:provider/authorize`
- `GET /oauth/:provider/callback`

## Auth Contract

Authenticated routes accept auth from one of two transports:

- the `fragno_auth` cookie
- `Authorization: Bearer <token>`

The old `sessionId` query/body transport is no longer part of the public contract.

Credential-issuing JSON routes return a normalized auth envelope:

```json
{
  "auth": {
    "token": "...",
    "kind": "session",
    "expiresAt": "2026-01-01T00:00:00.000Z",
    "activeOrganizationId": null
  }
}
```

This applies to:

- `POST /sign-up`
- `POST /sign-in`
- `GET /oauth/:provider/callback` when it returns JSON

`POST /sign-out` clears the `fragno_auth` cookie.

## Configuration

`createAuthFragment(config, options)` supports:

- `cookieOptions`: `httpOnly`, `secure`, `sameSite`, `maxAge`, `path`
- `hooks`: `onUserCreated`, `onCredentialIssued`, `onCredentialInvalidated`,
  `onOrganizationCreated`, and more
- `organizations`: `false` to disable or an organization config object
- `emailAndPassword`: `{ enabled?: boolean }` to toggle email/password routes
- `oauth`: providers and OAuth settings

Organization config fields:

- `roles`, `creatorRoles`, `defaultMemberRoles`
- `allowUserToCreateOrganization`, `invitationExpiresInDays`
- `autoCreateOrganization`, `limits`, `hooks`

OAuth config fields:

- `providers`: map of `OAuthProvider`
- `defaultRedirectUri`
- `stateTtlMs` (default is 10 minutes)
- `linkByEmail` (default is `true`)
- `tokenStorage`: `"none"` | `"refresh"` | `"all"`

## OAuth

OAuth is disabled unless configured. Use the authorize endpoint to get a provider URL, then redirect
the browser to complete the flow. The callback route sets the `fragno_auth` cookie, returns
`auth.token` when it responds with JSON, and can optionally redirect to a `returnTo` path.

```ts
const { url } = await authClient.oauth.getAuthorizationUrl({
  provider: "github",
  returnTo: "/app",
});
window.location.assign(url);
```

Notes:

- `returnTo` must be a relative path starting with `/` (it is sanitized server-side).
- `link: true` links the provider to the currently signed-in user (requires the ambient
  `fragno_auth` cookie or an `Authorization` header).
- `scope` and `loginHint` are passed through to the provider.
- You can set `defaultRedirectUri` once or override per provider with `redirectURI`.

## Migration Notes

If you are upgrading from the older session-centric contract:

- replace `response.sessionId` with `response.auth.token`
- stop sending `sessionId` in route query params or request bodies
- rely on ambient cookies or `Authorization: Bearer <token>` for authenticated requests
- rename hooks from `onSessionCreated` / `onSessionInvalidated` to `onCredentialIssued` /
  `onCredentialInvalidated`
- update any cookie expectations from `sessionid` to `fragno_auth`
- replace `fragment.services.buildSessionCookie(...)` with `fragment.services.buildAuthCookie(...)`
- stop using `fragment.services.getSession(headers)` as the auth entry point; use the shared
  request-auth helpers instead
- update direct service calls from `*WithSession` / `*ForSession` to the new `*ForCredential`,
  actor, or principal variants

### Small migration guide

Use this checklist when moving to the principal/credential contract introduced by the auth refactor
spec.

1. **Update request auth transport**
   - Stop forwarding `sessionId` in query params or bodies.
   - Send auth with the ambient `fragno_auth` cookie or `Authorization: Bearer <token>`.
   - Treat auth failures as `credential_invalid` instead of `session_invalid` in public route
     handling.

2. **Update response handling**
   - Read issued credentials from `response.auth.token`.
   - If you need metadata, also use `response.auth.kind`, `response.auth.expiresAt`, and
     `response.auth.activeOrganizationId`.
   - `POST /sign-out` now clears `fragno_auth`.

3. **Update client calls**
   - `authClient.signIn.email(...)` now takes `auth?: { activeOrganizationId?: string }` instead of
     `session`.
   - `authClient.oauth.getAuthorizationUrl(...)` now takes
     `auth?: { activeOrganizationId?: string }` instead of `session`.
   - Authenticated client calls should rely on cookie / bearer auth rather than manually passing
     `sessionId`.

4. **Update hooks**
   - Rename `onSessionCreated` → `onCredentialIssued`.
   - Rename `onSessionInvalidated` → `onCredentialInvalidated`.
   - Update hook payload reads from `payload.session` to `payload.credential`.
   - Replace removed compatibility type imports such as `SessionHookPayload` / `SessionSummary` with
     `CredentialHookPayload` / `CredentialSummary`.

5. **Update service/helper usage**
   - Replace `buildSessionCookie(...)` with `buildAuthCookie(...)`.
   - Replace `getSession(headers)` with `resolveRequestCredential(...)` or `getRequestAuth(...)` at
     the route boundary.
   - Replace `createSession(...)`, `validateSession(...)`, and `invalidateSession(...)` with
     `issueCredential(...)`, `validateCredential(...)`, and `invalidateCredential(...)`.
   - Replace old `*WithSession` / `*ForSession` organization, invitation, and user service
     entrypoints with the credential-, actor-, or principal-oriented variants.

6. **Update OAuth and sign-in seed inputs**
   - Sign-in request bodies now use `auth: { activeOrganizationId }`.
   - OAuth authorize now uses the `auth` query param for the active-organization seed.
   - OAuth linking requires an authenticated principal from cookie / bearer auth, not a
     route-specific session id flow.

## GitHub OAuth

### Server configuration

```ts
import { createAuthFragment, github } from "@fragno-dev/auth";

export const authFragment = createAuthFragment(
  {
    oauth: {
      defaultRedirectUri: "https://your-app.com/api/auth/oauth/github/callback",
      providers: {
        github: github({
          clientId: process.env.GITHUB_CLIENT_ID!,
          clientSecret: process.env.GITHUB_CLIENT_SECRET!,
        }),
      },
    },
  },
  { databaseAdapter, mountRoute: "/api/auth" },
);
```

### Using GitHub auth in your app

1. Create a GitHub OAuth App and set its callback URL to your fragment callback route.
2. Add a "Continue with GitHub" button that starts the flow.
3. Let GitHub redirect back to `/api/auth/oauth/github/callback` to set the `fragno_auth` cookie and
   redirect the user.

Example button:

```ts
const handleGithubLogin = async () => {
  const { url } = await authClient.oauth.getAuthorizationUrl({
    provider: "github",
    returnTo: "/app",
  });
  window.location.assign(url);
};
```

If you use a custom SPA callback page, finalize the login by calling the callback hook:

```ts
const params = new URLSearchParams(window.location.search);
await authClient.oauth.callback({
  provider: "github",
  code: params.get("code")!,
  state: params.get("state")!,
});
```

This will set the `fragno_auth` cookie on the same origin and return the signed-in user info plus
the normalized `auth` envelope.
