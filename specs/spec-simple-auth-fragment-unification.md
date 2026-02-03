# Source of Truth (copy from)

Absolute path: `/Users/wilco/dev/is3a-site/packages/simple-auth-fragment` (this is the
implementation we are copying from).

# Simple Auth Fragment Unification Plan

## Goal

Bring `packages/auth` in fragno up to parity with the is3a-site implementation, while keeping the
fragno package name/scope and workspace dependency strategy.

## Scope

- Update the fragment implementation, schema, routes, client helpers, tests, build config, and docs.
- Add new modules and tests present in is3a-site.
- Ensure any example usage in fragno compiles with the updated API.

## Plan

1. **Inventory + alignment decisions**
   - Confirm target folder: `packages/auth`.
   - Keep package name `@fragno-dev/auth` and workspace deps, but adopt the is3a feature set.
   - Decide whether to include is3a's extra docs (e.g., `CLAUDE.md`) or keep fragno's
     `CHANGELOG.md`.

2. **Package and build configuration**
   - Update `package.json` to add required dev deps (`@electric-sql/pglite`, `drizzle-orm`,
     `kysely-pglite`) and keep versions aligned with the repo standards.
   - Align `tsdown.config.ts` to externalize `@fragno-dev/db` (as in is3a).
   - Ensure scripts remain consistent (keep or drop `build:watch` per fragno conventions).

3. **Schema updates**
   - Add `role` column to `user` with default `"user"`.
   - Add `idx_user_id` unique index and `idx_user_createdAt` index.
   - Change `withDatabase(authSchema, "simple-auth-db")` to match is3a naming.

4. **Service and route refactor**
   - Extract password hashing to `src/user/password.ts`.
   - Split services/routes into modules:
     - `src/user/user-actions.ts` (sign-up, sign-in, change-password, update-user-role)
     - `src/session/session.ts` (session lifecycle, /me, /sign-out)
     - `src/user/user-overview.ts` (cursor pagination, search, sort)
     - `src/utils/cookie.ts` (cookie parsing, set/clear, session extraction)
   - Update `src/index.ts` to:
     - define `authFragmentDefinition` (new name)
     - wire `withDatabase(..., "simple-auth-db")`
     - provide services via module factories
     - export new types (`Role`, `GetUsersParams`, `UserResult`, `SortField`, `SortOrder`)
     - update `createAuthFragmentClients` with `credentials: "include"` and new hooks/methods

5. **Tests**
   - Update `src/index.test.ts` to use `drizzle-pglite` adapter and route factories.
   - Add `src/user/user-overview.test.ts` from is3a and adjust as needed for fragno conventions.

6. **Docs and examples**
   - Update `test.md` or any usage docs to reflect cookie-based sessions and new routes.
   - Audit any fragno example apps that import the fragment (e.g.,
     `example-apps/fragno-db-usage-drizzle`) and adjust imports/usages if the API changed (routes,
     clients, types).

7. **Validation**
   - Run type check and tests for the fragment package and any dependent examples.

## Validation Commands

- `pnpm -C /Users/wilco/dev/fragno/packages/auth types:check`
- `pnpm -C /Users/wilco/dev/fragno/packages/auth test`
- If examples were touched: run their type check/test commands as applicable.
