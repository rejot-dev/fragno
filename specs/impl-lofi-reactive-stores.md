# Implementation plan: Lofi reactive query stores

## Goal

Add first-class infrastructure to `@fragno-dev/lofi` for turning local Lofi queries into
Nanostores-powered reactive stores.

The intended app flow is:

```txt
LofiClient polls one or more outbox URLs
        ↓
adapter applies outbox mutations to IndexedDB
        ↓
runtime publishes an invalidation/revision event
        ↓
query stores re-run against the local query engine
        ↓
Nanostore subscribers update UI automatically
```

This removes per-route hand-written React state like `sync -> query -> setState`, and matches Fragno
core's client-side Nanostores style.

## Requirements

- Use `nanostores` as the reactive primitive.
- Keep querying based on the existing Lofi query engine:
  `adapter.createQueryEngine(schema).find(...)`.
- Initialize `LofiClient` in generic app/domain infrastructure, not inside every page component.
- Query stores must update when outbox polling applies new entries.
- Support multiple outbox URLs, especially org-scoped URLs such as:
  - `/api/automations/:orgId/bindings/_internal/outbox`
  - future upload fragment outboxes per org
- Avoid optimistic updates for the first version.
- Prefer coarse invalidation first; table-level invalidation can come later.

## Current state

`@fragno-dev/lofi` already has:

- `LofiClient` for polling one outbox URL.
- `IndexedDbAdapter` for applying outbox mutations and querying local IndexedDB.
- `createQueryEngine(schema)` with `find`, `findFirst`, and `findWithCursor`.
- `LofiClientOptions.onSyncApplied`, which can be used as the invalidation hook.

Missing pieces:

- Shared runtime ownership for `LofiClient` + adapter lifecycle.
- Nanostore state for sync status.
- Nanostore query stores that re-run on sync.
- Registry/pool helpers for org-scoped and fragment-scoped runtimes.
- Scenario-test support for constructing reactive stores, observing their emissions, and asserting
  multi-outbox behavior end-to-end.

## Proposed public API

### `createLofiRuntime`

Add a runtime object that owns a Lofi adapter and one or more sync sources.

```ts
import { createLofiRuntime, IndexedDbAdapter } from "@fragno-dev/lofi";

const runtime = createLofiRuntime({
  endpointName: "automations-bindings",
  adapter: new IndexedDbAdapter({
    dbName: `fragno_lofi_backoffice_automations_${orgId}`,
    endpointName: "automations-bindings",
    schemas: [{ schema: automationFragmentSchema }],
  }),
  sources: [
    {
      id: orgId,
      outboxUrl: `/api/automations/${encodeURIComponent(orgId)}/bindings/_internal/outbox`,
    },
  ],
  pollIntervalMs: 1000,
});
```

Runtime exposes:

```ts
type LofiRuntime = {
  adapter: LofiAdapter & LofiQueryableAdapter;
  endpointName: string;

  $status: ReadableAtom<LofiRuntimeStatus>;
  $revision: ReadableAtom<number>;

  start(): void;
  stop(): void;
  syncOnce(sourceId?: string): Promise<LofiRuntimeSyncResult>;
  refresh(): void;

  addSource(source: LofiRuntimeSource): void;
  removeSource(sourceId: string): void;
};
```

`$revision` increments whenever any source applies at least one outbox entry.

### `createLofiQueryStore`

Add a Nanostore query helper.

```ts
const $kvRows = createLofiQueryStore(runtime, automationFragmentSchema, "kv_store", (b) =>
  b.whereIndex("primary"),
);
```

With mapping and initial data:

```ts
const $storeEntries = createLofiQueryStore(
  runtime,
  automationFragmentSchema,
  "kv_store",
  (b) => b.whereIndex("primary"),
  {
    initialData: initialEntries,
    map: normalizeLofiStoreEntries,
  },
);
```

Store state:

```ts
type LofiQueryState<TData> = {
  data: TData;
  loading: boolean;
  error: unknown | null;
  synced: boolean;
  updatedAt?: number;
};
```

The query store re-runs when:

- it is first mounted;
- `runtime.$revision` changes;
- `runtime.refresh()` is called;
- its explicit parameters store changes, if provided later.

### `createLofiRuntimeRegistry`

