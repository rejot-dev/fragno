# Backoffice runtime object abstraction plan

## Context

Backoffice currently talks to Durable Objects directly in a few layers:

```ts
await env.AUTOMATIONS.get(env.AUTOMATIONS.idFromName(organization.id)).ingestEvent(...);
```

and route forwarding code does the same:

```ts
const telegramDo = getTelegramDurableObject(context, orgId);
return telegramDo.fetch(proxyRequest);
```

This makes the event-driven system hard to test outside Cloudflare, even though most objects are
mostly Fragno fragments and Fragno already has good in-memory SQLite testing support.

For now, keep existing `*.cloudflare.test.ts` files as Cloudflare tests. The first refactor should
make those tests compatible with the abstraction without changing the test pool. A later step can
add a non-Cloudflare implementation and migrate selected scenarios to normal `*.test.ts` files.

## Goals

1. Put Backoffice Durable Objects behind a domain-level object interface.
2. Keep Cloudflare Durable Objects as the production implementation.
3. Keep current `.cloudflare.test.ts` tests running during the refactor.
4. Make object-to-object communication use the interface, not `env.X.get(env.X.idFromName(...))`.
5. Include database adapter creation in the abstraction so non-Cloudflare implementations can swap
   out `DurableObjectDialect`/`CloudflareDurableObjectsDriverConfig` for in-memory or other SQL
   adapters.
6. Preserve the current Cloudflare runtime behavior: RPC methods, `fetch`, alarms, durable hook
   repositories, and route forwarding.

## Non-goals for the first pass

- Do not rename all `.cloudflare.test.ts` files yet.
- Do not remove Cloudflare DO classes.
- Do not implement the full in-memory object backend yet.
- Do not replace every route-backed runtime with direct service calls; `fetch` compatibility should
  remain part of the object contracts.

## Proposed modules

```txt
apps/backoffice/app/backoffice-runtime/
  object-contracts.ts
  object-registry.ts
  database-adapters.ts
  cloudflare-registry.ts
  cloudflare-database-adapters.ts
  test-registry.ts            # later; can start with test helpers only
  in-memory-registry.ts       # later
```

Name bikeshed: `backoffice-runtime` is preferred over `durable-objects` because the point is to make
Cloudflare Durable Objects one runtime implementation, not the domain concept.

## Object contracts

Use object contracts that match what Backoffice needs, not Cloudflare namespace/stub types.

```ts
// apps/backoffice/app/backoffice-runtime/object-contracts.ts

export type FetchObject = {
  fetch(request: Request): Promise<Response>;
};

export type AlarmableObject = {
  alarm?(): Promise<void>;
};

export type DurableHookObject<TRepository = unknown> = {
  getDurableHookRepository?(...args: never[]): TRepository;
};

export type SingletonObject<TObject> = {
  get(): TObject;
};

export type OrgScopedObjects<TObject> = {
  forOrg(orgId: string): TObject;
};

export type NamedObjects<TObject> = {
  forName(name: string): TObject;
};
```

Specific object contracts should be structural and imported from the existing domain types where
possible:

```ts
import type { Organization } from "@/fragno/auth/auth";
import type { AutomationEvent, AutomationIngestResult } from "@/fragno/automation";
import type { TelegramAutomationFileMetadata } from "@/fragno/runtime-tools/families/telegram-runtime";

export type AuthObject = FetchObject &
  AlarmableObject & {
    getAllOrganizations(): Promise<Organization[]>;
  };

export type AutomationsObject = FetchObject &
  AlarmableObject & {
    triggerIngestEvent(event: AutomationEvent): Promise<AutomationIngestResult>;
    ingestEvent(event: AutomationEvent): Promise<AutomationIngestResult>;
  };

export type TelegramObject = FetchObject &
  AlarmableObject & {
    getAutomationFile(input: { fileId: string }): Promise<TelegramAutomationFileMetadata>;
    downloadAutomationFile(input: { fileId: string }): Promise<Response>;
    getAdminConfig(): Promise<unknown>;
    resetAdminConfig(): Promise<unknown>;
    setAdminConfig(payload: unknown, origin: string): Promise<unknown>;
  };

export type OtpObject = FetchObject &
  AlarmableObject & {
    issueIdentityClaim(input: {
      orgId: string;
      actor: unknown;
      expiresInMinutes?: number;
      publicBaseUrl: string;
    }): Promise<unknown>;
  };

export type PiObject = FetchObject & AlarmableObject;
export type ResendObject = FetchObject & AlarmableObject;
export type Reson8Object = FetchObject;
export type McpObject = FetchObject;
export type UploadObject = FetchObject & AlarmableObject;
export type GitHubObject = FetchObject & AlarmableObject;
export type CloudflareWorkersObject = FetchObject & AlarmableObject;

export type GitHubWebhookRouterObject = {
  getAdminConfig(orgId: string, origin: string): Promise<unknown>;
  createInstallStatefulUrl(userId: string, orgId: string): Promise<unknown>;
  consumeInstallState(input: unknown): Promise<unknown>;
  getInstallationOrg(installationId: string): Promise<string | null>;
  clearInstallationRouting(installationId: string): Promise<unknown>;
  getWebhookRouterSnapshot(): Promise<unknown>;
};
```

