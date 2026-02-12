# Auth Fragment (@fragno-dev/auth)

## Summary

Minimal email/password auth with DB-backed users and sessions, cookie-based session management, and
basic admin APIs for listing users and updating roles.

## Use when

- You need a simple, self-hosted auth flow without external identity providers.
- Session cookies are acceptable for your app.
- A light user model and role-based admin access are sufficient.

## Config

The fragment config is optional but lets you control key behavior.

What you provide:

- `cookieOptions` (optional): session cookie settings like `httpOnly`, `secure`, `sameSite`,
  `maxAge`, and `path`.
- `sendEmail` (optional): email callback for future or custom flows.

What the fragment needs via options:

- `databaseAdapter`: required for users and sessions tables.
- `mountRoute` (optional): defaults to `/api/auth`.

## What you get

- Routes for sign-up, sign-in, sign-out, current user, and password change.
- User listing with cursor pagination and search.
- Cookie-based sessions with configurable cookie policies.
- DB schema for users and sessions.

## Docs (curl)

There is no `apps/docs` section for Auth in this repo. Use the search endpoint to find external
pages if they exist:

- `curl -s "https://fragno.dev/api/search?query=auth%20fragment"`

Local reference source for implementation details:

- `packages/auth/src/index.ts`
- `packages/auth/src/user/user-actions.ts`
- `packages/auth/src/session/session.ts`
- `packages/auth/src/schema.ts`

## Prerequisites

- A database and `@fragno-dev/db` adapter.
- A place to mount routes, typically `/api/auth`.
- CORS and cookie policy configured if using cross-origin clients.

## Install

`npm install @fragno-dev/auth @fragno-dev/db`

## Server setup

1. Create a database adapter (Kysely/Drizzle/etc.).
2. Instantiate the fragment:
   - `createAuthFragment(config?, { databaseAdapter, mountRoute? })`
3. Mount routes for your framework.
4. Generate and apply migrations using `fragno-cli`.

Example server module:

```ts
import { createAuthFragment } from "@fragno-dev/auth";
import { databaseAdapter } from "./db";

export const authFragment = createAuthFragment(
  {
    cookieOptions: { sameSite: "Lax", secure: true },
  },
  { databaseAdapter, mountRoute: "/api/auth" },
);
```

## Database migrations

Generate a schema file or SQL migrations:

- `npx fragno-cli db generate lib/auth.ts --format drizzle -o db/auth.schema.ts`
- `npx fragno-cli db generate lib/auth.ts --output migrations/001_auth.sql`

## Client setup

Use the framework-specific client entrypoint, e.g. React:

```ts
import { createAuthFragmentClient } from "@fragno-dev/auth/react";

export const authClient = createAuthFragmentClient({
  mountRoute: "/api/auth",
});
```

## Routes and hooks

- `POST /sign-up` -> `useSignUp`
- `POST /sign-in` -> `useSignIn`
- `POST /sign-out` -> `useSignOut`
- `GET /me` -> `useMe`
- `POST /change-password` -> `useChangePassword`
- `GET /users` -> `useUsers`
- `PATCH /users/:userId/role` -> `useUpdateUserRole`

## Security notes

- Session cookies are set with `Set-Cookie` on sign-in/sign-up.
- Cookie name is `sessionid`.
- For cross-origin clients, set `sameSite: "None"` and `secure: true`, and enable CORS with
  credentials.
- Protect the user admin routes (`/users` and `/users/:userId/role`) via middleware or an API
  gateway.

## Common pitfalls

- Forgetting to include credentials in fetch for same-origin or CORS usage.
- Not applying migrations before first request.
- Using `SameSite=None` without `Secure`, which browsers block.

## Next steps

- Wrap admin routes with role checks.
- Replace or extend with a custom auth provider if you need SSO or OAuth.
