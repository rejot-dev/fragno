# Fragno Auth Fragment

The Auth fragment is a full-stack library: a single package that bundles backend routes, database
schema, and frontend hooks so you can drop authentication into any TypeScript app without wiring
everything by hand. It ships with typed routes, hooks, and client helpers.

- Email/password sign-up, sign-in, and sign-out
- Session cookies with configurable security attributes
- Organizations, roles, invitations, and active organization context
- OAuth providers (GitHub built-in)
- Hooks for user/session/org lifecycle events

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

## Configuration

`createAuthFragment(config, options)` supports:

- `cookieOptions`: `httpOnly`, `secure`, `sameSite`, `maxAge`, `path`
- `hooks`: `onUserCreated`, `onSessionCreated`, `onOrganizationCreated`, and more
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
the browser to complete the flow. The callback route sets the session cookie and can optionally
redirect to a `returnTo` path.

```ts
const { url } = await authClient.oauth.getAuthorizationUrl({
  provider: "github",
  returnTo: "/app",
});
window.location.assign(url);
```

Notes:

- `returnTo` must be a relative path starting with `/` (it is sanitized server-side).
- `link: true` links the provider to the currently signed-in user (session cookie required).
- `scope` and `loginHint` are passed through to the provider.
- You can set `defaultRedirectUri` once or override per provider with `redirectURI`.

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
3. Let GitHub redirect back to `/api/auth/oauth/github/callback` to set the session cookie and
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

This will set the session cookie on the same origin and return the signed-in user info.