Tighten the `unknown` return types incrementally while migrating each route/data module. The first
pass should prioritize call sites that currently reach into `env.*` directly.

## Object registry

```ts
// apps/backoffice/app/backoffice-runtime/object-registry.ts

import type {
  AuthObject,
  AutomationsObject,
  CloudflareWorkersObject,
  GitHubObject,
  GitHubWebhookRouterObject,
  McpObject,
  OtpObject,
  PiObject,
  ResendObject,
  Reson8Object,
  TelegramObject,
  UploadObject,
  SingletonObject,
  OrgScopedObjects,
  NamedObjects,
} from "./object-contracts";

export type BackofficeObjectRegistry = {
  auth: SingletonObject<AuthObject>;

  automations: OrgScopedObjects<AutomationsObject>;
  telegram: OrgScopedObjects<TelegramObject>;
  otp: OrgScopedObjects<OtpObject>;
  pi: OrgScopedObjects<PiObject>;
  resend: OrgScopedObjects<ResendObject>;
  reson8: OrgScopedObjects<Reson8Object>;
  mcp: OrgScopedObjects<McpObject>;
  upload: OrgScopedObjects<UploadObject>;
  github: OrgScopedObjects<GitHubObject>;
  cloudflareWorkers: OrgScopedObjects<CloudflareWorkersObject>;

  githubWebhookRouter: SingletonObject<GitHubWebhookRouterObject>;

  sandboxRegistry: OrgScopedObjects<unknown>;
  sandbox: NamedObjects<unknown>;
};
```

Use `BackofficeObjectRegistry` everywhere that currently needs object routing.

## Database adapter abstraction

Today most fragment servers create a Cloudflare Durable Object SQL adapter inline:

```ts
export function createAdapter(state?: DurableObjectState) {
  const dialect = new DurableObjectDialect({
    ctx: state!,
  });

  return new SqlAdapter({
    dialect,
    driverConfig: new CloudflareDurableObjectsDriverConfig(),
  });
}
```

This must move behind the runtime implementation too. Otherwise an in-memory object backend would
still need a fake `DurableObjectState` just to create fragments.

### Types

```ts
// apps/backoffice/app/backoffice-runtime/database-adapters.ts

import type { SqlAdapter } from "@fragno-dev/db/adapters/sql";

export type BackofficeDatabaseAdapterKind =
  | "auth"
  | "automations"
  | "cloudflareWorkers"
  | "github"
  | "mcp"
  | "otp"
  | "pi"
  | "resend"
  | "reson8"
  | "telegram"
  | "upload"
  | "workflows";

export type CreateBackofficeDatabaseAdapterInput = {
  kind: BackofficeDatabaseAdapterKind;
  /** Present for org-scoped objects. Omitted for singleton/global objects. */
  orgId?: string;
  /** Present only in the Cloudflare Durable Object implementation. */
  durableObjectState?: DurableObjectState;
  /** Optional logical database name when one runtime creates multiple fragments. */
  databaseName?: string;
};

export type BackofficeDatabaseAdapterFactory = {
  createAdapter(input: CreateBackofficeDatabaseAdapterInput): SqlAdapter;
};
```

If the precise adapter return type is not `SqlAdapter` everywhere, use the common adapter interface
expected by Fragno fragment options instead:

```ts
type BackofficeDatabaseAdapter = Parameters<typeof createTelegramFragment>[1]["databaseAdapter"];
```

but prefer exporting the actual common database adapter type from `@fragno-dev/db` if available.

### Cloudflare implementation

