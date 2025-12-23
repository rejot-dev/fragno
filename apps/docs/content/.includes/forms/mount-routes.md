```ts title="app/api/forms/[...all]/route.ts" tab="Next.js"
import { formsFragment } from "@/lib/forms";

export const { GET, POST, PUT, PATCH, DELETE } = formsFragment.handlersFor("next-js");
```

```ts title="app/routes/api/forms.tsx" tab="React Router v7"
import { formsFragment } from "@/lib/forms";

export const handlers = formsFragment.handlersFor("react-router");

// Note: React Router requires individual exports, destructured exports don't work
export const action = handlers.action;
export const loader = handlers.loader;
```

```ts title="server/api/forms/[...all].ts" tab="Nuxt"
import { formsFragment } from "@/lib/forms";

export default fromWebHandler(formsFragment.handler);
```

```ts title="pages/api/forms/[...all].ts" tab="Astro"
import { formsFragment } from "@/lib/forms";

export const { ALL } = formsFragment.handlersFor("astro");
export const prerender = false;
```

```ts title="routes/api/forms/[...path].ts" tab="SvelteKit"
import { formsFragment } from "@/lib/forms";

export const { GET, POST, PUT, PATCH, DELETE } = formsFragment.handlersFor("svelte-kit");
export const prerender = false;
```

```ts title="index.ts", tab="Hono"
import { Hono } from "hono";
import { formsFragment } from "@/lib/forms";

const app = new Hono();
app.all("/api/forms/*", (c) => formsFragment.handler(c.req.raw));
```