Add a registry for dynamic scopes such as `{ fragment, orgId }`.

```ts
const automationsLofi = createLofiRuntimeRegistry({
  getKey: ({ orgId }: { orgId: string }) => orgId,
  createRuntime: ({ orgId }) =>
    createLofiRuntime({
      endpointName: "automations-bindings",
      adapter: new IndexedDbAdapter({
        dbName: `fragno_lofi_backoffice_automations_${orgId}`,
        endpointName: "automations-bindings",
        schemas: [{ schema: automationFragmentSchema }],
      }),
      sources: [
        {
          id: orgId,
          outboxUrl: `/api/automations/${encodeURIComponent(orgId)}/bindings/_internal/outbox`,
        },
      ],
    }),
});

const runtime = automationsLofi.get({ orgId });
```

For multiple fragments later:

```ts
const backofficeLofi = createLofiRuntimeRegistry({
  getKey: ({ fragment, orgId }) => `${fragment}:${orgId}`,
  createRuntime: ({ fragment, orgId }) => {
    if (fragment === "automations") return createAutomationsLofiRuntime(orgId);
    if (fragment === "uploads") return createUploadsLofiRuntime(orgId);
    throw new Error(`Unknown Lofi fragment: ${fragment}`);
  },
});
```

## Multiple outbox URL support

### First version: one runtime per scoped outbox

The safest first implementation is one runtime per `{ endpointName, orgId }` or
`{ fragment, orgId }`.

Benefits:

- No IndexedDB key migration required.
- No cross-org row collisions.
- Existing adapter row key `[endpoint, schema, table, id]` remains valid.
- Existing cursor behavior remains valid if each runtime uses a scope-specific `cursorKey` or
  isolated `dbName`.

For this version, `createLofiRuntimeRegistry` is the main multi-outbox primitive. Each org gets its
own runtime and usually its own `dbName`.

### Runtime-level multiple sources

`createLofiRuntime` should still accept `sources: LofiRuntimeSource[]` so the runtime model is ready
for multiple outbox URLs.

Each source must have:

```ts
type LofiRuntimeSource = {
  id: string;
  outboxUrl: string;
  cursorKey?: string;
  pollIntervalMs?: number;
};
```

If multiple sources are used with a single adapter, the runtime must give each source a unique
`cursorKey`, defaulting to:

```ts
`${endpointName}:${source.id}:outbox`;
```

Important limitation for v1: multiple sources in one adapter are only safe when their row external
IDs cannot collide. For org-scoped app data, prefer one adapter/database per org until the adapter
supports source partitioning.

### Later: source-partitioned adapter storage

If we want one IndexedDB database to mirror multiple orgs for the same fragment, `IndexedDbAdapter`
needs source partitioning.

That means changing the local row key from:

```ts
[endpoint, schema, table, id];
```

to:

```ts
[endpoint, sourceId, schema, table, id];
```

and adding query support for source scoping:

```ts
adapter.createQueryEngine(schema, { sourceId: orgId });
```

This is a larger internal migration and should not block the reactive store layer.

## Lifecycle

Support both explicit and subscriber-driven lifecycle.

### Explicit app-level lifecycle

```ts
runtime.start();
```

Useful from app roots/layouts.

### Retained lifecycle

Query stores can retain the runtime while mounted:

```ts
onMount($queryStore, () => runtime.retain());
```

Runtime starts on first retain and stops when retain count returns to zero, unless `keepAlive: true`
is configured.

Suggested runtime options:

```ts
type LofiRuntimeOptions = {
  keepAlive?: boolean;
  autoStart?: boolean;
};
```

## Initial Backoffice usage

Replace `apps/backoffice/app/routes/backoffice/automations/lofi-store.tsx` custom React state with:

```ts
const runtime = automationsLofi.get({ orgId });

const $entries = createLofiQueryStore(
  runtime,
  automationFragmentSchema,
  "kv_store",
  (b) => b.whereIndex("primary"),
  {
    initialData: initialEntries,
    map: normalizeLofiStoreEntries,
  },
);

const $filteredEntries = computed($entries, (state) => ({
  ...state,
  data: state.data.filter((entry) => !prefix || entry.key.startsWith(prefix)),
}));
```