```ts
// apps/backoffice/app/backoffice-runtime/cloudflare-database-adapters.ts

import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";

import type {
  BackofficeDatabaseAdapterFactory,
  CreateBackofficeDatabaseAdapterInput,
} from "./database-adapters";

export const cloudflareDatabaseAdapters = (): BackofficeDatabaseAdapterFactory => ({
  createAdapter(input: CreateBackofficeDatabaseAdapterInput) {
    if (!input.durableObjectState) {
      throw new Error(`Cloudflare database adapter for ${input.kind} requires DurableObjectState`);
    }

    return new SqlAdapter({
      dialect: new DurableObjectDialect({ ctx: input.durableObjectState }),
      driverConfig: new CloudflareDurableObjectsDriverConfig(),
    });
  },
});
```

### In-memory implementation later

```ts
export const createInMemoryDatabaseAdapters = (): BackofficeDatabaseAdapterFactory => ({
  createAdapter(input) {
    return createFragnoInMemorySqliteAdapter({
      namespace: [input.kind, input.orgId, input.databaseName].filter(Boolean).join(":"),
    });
  },
});
```

The exact helper depends on the existing Fragno test adapter APIs. The important bit is that
fragment server creation receives an adapter factory rather than a Cloudflare state.

## Fragment server factory changes

Change fragment modules from `state`-based adapter construction to adapter-factory based
construction.

### Telegram before

```ts
export function createTelegramServer(
  config: TelegramConfig,
  state: DurableObjectState,
  options: TelegramServerOptions = {},
) {
  return createTelegramFragment(telegramConfig, {
    databaseAdapter: createAdapter(state),
    mountRoute: "/api/telegram",
  });
}
```

### Telegram after

```ts
export type BackofficeFragmentRuntimeOptions = {
  adapters: BackofficeDatabaseAdapterFactory;
  orgId?: string;
  durableObjectState?: DurableObjectState;
};

export function createTelegramServer(
  config: TelegramConfig,
  runtime: BackofficeFragmentRuntimeOptions,
  options: TelegramServerOptions = {},
) {
  return createTelegramFragment(telegramConfig, {
    databaseAdapter: runtime.adapters.createAdapter({
      kind: "telegram",
      orgId: runtime.orgId,
      durableObjectState: runtime.durableObjectState,
    }),
    mountRoute: "/api/telegram",
  });
}
```

This pattern applies to:

- `app/fragno/auth/auth.ts`
- `app/fragno/cloudflare.ts`
- `app/fragno/github.ts`
- `app/fragno/mcp.ts`
- `app/fragno/otp.ts`
- `app/fragno/resend.ts`
- `app/fragno/reson8.ts` if/when it gets persistence
- `app/fragno/telegram.ts`
- `app/fragno/upload-server.ts`
- `app/fragno/automation/automations.ts`
- `app/fragno/pi/pi.ts`

For runtimes with multiple fragments sharing one database adapter today, create once and reuse:

```ts
const databaseAdapter = runtime.adapters.createAdapter({
  kind: "automations",
  orgId,
  durableObjectState,
});

const workflowsFragment = createWorkflowsFragment(..., { databaseAdapter, ... });
const automationFragment = createAutomationFragment(..., { databaseAdapter, ... });
```

Keep sharing semantics explicit. Do not accidentally create two separate in-memory databases for
fragments that currently share a Durable Object SQL database.

## Cloudflare object registry implementation

```ts
// apps/backoffice/app/backoffice-runtime/cloudflare-registry.ts

import {
  AUTH_SINGLETON_ID,
  GITHUB_WEBHOOK_ROUTER_SINGLETON_ID,
} from "@/cloudflare/cloudflare-utils";
import type { BackofficeObjectRegistry } from "./object-registry";

const orgScoped = <TObject>(namespace: DurableObjectNamespace<TObject>) => ({
  forOrg(orgId: string): TObject {
    return namespace.get(namespace.idFromName(orgId)) as TObject;
  },
});

const singleton = <TObject>(namespace: DurableObjectNamespace<TObject>, name: string) => ({
  get(): TObject {
    return namespace.get(namespace.idFromName(name)) as TObject;
  },
});

export const createCloudflareBackofficeObjectRegistry = (
  env: CloudflareEnv,
): BackofficeObjectRegistry => ({
  auth: singleton(env.AUTH, AUTH_SINGLETON_ID),

  automations: orgScoped(env.AUTOMATIONS),
  telegram: orgScoped(env.TELEGRAM),
  otp: orgScoped(env.OTP),
  pi: orgScoped(env.PI),
  resend: orgScoped(env.RESEND),
  reson8: orgScoped(env.RESON8),
  mcp: orgScoped(env.MCP),
  upload: orgScoped(env.UPLOAD),
  github: orgScoped(env.GITHUB),
  cloudflareWorkers: orgScoped(env.CLOUDFLARE_WORKERS),

  githubWebhookRouter: singleton(env.GITHUB_WEBHOOK_ROUTER, GITHUB_WEBHOOK_ROUTER_SINGLETON_ID),

  sandboxRegistry: {
    forOrg(orgId) {
      return env.SANDBOX_REGISTRY.get(
        env.SANDBOX_REGISTRY.idFromName(`SANDBOX_REGISTRY_ORG:${orgId}`),
      );
    },
  },

  sandbox: {
    forName(name) {
      return env.SANDBOX.get(env.SANDBOX.idFromName(name));
    },
  },
});
```

