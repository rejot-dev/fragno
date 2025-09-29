```ts title="app/api/example-fragment/[...all]/route.ts" tab="Next.js"
import { toNextJsHandler } from "@fragno-dev/core/next-js";
import { createExampleFragmentInstance } from "@/lib/example-fragment-server";

export const { GET, POST, PUT, PATCH, DELETE } = toNextJsHandler(createExampleFragmentInstance());
```

```ts title="server/api/example-fragment/[...all].ts" tab="Nuxt"
import { createExampleFragmentInstance } from "@/lib/example-fragment-server";

export default fromWebHandler(exampleFragment.handler);
```

```ts title="app/routes/api/example-fragment.tsx" tab="React Router v7"
import type { Route } from "./+types/example-fragment";
import { createExampleFragmentInstance } from "@/lib/example-fragment-server";

export async function loader({ request }: Route.LoaderArgs) {
  return await createExampleFragmentInstance().handler(request);
}

export async function action({ request }: Route.ActionArgs) {
  return await createExampleFragmentInstance().handler(request);
}
```

```ts title="pages/api/example-fragment/[...all].ts" tab="Astro"
import { createExampleFragmentInstance } from "@/lib/example-fragment-server";
import { toAstroHandler } from "@fragno-dev/core/astro";

export const { ALL } = toAstroHandler(createExampleFragmentInstance().handler);
export const prerender = false;
```

```ts title="routes/api/example-fragment/[...path].ts" tab="SvelteKit"
import { createExampleFragmentInstance } from "@/lib/example-fragment-server";
import { toSvelteHandler } from "@fragno-dev/core/svelte-kit";

export const { GET, POST, PUT, PATCH, DELETE } = toSvelteHandler(createExampleFragmentInstance());
export const prerender = false;
```

```ts title="index.ts", tab="Hono"
import { Hono } from "hono";
import { createExampleFragmentInstance } from "@/lib/example-fragment-server";

const app = new Hono();
app.all("/api/example-fragment/*", (c) => createExampleFragmentInstance().handler(c.req.raw));
```