React route usage can then rely on Nanostores React integration:

```ts
const state = useStore($filteredEntries);
```

## Package changes

Add files:

```txt
packages/lofi/src/reactive/runtime.ts
packages/lofi/src/reactive/query-store.ts
packages/lofi/src/reactive/registry.ts
packages/lofi/src/reactive/index.ts
packages/lofi/src/reactive/runtime.test.ts
packages/lofi/src/reactive/query-store.test.ts
packages/lofi/src/reactive/registry.test.ts
```

Update exports:

```ts
// packages/lofi/src/mod.ts
export { createLofiRuntime, createLofiRuntimeRegistry, createLofiQueryStore } from "./reactive";
export type { LofiRuntime, LofiRuntimeSource, LofiRuntimeStatus, LofiQueryState } from "./reactive";
```

Add dependency:

```json
"nanostores": "catalog:"
```

If package catalog constraints make that awkward, use the same Nanostores version already used by
`@fragno-dev/core`.

## Scenario tester updates

The existing Lofi scenario runner should become the primary end-to-end harness for reactive stores.
It already constructs Fragno fragments, DB adapters, Lofi clients, submit clients, and query
engines. Extend it so tests can construct Nanostore query stores and assert their values without a
browser.

### Multi-outbox scenario config

Extend `ScenarioServerConfig` and/or `ScenarioClientConfig` to support named outbox sources.

```ts
type ScenarioOutboxSourceConfig = {
  id: string;
  outboxUrl?: string;
  cursorKey?: string;
  mountRoute?: string;
};

type ScenarioClientConfig = {
  endpointName: string;
  adapter?: ScenarioClientAdapterConfig;
  sources?: ScenarioOutboxSourceConfig[];
};
```

Default behavior remains unchanged: if `sources` is omitted, the runner creates one source against
`${baseUrl}/_internal/outbox`.

For org-scoped tests, allow each source to point at a different route or query-param scoped route,
for example:

```ts
clients: {
  orgA: {
    endpointName: "automations-bindings",
    sources: [
      {
        id: "org-a",
        outboxUrl: `${baseUrl}/api/automations/org-a/bindings/_internal/outbox`,
      },
    ],
  },
  orgB: {
    endpointName: "automations-bindings",
    sources: [
      {
        id: "org-b",
        outboxUrl: `${baseUrl}/api/automations/org-b/bindings/_internal/outbox`,
      },
    ],
  },
}
```

The scenario runner should construct `createLofiRuntime({ sources })` instead of a raw `LofiClient`
when reactive support is requested.

### Scenario client additions

Extend `ScenarioClient` with runtime and store helpers:

```ts
type ScenarioClient<TSchema extends AnySchema = AnySchema, TCommandContext = unknown> = {
  // existing fields stay
  runtime?: LofiRuntime;
  stores: {
    base?: InMemoryLofiStore;
    overlay?: InMemoryLofiStore;
    reactive?: Record<string, ReadableAtom<LofiQueryState<unknown>>>;
  };
};
```

### Reactive scenario steps

Add steps for constructing, reading, and asserting Nanostore-backed query stores.

```ts
type ScenarioCreateStoreStep = {
  type: "createStore";
  client: string;
  name: string;
  table: string;
  query: (b: LofiFindBuilder<any, any>) => unknown;
  map?: (rows: unknown) => unknown;
  initialData?: unknown;
};

type ScenarioReadStoreStep = {
  type: "readStore";
  client: string;
  name: string;
  storeAs: string;
};

type ScenarioWaitForStoreStep = {
  type: "waitForStore";
  client: string;
  name: string;
  predicate: (state: LofiQueryState<unknown>) => boolean;
  timeoutMs?: number;
};
```

Add convenience builders:

```ts
const steps = createScenarioSteps<typeof appSchema>();

steps.createStore("orgA", "users", "users", (b) => b.whereIndex("primary"));
steps.sync("orgA");
steps.waitForStore("orgA", "users", (state) => Array.isArray(state.data) && state.data.length > 0);
steps.readStore("orgA", "users", "orgAUsers");
steps.assert((ctx) => {
  expect(ctx.vars.orgAUsers).toEqual([expect.objectContaining({ name: "Alice" })]);
});
```

