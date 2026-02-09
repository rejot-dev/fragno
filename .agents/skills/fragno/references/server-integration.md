# Integrating a Fragment

## Built-in Configuration

- `baseUrl`: Change when backend runs separately from frontend (default `/`).
- `mountRoute`: Defaults to `/api/${fragmentName}`; set when mounting elsewhere.

These options can be configured at the frontend integration point, and are relevant when mounting
the backend route in a non-standard location.

## Mount API Routes

Mount the Fragment's API routes using framework-specific patterns. Fragno uses web standard
`Request` and `Response` objects, so frameworks not listed here will integrate similarly.

### Next.js

```typescript
// app/api/example-fragment/[...all]/route.ts
import { createExampleFragmentInstance } from "@/lib/example-fragment-server";

const exampleFragment = createExampleFragmentInstance();
export const { GET, POST, PUT, PATCH, DELETE } = exampleFragment.handlersFor("next-js");
```

### Nuxt

```typescript
// server/api/example-fragment/[...all].ts
import { createExampleFragmentInstance } from "@/lib/example-fragment-server";

const exampleFragment = createExampleFragmentInstance();
export default fromWebHandler(exampleFragment.handler);
```

### React Router v7

```typescript
// app/routes/api/example-fragment.tsx
import type { Route } from "./+types/example-fragment";
import { createExampleFragmentInstance } from "@/lib/example-fragment-server";

export async function loader({ request }: Route.LoaderArgs) {
  return await createExampleFragmentInstance().handler(request);
}

export async function action({ request }: Route.ActionArgs) {
  return await createExampleFragmentInstance().handler(request);
}
```

### Astro

```typescript
// pages/api/example-fragment/[...all].ts
import { createExampleFragmentInstance } from "@/lib/example-fragment-server";

const exampleFragment = createExampleFragmentInstance();
export const { ALL } = exampleFragment.handlersFor("astro");
export const prerender = false;
```

### SvelteKit

```typescript
// routes/api/example-fragment/[...path].ts
import { createExampleFragmentInstance } from "@/lib/example-fragment-server";

const exampleFragment = createExampleFragmentInstance();
export const { GET, POST, PUT, PATCH, DELETE } = exampleFragment.handlersFor("svelte-kit");
export const prerender = false;
```

### SolidStart

```typescript
// routes/api/[...example-fragment].ts
import { exampleFragmentInstance } from "@/lib/example-fragment-server";

// Make sure to initialize the fragment outside of route files
export const { GET, POST, PUT, PATCH, DELETE } = exampleFragmentInstance.handlersFor("solid-start");
```

### Hono

```typescript
// index.ts
import { Hono } from "hono";
import { createExampleFragmentInstance } from "@/lib/example-fragment-server";

const app = new Hono();
app.all("/api/example-fragment/*", (c) => createExampleFragmentInstance().handler(c.req.raw));
```

### Express

```typescript
// index.ts
import express from "express";
import { createExampleFragmentInstance } from "@/lib/example-fragment-server";
import { toNodeHandler } from "@fragno-dev/node";

const app = express();
app.all("/api/my-library/{*any}", toNodeHandler(createExampleFragmentInstance().handler));

// WARNING! If you're using the Express json middleware, make sure that it's mounted AFTER the
// Fragment handler.
app.use(express.json());
```

### Node.js

```typescript
// index.ts
import { createServer } from "node:http";
import { createExampleFragmentInstance } from "@/lib/example-fragment-server";
import { toNodeHandler } from "@fragno-dev/node";

const server = createServer((req, res) => {
  const exampleFragment = createExampleFragmentInstance();

  if (req.url?.startsWith(exampleFragment.mountRoute)) {
    const handler = toNodeHandler(exampleFragment.handler);
    return handler(req, res);
  }

  // ... Your route handling
});
```
