```ts title="app/api/example-fragment/[...all]/route.ts" tab="Next.js"
import { createExampleFragmentInstance } from "@/lib/example-fragment-server";

const exampleFragment = createExampleFragmentInstance();
export const { GET, POST, PUT, PATCH, DELETE } = exampleFragment.handlersFor("next-js");
```

```ts title="server/api/example-fragment/[...all].ts" tab="Nuxt"
import { createExampleFragmentInstance } from "@/lib/example-fragment-server";

export default fromWebHandler(createExampleFragmentInstance().handler);
```

```ts title="app/routes/api/example-fragment.tsx" tab="React Router v7"
import { createExampleFragmentInstance } from "@/lib/example-fragment-server";

export const handlers = createExampleFragmentInstance().handlersFor("react-router");

// Note: React Router requires individual exports, destructured exports don't work
export const action = handlers.action;
export const loader = handlers.loader;
```

```ts title="pages/api/example-fragment/[...all].ts" tab="Astro"
import { createExampleFragmentInstance } from "@/lib/example-fragment-server";

const exampleFragment = createExampleFragmentInstance();
export const { ALL } = exampleFragment.handlersFor("astro");
export const prerender = false;
```

```ts title="routes/api/example-fragment/[...path].ts" tab="SvelteKit"
import { createExampleFragmentInstance } from "@/lib/example-fragment-server";

const exampleFragment = createExampleFragmentInstance();
export const { GET, POST, PUT, PATCH, DELETE } = exampleFragment.handlersFor("svelte-kit");
export const prerender = false;
```

```ts title="index.ts", tab="Hono"
import { Hono } from "hono";
import { createExampleFragmentInstance } from "@/lib/example-fragment-server";

const app = new Hono();
app.all("/api/example-fragment/*", (c) => createExampleFragmentInstance().handler(c.req.raw));
```