## Runtime context

Extend the existing Cloudflare context value instead of replacing it immediately:

```ts
// app/cloudflare/cloudflare-context.ts

type CloudflareContextValue = {
  env: CloudflareEnv;
  ctx: ExecutionContext;
  objects: BackofficeObjectRegistry;
  adapters: BackofficeDatabaseAdapterFactory;
};
```

In `workers/app.ts`:

```ts
context.set(CloudflareContext, {
  env,
  ctx,
  objects: createCloudflareBackofficeObjectRegistry(env),
  adapters: cloudflareDatabaseAdapters(),
});
```

The name `CloudflareContext` can remain for compatibility in the first pass. Later, rename to
`BackofficeRuntimeContext` if desired.

## Compatibility helpers

Keep current helper names to minimize churn:

```ts
export function getTelegramDurableObject(context, orgId: string): TelegramObject {
  return context.get(CloudflareContext).objects.telegram.forOrg(orgId);
}

export function getAutomationsDurableObject(context, orgId: string): AutomationsObject {
  return context.get(CloudflareContext).objects.automations.forOrg(orgId);
}
```

Then add new names and migrate gradually:

```ts
export const getTelegramObject = getTelegramDurableObject;
export const getAutomationsObject = getAutomationsDurableObject;
```

This keeps route modules and `.cloudflare.test.ts` files compatible while moving all internals to
the registry.

## Object-to-object communication

Durable Object classes should stop reaching into `env.X.get(...)` directly. In Cloudflare DO
constructors, create a Cloudflare registry from `env` and pass it to runtime creation.

### Telegram before

```ts
const automationsDo = this.#env.AUTOMATIONS.get(this.#env.AUTOMATIONS.idFromName(orgId));
await automationsDo.triggerIngestEvent(buildTelegramAutomationEvent(orgId, payload));
```

### Telegram after

```ts
const objects = createCloudflareBackofficeObjectRegistry(this.#env);
await objects.automations
  .forOrg(orgId)
  .triggerIngestEvent(buildTelegramAutomationEvent(orgId, payload));
```

For testability, prefer passing `objects` into lower-level runtime factories rather than recreating
from `env` deep in helpers.

## Route-backed runtimes

Any runtime currently accepting only `env` should accept either a registry or a combined runtime
object.

```ts
export type BackofficeRuntimeServices = {
  env: CloudflareEnv;
  objects: BackofficeObjectRegistry;
  adapters: BackofficeDatabaseAdapterFactory;
};
```

Example `createEventRuntime`:

```ts
export type CreateEventRuntimeOptions = {
  objects?: BackofficeObjectRegistry;
  event: AutomationEvent;
};

export const createEventRuntime = ({ objects, event }: CreateEventRuntimeOptions): EventRuntime => ({
  emitEvent: async (...) => {
    if (!objects) {
      throw new Error("event.emit is not configured");
    }

    const orgId = event.orgId?.trim();
    if (!orgId) {
      throw new Error("event.emit requires an organisation id");
    }

    await objects.automations.forOrg(orgId).triggerIngestEvent(nextEvent);
    return buildIngestResult(nextEvent);
  },
});
```

For transition compatibility, support `env` temporarily:

```ts
type CreateEventRuntimeOptions = {
  env?: CloudflareEnv;
  objects?: BackofficeObjectRegistry;
  event: AutomationEvent;
};

const objects =
  options.objects ??
  (options.env ? createCloudflareBackofficeObjectRegistry(options.env) : undefined);
```

