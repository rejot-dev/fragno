---
name: fragno
description: >
  Integrate existing Fragno fragments into applications: install fragment packages, configure server
  instances (and database adapters if required), mount server handlers for each framework, create
  client-side integrations, and use hooks/composables. Use when asked to wire a fragment into the
  user's application.
---

# Fragno Integration

## Overview

Fragno is a framework-agnostic, type-safe full-stack TypeScript toolkit that enables building
portable full-stack libraries called "fragments". Fragments include backend routes, (optional)
client hooks and (optional) database integration.

This skill will aid you to integrate a Fragment into an application. To do this we have to mount the
Fragment's backend routes, migrate/generate the database schema, and initialize the client-side
hooks.

## High-level Workflow

1. Install the Fragment
2. Mount the Fragment's backend routes
3. Initialize the client-side hooks
4. (Optionally) Database integration
5. (Optionally) Setup middleware for Fragment-defined routes (based on the user's authentication
   system)
6. (Optionally) Create a custom fetcher for the Fragment (e.g. for authentication headers)
7. Integrate the Fragment into frontend and backend where it makes sense

## Integration Workflow

### 1. Install the Fragment Package

Install the Fragment package via the user's npm-compatible package manager.

### 2. Create a Server-Side Fragment Instance

1. Find the most logical place, usually a central module in the application. If the user is already
   using Fragments, follow the same patterns.
2. Find the Fragment's main entrypoint function, e.g.
   `import { createFormsFragment } from "@fragno-dev/forms";`
3. Pass the Fragment-specific config (API keys, callbacks, etc.)
4. Determine if the Fragment needs a database: this is the case when the main function requires a
   `DatabaseAdapter` parameter.

### 3. Initialize the Database (If Required)

1. Determine the user's database system (should be any of the following, otherwise tell the user
   that installation WILL NOT be possible):
   - PostgreSQL (or PGLite), MySQL, SQLite (or Cloudflare Durable Objects)
   - Kysely, Drizzle, Prisma, (or no ORM)
2. Install `@fragno-dev/db` and `@fragno-dev/cli`.
3. Create a `databaseAdapter` in a central place.
   1. Import Dialect from `@fragno-dev/db/dialects`
   2. Import DriverConfig from `@fragno-dev/db/drivers`
4. Determine the method of migration generation:
   - For Drizzle and Prisma, schemas can be generated for use with the ORM's own migration tool.
   - For Kysely or no ORM, SQL migrations can be generated for use with the Fragno CLI.
5. Use the Fragno CLI to generate the schema file or migrations: (note that input can be more than
   one file)
   - `npx fragno-cli db generate lib/comment-fragment-server.ts --output migrations/001.sql`
   - `npx fragno-cli db generate lib/comment-fragment-server.ts --format drizzle --output schema/fragno-schema.ts`
   - `npx fragno-cli db generate lib/comment-fragment-server.ts --format prisma --output prisma/schema/fragno.prisma`
6. Integrate the schema with the ORM (e.g. by updating the Drizzle config)

### 4. Mount the Fragment's Backend Routes

Fragment's use web standard Request/Response objects, so they can be mounted in any framework that
supports them. There is also the framework-specific `handlersFor` function.

1. Determine what the Fragment's mount route is. The default is usually `/api/${fragmentName}`.
2. Determine the framework-specific way to mount the backend routes in the right location (example
   below)

Next.js example:

```ts title="app/api/example-fragment/[...all]/route.ts"
// This uses the Next.js file-based routing pattern.
import { createExampleFragmentInstance } from "@/lib/example-fragment-server";

const exampleFragment = createExampleFragmentInstance();
export const { GET, POST, PUT, PATCH, DELETE } = exampleFragment.handlersFor("next-js");
```

React Router v7 (Remix) example:

```ts title="app/routes/api/example-fragment.tsx"
import type { Route } from "./+types/example-fragment";
import { createExampleFragmentInstance } from "@/lib/example-fragment-server";

export async function loader({ request }: Route.LoaderArgs) {
  return await createExampleFragmentInstance().handler(request);
}

export async function action({ request }: Route.ActionArgs) {
  return await createExampleFragmentInstance().handler(request);
}
```

For Node.js (Express/Node.js) a separate package is required: `@fragno-dev/node`.

### 5. Create a Client-Side Integration

1. Create a client-side integration module in a central location.
2. Import the client creator from the fragment's **framework-specific export** (e.g. `/react`,
   `/vue`, `/svelte`, `/solid`, `/vanilla`).
3. If the backend routes are mounted on a non-default path, pass `mountRoute` to the client creator:
   ```typescript
   ...
   export const exampleFragment = createExampleFragmentClient({
      baseUrl: "/",
      mountRoute: "/custom/api/example-fragment",
   });
   ```
4. Use the fragment hooks/composables in UI components.

### 6. Optional steps

1. Create Fragno Fragment-specific route middleware to implement authentication (or other features).
2. Create a custom fetcher for the Fragment (e.g. for authentication headers).

### 7. Present options to user

- Determine what frontend hooks are available
- Determine what backend routes are available
- Determine what service methods are available

Present these to the user to come up with a plan for further deep integration into their
application.

## First-party Fragments (install by npm package name)

- `@fragno-dev/auth` - Very simple authentication
- `@fragno-dev/forms` - Form builder + form definition + form submission, storing in the user's
  database
- `@fragno-dev/stripe` - Stripe integration for subscription management and payment processing
- `@fragno-dev/workflows` - Durable workflows
- `@fragno-dev/upload` - File upload to s3-compatible storage

## Docs lookup

The Fragno documentation is available online:

- Search the docs:
  - `curl -s "https://fragno.dev/api/search?query=databaseAdapter"`
- Fetch Framework docs as Markdown:
  - `curl -L "https://fragno.dev/docs/fragno/user-quick-start" -H "accept: text/markdown"`
- Fetch a specific first-party Fragment's docs:
  - `curl -L "https://fragno.dev/docs/forms/static-forms" -H "accept: text/markdown"`

## References

The following reference files are available in `./references/`:

| File                      | Description                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `server-integration.md`   | Server-side integration: Framework-specific mounting patterns for server-side API routes        |
| `client-integration.md`   | Creating client-side integration modules and using Fragment hooks/composables in UI components  |
| `client-customization.md` | Customizing HTTP requests made by Fragno Fragments (authentication, CORS, interceptors)         |
| `middleware.md`           | Intercepting and processing requests before they reach route handlers                           |
| `services.md`             | Running functions defined by Fragments on the server, including calling route handlers directly |
