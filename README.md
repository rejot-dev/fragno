<p align="center">
  <img src="./assets/stripe-integration.png" alt="Stripe integration example" width="600" />
</p>

# Fragno - Build Full-Stack Libraries

Fragno is a meta framework for building full-stack TypeScript libraries that work across frameworks
like Next.js, Nuxt, React Router, SvelteKit, and more.

This is for:

- **Library authors** ship full-stack libraries with routes, client hooks, and optional data layer.
- **Users** integrate a Fragno library into their app with a few lines of code and get type-safe
  usage from both frontend and backend. The data layer integrate with their ORM.

Full documentation lives at [fragno.dev](https://fragno.dev/docs).

The docs reflect this split:

- **For library authors**:
  [Library author docs](https://fragno.dev/docs/fragno/for-library-authors/getting-started)
- **For users**: [User Quick Start](https://fragno.dev/docs/fragno/user-quick-start)

## Example use cases

- **Client libraries / SDKs** – e.g. a client library integrating with a payment provider that ships
  backend handlers (including webhooks), database schemas, and frontend hooks/components in one
  package. So users don't need to know the implementation details of the payment provider.
- **Full-stack product features** – opinionated packages that own backend, frontend, and data layer
  together, like authentication (Better Auth–style), feature flags, or form builders, where today
  you’d usually glue several separate tools together. Apps where directly storing data in the user's
  database is a superpower.

## Quick start (users integrating a Fragno library)

Use this if you are integrating an existing Fragno library like `@fragno-dev/example-fragment`.

```bash
npm install @fragno-dev/example-fragment
# or
pnpm add @fragno-dev/example-fragment
```

### 1. Mount the backend routes (example: Next.js)

```ts
// app/api/example-fragment/[...all]/route.ts
import { createExampleFragmentInstance } from "@/lib/example-fragment-server";

const exampleFragment = createExampleFragmentInstance();
export const { GET, POST, PUT, PATCH, DELETE } = exampleFragment.handlersFor("next-js");
```

### 2. Use the client hooks (example: React)

```tsx
// components/ExampleComponent.tsx
import { exampleFragment } from "@/lib/example-fragment-client";

export function ExampleComponent() {
  const { data, loading } = exampleFragment.useData();

  if (loading) {
    return <div>Loading...</div>;
  }

  return <div>{data}</div>;
}
```

For full, framework-specific instructions (Nuxt, React Router, Astro, SvelteKit, SolidStart, Hono,
Express, Node, Vue, Vanilla JS, etc.), see the
[User Quick Start](https://fragno.dev/docs/fragno/user-quick-start).

## Quick start (library authors)

Use this if you are building a Fragno library (a full-stack library) yourself.

```bash
# Create a new Fragno library from a template
npm create fragno@latest
# or
pnpm create fragno@latest

# Or add Fragno to an existing package
npm install @fragno-dev/core
# or
pnpm add @fragno-dev/core
```

At a high level you:

1. **Define a library** (its config and dependencies).
2. **Define routes** using `defineRoute`.
3. **Create a library instance** with `createFragment`.
4. **Create client hooks** with `createClientBuilder`.

The full walkthrough is in the
[Library Author docs](https://fragno.dev/docs/fragno/for-library-authors/getting-started).

## Features

- **End-to-end type safety**: Standard Schema-compatible route typing and fully type-safe client
  hooks.
- **Built-in frontend state management**: reactive stores with caching and invalidation (TanStack
  Query-style) via [Nano Stores](https://github.com/nanostores/nanostores).
- **Optional data layer**: type-safe database layer with schema generation and adapters for common
  ORMs.
- **Middleware support**: users can plug in authentication, rate limiting, and other cross-cutting
  concerns.
- **Streaming support**: NDJSON (newline-delimited JSON) streaming for real-time use cases.
- **Automatic code splitting**: library-level splitting via `@fragno-dev/unplugin-fragno`, no extra
  build complexity for end users.

## Framework and database support

Fragno focuses on a small, framework-agnostic surface (standard `Request`/`Response`) and provides
adapters for many environments.

| Client-side frameworks | Support | —   | Server-side frameworks  | Support |
| ---------------------- | ------- | --- | ----------------------- | ------- |
| React                  | ✅      |     | Node.js / Express       | ✅      |
| Vue                    | ✅      |     | React Router v7 / Remix | ✅      |
| Vanilla JavaScript     | ✅      |     | Astro                   | ✅      |
| Svelte                 | ✅      |     | Next.js                 | ✅      |
| SolidJS                | ✅      |     | Nuxt                    | ✅      |
|                        |         |     | SvelteKit               | ✅      |
|                        |         |     | SolidStart              | ✅      |
|                        |         |     | TanStack Start          | ✅      |

See the [Framework Support](https://fragno.dev/docs/fragno/reference/frameworks) page for the full
and up-to-date list, including database adapter support.

Supported ORMs are Kysely and Drizzle, with Postgres and SQLite. This includes PGLite and Cloudflare
Durable Objects.

## Examples

This repo ships complete examples and sample libraries:

- `example-fragments/stripe` – A featureful Stripe integration library that manages subscriptions
  and customers. It uses the data layer and to consume webhooks from Stripe and write them to the
  user's database. See the [Stripe Quick Start](https://fragno.dev/docs/stripe/quickstart) for more
  details.
- `example-fragments/example-fragment` – minimal Fragno library example.
- `example-apps/*` – full application examples (React Router, Next.js, Nuxt, Astro, SvelteKit,
  SolidStart, Vue SPA, etc.).
- `examples-apps/stripe-webshop` and `packages/stripe` – Stripe subscription library and example
  app, as described in
  ["Solving Split Brain Integrations"](https://fragno.dev/docs/blog/split-brain-stripe).

## Contributing

Fragno is an open source project. We welcome contributions! Fragno is licensed under the MIT
License. See the [LICENSE](LICENSE.md) file for details.

See the [CONTRIBUTING](CONTRIBUTING.md) file for details.

## Post Scriptum

If you want more background on why Fragno exists and how we think about full-stack libraries:

- ["The case for full-stack libraries"](https://fragno.dev/docs/blog/fragno-introduction)
- ["Solving Split Brain Integrations"](https://fragno.dev/docs/blog/split-brain-stripe)

Don't forget to give us a star ⭐️