Remove the fallback once all call sites pass `objects`.

## API route forwarding

`apps/backoffice/app/routes/api/telegram.ts` should depend on the object contract:

```ts
const telegram = getTelegramObject(context, orgId);
return telegram.fetch(proxyRequest);
```

This keeps the route behavior identical in Cloudflare tests while making it possible for
non-Cloudflare tests to provide an object with `fetch`.

## Test plan for the refactor

Keep all existing `*.cloudflare.test.ts` files as-is in name and pool.

During the refactor:

1. Update Cloudflare test setup to populate `CloudflareContext` with:
   - `env`
   - `ctx`
   - `objects: createCloudflareBackofficeObjectRegistry(env)`
   - `adapters: cloudflareDatabaseAdapters()`
2. Existing tests that mock `env.AUTOMATIONS.get` can continue temporarily, because the Cloudflare
   registry delegates to `env`.
3. New/updated tests should prefer mocking `objects.automations.forOrg(...)` or constructing a test
   registry.
4. Add a small compatibility test for the registry itself:

```ts
it("routes org scoped objects through Cloudflare namespaces", () => {
  const env = createMockEnv();
  const objects = createCloudflareBackofficeObjectRegistry(env);

  objects.automations.forOrg("org-1");

  expect(env.AUTOMATIONS.idFromName).toHaveBeenCalledWith("org-1");
  expect(env.AUTOMATIONS.get).toHaveBeenCalled();
});
```

5. Keep the slow end-to-end Cloudflare tests until the in-memory registry exists and has parity for
   the event-driven scenarios.

## Later: in-memory object registry

The future implementation should expose the same `BackofficeObjectRegistry` but build objects from
Fragno fragments with in-memory SQLite adapters.

```ts
export type InMemoryBackofficeRuntime = {
  objects: BackofficeObjectRegistry;
  adapters: BackofficeDatabaseAdapterFactory;
  drain(): Promise<void>;
  cleanup(): Promise<void>;
  getOrg(orgId: string): {
    automations: AutomationsObject;
    telegram: TelegramObject;
    pi: PiObject;
  };
};
```

Important behavior:

- Org-scoped objects must be cached by `kind:orgId` to match Durable Object identity.
- Objects that currently share one Durable Object SQL database must share one in-memory
  adapter/database.
- `fetch` must remain supported because route-backed runtimes use `createRouteCaller`.
- Hooks like Telegram `onMessageReceived` should call
  `objects.automations.forOrg(orgId).triggerIngestEvent(...)`, not a test mock.
- Durable hook draining should be explicit via `drain()`.

## Suggested implementation order

1. Add `database-adapters.ts` and Cloudflare adapter factory.
2. Update one low-risk fragment server (`telegram` or `resend`) to receive
   `BackofficeFragmentRuntimeOptions` and use `adapters.createAdapter(...)`.
3. Add object contract and Cloudflare registry types.
4. Add `objects` and `adapters` to `CloudflareContext` in `workers/app.ts`.
5. Change `cloudflare-utils.ts` helpers to read from `objects`, while preserving exported helper
   names.
6. Convert route-backed runtimes and direct env call sites one family at a time:
   - `event-runtime.ts`
   - `telegram-runtime.ts`
   - `otp-runtime.ts`
   - `pi-runtime.ts`
   - automation route callers
   - `create-file-system.ts`
7. Convert DO-to-DO calls inside worker classes:
   - `telegram.do.ts`
   - `auth.do.ts`
   - any outbox dispatchers calling other DOs
8. Update all `*.cloudflare.test.ts` setup/mocks to remain compatible.
9. Only after parity, introduce `in-memory-registry.ts` and start moving selected scenarios to
   normal tests.

## Acceptance criteria for first pass

- Existing `.cloudflare.test.ts` files still run under the Cloudflare runtime.
- App/routes/runtime code no longer call `env.X.get(env.X.idFromName(...))` directly except inside
  `cloudflare-registry.ts` and temporary migration shims.
- Fragment server factories no longer construct `DurableObjectDialect` directly except inside
  `cloudflare-database-adapters.ts` and temporary migration shims.
- Object-to-object communication goes through `BackofficeObjectRegistry`.
- The public behavior of `/api/telegram/:orgId/*` forwarding is unchanged.
- Adapter creation has enough context (`kind`, `orgId`, `databaseName`, `durableObjectState`) for
  both Cloudflare DO SQLite and future in-memory SQLite implementations.