### Store emission assertions

The runner should record store emissions for deterministic assertions:

```ts
type ScenarioStoreProbe = {
  values: LofiQueryState<unknown>[];
  unsubscribe: () => void;
};
```

Expose probes through `ctx.clients[client].storeProbes[name]` or keep them internal and expose
helper steps like:

```ts
steps.assertStoreEmissions("orgA", "users", (values) => {
  expect(values.some((value) => value.loading)).toBe(true);
  expect(values.at(-1)?.data).toHaveLength(1);
});
```

### Required scenario test cases

Add scenario tests that cover:

- [x] A query store emits initial state, loading state, and synced data after `sync`.
- [x] A server mutation followed by `sync` causes the store to emit updated data.
- [ ] Two org-scoped clients with separate outboxes and databases do not leak rows across stores.
- [x] One runtime with multiple sources uses distinct cursor keys and increments one shared
      revision.
- [x] A store can be created before any sync and still updates after the first source applies
      entries.
- [ ] Store subscriptions are cleaned up by `ctx.cleanup()`.

## Implementation steps

- [x] Add `nanostores` dependency to `packages/lofi`.
- [x] Implement `createLofiRuntime` around existing `LofiClient`.
  - [x] Create one internal `LofiClient` per source.
  - [x] Wire each client's `onSyncApplied` to update `$status` and increment `$revision`.
  - [x] Wire each client's `onError` to `$status.lastError`.
- [x] Add runtime source management.
  - [x] `addSource` creates a client if missing.
  - [x] `removeSource` stops and removes the client.
  - [x] Ensure source cursor keys are unique.
- [x] Implement retain/start/stop lifecycle.
- [x] Implement `createLofiQueryStore`.
  - [x] Use `atom` for state.
  - [x] Use `onMount` to run the initial query and subscribe to `runtime.$revision`.
  - [x] Prevent stale async query results from overwriting newer results with a request counter.
- [x] Implement `createLofiRuntimeRegistry`.
  - [x] Cache runtimes by key.
  - [x] Expose `get`, `has`, `delete`, `clear`, and optionally `entries`.
- [x] Extend the Lofi scenario tester.
  - [x] Allow clients to declare multiple outbox sources.
  - [x] Construct `LofiRuntime` for reactive scenarios.
  - [x] Add create/read/wait/assert steps for Nanostore query stores.
  - [x] Record store emissions and clean up subscriptions.
- [x] Add tests.
- [x] Refactor Backoffice Automations store to use the new helpers.
- [ ] Add a small README section and update the React SPA local-first example to show reactive
      stores.

## Test plan

Package tests:

- [x] Query store loads from an adapter on mount.
- [x] Query store updates when runtime revision increments.
- [x] Query store sets `loading`, `error`, `synced`, and `updatedAt` correctly.
- [x] Runtime increments revision only when sync applies entries.
- [x] Runtime can manage multiple sources with distinct cursor keys.
- [x] Registry returns the same runtime for the same org key.
- [x] Registry creates separate runtimes for different org keys.
- [x] Removing a registry runtime stops its clients.
- [x] Scenario runner can construct Nanostore query stores and assert their final state.
- [x] Scenario runner records store emissions across sync steps.
- [x] Scenario runner supports multiple outbox sources with independent cursor keys.
- [ ] Scenario runner supports separate org-scoped clients/outboxes without cross-org leakage.

Backoffice tests/manual checks:

- [x] Automations store page renders SSR entries immediately.
- [x] After outbox sync, page uses Lofi-backed entries.
- [ ] Mutating `/store/set` updates the UI after polling without manual refresh.
- [x] Switching orgs uses a different runtime/database.

## Non-goals for first version

- Optimistic writes.
- Live IndexedDB observers.
- Table-level invalidation.
- Source-partitioned IndexedDB row keys.
- Cross-tab leader election.
- Server push/WebSocket sync.

## Future improvements

- Add changed table metadata to `LofiSyncResult` and invalidate only affected query stores.
- Add source-partitioned IndexedDB storage to safely query multiple orgs in one database.
- Add cross-tab sync coordination so only one tab polls a source.
- Add framework-specific convenience hooks, e.g. React `useLofiQueryStore`, only after the Nanostore
  core API settles.
