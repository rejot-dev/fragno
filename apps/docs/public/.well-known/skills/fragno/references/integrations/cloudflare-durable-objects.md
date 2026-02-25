# Cloudflare Durable Objects

Deploy a database-enabled Fragment inside a Cloudflare Durable Object. The Fragment gets its own
embedded SQLite database with zero external dependencies. This pattern works for any Fragment that
uses `@fragno-dev/db`.

## Database Adapter

Use `DurableObjectDialect` + `CloudflareDurableObjectsDriverConfig`:

```ts
import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";

function createAdapter(state?: DurableObjectState) {
  return new SqlAdapter({
    dialect: new DurableObjectDialect({ ctx: state! }),
    driverConfig: new CloudflareDurableObjectsDriverConfig(),
  });
}
```

`state` is only `undefined` for the dry-run export used by the Fragno CLI.

## Init Union Pattern

The fragment factory needs to work in two contexts: inside a real DO ("live") and for CLI schema
generation ("dry-run"). Use a discriminated union:

```ts
export type FragmentInit =
  | { type: "dry-run" }
  | { type: "live"; env: CloudflareEnv; state: DurableObjectState };

export function createMyFragmentServer(init: FragmentInit) {
  return createMyFragment(
    {
      /* fragment-specific config */
    },
    { databaseAdapter: createAdapter(init.type === "live" ? init.state : undefined) },
  );
}

// Top-level dry-run export so the Fragno CLI can discover the schema
export const fragment = createMyFragmentServer({ type: "dry-run" });
```

## Durable Object Class

The DO class creates the fragment in the constructor, runs migrations in `blockConcurrencyWhile`,
and delegates `fetch` to the fragment handler:

```ts
import { DurableObject } from "cloudflare:workers";
import { createMyFragmentServer } from "./fragno/my-fragment";
import { migrate } from "@fragno-dev/db";

export class MyFragment extends DurableObject<CloudflareEnv> {
  #fragment: ReturnType<typeof createMyFragmentServer>;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);

    this.#fragment = createMyFragmentServer({
      env,
      state,
      type: "live",
    });

    state.blockConcurrencyWhile(async () => {
      try {
        await migrate(this.#fragment);
      } catch (error) {
        console.log("Migration failed", { error });
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    return this.#fragment.handler(request);
  }
}
```

Key rules:

- Fragment is created once in the constructor, stored as a private field.
- `migrate()` runs inside `blockConcurrencyWhile` so schema is ready before first request.
- `fetch` delegates directly to the fragment's built-in HTTP handler.

## Wrangler Configuration

Add a DO binding and a SQLite migration entry:

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "MY_FRAGMENT", "class_name": "MyFragment" }],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MyFragment"] }],
}
```

- `new_sqlite_classes` provisions SQLite storage for the class.
- Increment `tag` when adding new DO classes.

## Routing to the Durable Object

### Hono

```ts
const app = new Hono<{ Bindings: CloudflareEnv }>().all("/api/my-fragment/*", (c) => {
  const stub = c.env.MY_FRAGMENT.get(c.env.MY_FRAGMENT.idFromName("default"));
  return stub.fetch(c.req.raw);
});
```

### Plain Worker fetch handler

```ts
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/my-fragment/")) {
      const stub = env.MY_FRAGMENT.get(env.MY_FRAGMENT.idFromName("default"));
      return stub.fetch(request);
    }
    // ...
  },
} satisfies ExportedHandler<CloudflareEnv>;
```

### React Router v7

```ts
export async function loader({ request, context }: Route.LoaderArgs) {
  const stub = context.env.MY_FRAGMENT.get(context.env.MY_FRAGMENT.idFromName("default"));
  return stub.fetch(request);
}

export async function action({ request, context }: Route.ActionArgs) {
  const stub = context.env.MY_FRAGMENT.get(context.env.MY_FRAGMENT.idFromName("default"));
  return stub.fetch(request);
}
```

## Instance Isolation

- `idFromName("default")` → single global instance (most common for fragments).
- `idFromName(tenantId)` → per-tenant isolation, each tenant gets its own DO with its own SQLite DB.
- `idFromName(userId)` → per-user isolation.

## Multiple Fragment DOs

Mount each fragment on its own route with its own binding:

```ts
const app = new Hono<{ Bindings: CloudflareEnv }>()
  .all("/api/forms/*", (c) => {
    const stub = c.env.FORMS.get(c.env.FORMS.idFromName("default"));
    return stub.fetch(c.req.raw);
  })
  .all("/api/mailing-list/*", (c) => {
    const stub = c.env.MAILING_LIST.get(c.env.MAILING_LIST.idFromName("default"));
    return stub.fetch(c.req.raw);
  });
```

Each DO class needs its own entry in `durable_objects.bindings` and `migrations`.
