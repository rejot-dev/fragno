```ts title="app/api/stripe/[...all]/route.ts" tab="Next.js"
import { stripeFragment } from "@/lib/stripe";

export const { GET, POST, PUT, PATCH, DELETE } = stripeFragment.handlersFor("next-js");
```

```ts title="app/routes/api/stripe.tsx" tab="React Router v7"
import { stripeFragment } from "@/lib/stripe";

export const handlers = stripeFragment.handlersFor("react-router");

// Note: React Router requires individual exports, destructured exports don't work
export const action = handlers.action;
export const loader = handlers.loader;
```

```ts title="server/api/stripe/[...all].ts" tab="Nuxt"
import { stripeFragment } from "@/lib/stripe";

export default fromWebHandler(stripeFragment.handler);
```

```ts title="pages/api/stripe/[...all].ts" tab="Astro"
import { stripeFragment } from "@/lib/stripe";

export const { ALL } = stripeFragment.handlersFor("astro");
export const prerender = false;
```

```ts title="routes/api/stripe/[...path].ts" tab="SvelteKit"
import { stripeFragment } from "@/lib/stripe";

export const { GET, POST, PUT, PATCH, DELETE } = stripeFragment.handlersFor("svelte-kit");
export const prerender = false;
```

```ts title="index.ts", tab="Hono"
import { Hono } from "hono";
import { stripeFragment } from "@/lib/stripe";

const app = new Hono();
app.all("/api/stripe/*", (c) => stripeFragment.handler(c.req.raw));
```
