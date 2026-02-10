# Fragno Lofi Submit + Conflict Detection — Spec

## 0. Open Questions

None.

## 1. Overview

This spec adds **client → server submit** for local‑first clients using a Wilcofirst‑style sync
loop, extended to support **readful commands** (commands that perform reads before writes). It uses
an **outbox‑mutation log** table rather than per‑row clocks, so we keep MySQL compatibility and
avoid schema changes to user tables.

Key properties:

- Clients submit **commands** plus a **base outbox cursor**. Each command includes a **target**
  `{ fragment, schema }` so the server can resolve the correct namespace.
- The server runs each command in **plan mode** to collect **read scopes** + **read keys** + **write
  keys**, then checks conflicts against **unseen outbox mutations**.
- If no conflict, the server applies a **prefix** of submitted commands in order (atomic per
  handlerTx), and returns unseen outbox entries so the client can **rebase** immediately.
- Commands are **isomorphic** handlerTx units: identical handler code runs on server and in the
  browser. A context object supplies **auth‑scoped query guards** on the server.

Versionstamps are stored as **hex strings** in the database (per current repository behavior), so
all new tables and comparisons use string versionstamps.

## 2. References

- Fragno DB Outbox — Spec: `specs/spec-outbox.md`
- Fragno Lofi — Spec: `specs/spec-lofi.md`
- Wilcofirst reference: `specs/references/wilcofirst.md`
- Outbox builder + ref map: `packages/fragno-db/src/outbox/outbox-builder.ts`
- Outbox types/versionstamp helpers: `packages/fragno-db/src/outbox/outbox.ts`
- Outbox executor integration (SQL):
  `packages/fragno-db/src/adapters/generic-sql/generic-sql-uow-executor.ts`
- Internal fragment schema: `packages/fragno-db/src/fragments/internal-fragment.schema.ts`
- Internal fragment routes: `packages/fragno-db/src/fragments/internal-fragment.routes.ts`
- Adapter registry (internal fragment wiring): `packages/fragno-db/src/internal/adapter-registry.ts`
- UOW operations and find/join builders: `packages/fragno-db/src/query/unit-of-work/unit-of-work.ts`
- UOW execute pipeline: `packages/fragno-db/src/query/unit-of-work/execute-unit-of-work.ts`
- UOW decoding (FragnoId/external id handling):
  `packages/fragno-db/src/adapters/generic-sql/uow-decoder.ts`
- SQL query compiler (left joins):
  `packages/fragno-db/src/adapters/generic-sql/query/sql-query-compiler.ts`
- Select extension utilities: `packages/fragno-db/src/adapters/generic-sql/query/select-builder.ts`
- Lofi query engine (read‑only local queries): `packages/lofi/src/query/engine.ts`
- Lofi IndexedDB adapter (mutation application): `packages/lofi/src/indexeddb/adapter.ts`
- Lofi CLI entrypoint: `packages/lofi/src/cli/index.ts`
- Unplugin route/library transforms: `packages/unplugin-fragno/src/transform-define-route.ts`,
  `packages/unplugin-fragno/src/transform-define-library.ts`

## 3. Terminology

- **Base cursor**: the client’s last applied outbox entry versionstamp (hex string).
- **Entry versionstamp**: outbox row versionstamp (userVersion = 0).
- **Mutation versionstamp**: per‑mutation versionstamp (userVersion = 0..n).
- **Unseen mutations**: mutations with `entryVersionstamp > baseCursor`.
- **Command**: a registered handlerTx‑based unit of work invoked by submit.
- **Command target**: `{ fragment, schema }`, where `fragment` is the fragment definition name and
  `schema` is the logical schema name (`schema.name`). The server maps `schema` to a namespace for
  the given fragment.
- **Command plan**: read keys, read scopes, write keys, and mutation operations produced by a
  command’s handlerTx in plan mode.
- **Read key**: a specific row key (schema/table/externalId) observed by a command’s reads.
- **Read scope**: the _query_ shape (table + index + condition + joins) executed by a command, used
  for phantom detection.
- **Write key**: a specific row key targeted by a command’s mutations.
- **Scope helper**: a context‑supplied function that applies auth constraints to a query builder.
- **Schema name**: the logical schema name (`schema.name`) used by clients.
- **Namespace**: the resolved database namespace for a schema, determined by the server from the
  adapter registry.

## 4. Goals / Non‑goals

### 4.1 Goals

1. Add a **submit** endpoint for local‑first clients with **readful** commands.
2. Detect conflicts efficiently using an **outbox‑mutation log** table, not row‑clocks.
3. Keep full **MySQL compatibility** (no RETURNING requirements).
4. Make commands **isomorphic** so the same handlerTx logic can run in the browser for optimistic
   updates, using a different context for auth/query guards.
5. Return **unseen outbox entries** as part of submit responses to enable immediate rebase.
6. Keep existing outbox payload format stable for current consumers.

### 4.2 Non‑goals

- CRDT/merge semantics.
- Cross‑tab or BroadcastChannel syncing.
- Full optimistic overlay store (tracked separately; this spec focuses on submit + rebase).
- Per‑row clock/version column upgrades (explicitly choosing mutation log instead).

## 5. Architecture & Module Layout

### 5.1 `@fragno-dev/db` (new modules)

Create new sync‑focused modules to keep logic isolated from existing UOW + outbox plumbing:

- `packages/fragno-db/src/sync/`
  - `commands.ts`: command registry + types + defineSyncCommands
  - `plan.ts`: plan execution + read tracking orchestration
  - `read-tracking.ts`: read key + read scope collection helpers
  - `conflict-checker.ts`: conflict detection logic + SQL helpers
  - `submit.ts`: submit handler (server) + orchestration
  - `types.ts`: shared types for submit requests/responses

### 5.2 `@fragno-dev/lofi` (new modules)

- `packages/lofi/src/submit/`
  - `client.ts`: submit helper + command queue persistence
  - `local-handler-tx.ts`: local handlerTx runtime (optimistic execution)
  - `rebase.ts`: apply unseen entries + replay confirmed commands
- `packages/lofi/src/cli/`
  - extend existing CLI with `serve`, `client`, and `scenario` modes
  - `scenario.ts`: DSL runner + helpers

### 5.3 `@fragno-dev/unplugin-fragno`

- Add a transform for `defineSyncCommands` to **preserve handlers** in client builds.
- Ensure command handlers are _not_ replaced with no‑ops like route handlers.

### 5.4 API surface changes

- Add new browser‑safe entrypoint: `@fragno-dev/db/sync` (types + registry only).
- Add new export from `@fragno-dev/db`: `defineSyncCommands` and sync types.
- Extend `ExecuteTxOptions` (handlerTx) to support **read tracking hooks** (see §11).
- Add `withSyncCommands(...)` or equivalent registration hook to tie commands to fragments (see
  §7.4).

### 5.5 Existing files touched (high‑level)

- `packages/fragno-db/src/fragments/internal-fragment.schema.ts`: add new internal table(s).
- `packages/fragno-db/src/fragments/internal-fragment.routes.ts`: add `/sync` route.
- `packages/fragno-db/src/adapters/generic-sql/generic-sql-uow-executor.ts`: emit mutation log rows
  on commit.
- `packages/fragno-db/src/adapters/in-memory/in-memory-uow.ts`: emit mutation log rows for tests.
- `packages/fragno-db/src/query/unit-of-work/execute-unit-of-work.ts`: add read‑tracking callbacks
  in ExecuteTxOptions.
- `packages/fragno-db/src/adapters/generic-sql/query/sql-query-compiler.ts`: extend select when read
  tracking is enabled (force externalId).
- `packages/unplugin-fragno/src/transform-define-library.ts`: ensure new `withSyncCommands` chain is
  safe in client builds.
- `packages/unplugin-fragno/src/transform.ts` / new transform: preserve `defineSyncCommands`
  handlers.
- `packages/fragno/src/mod-client.ts`: add client stub for `withSyncCommands`.
- `packages/fragno-db/package.json`: add `./sync` export.
- `packages/lofi/README.md`: describe submit flow and sync command usage.

## 6. Data Model

### 6.1 Internal table: `fragno_db_outbox_mutations`

Purpose: fast conflict detection without touching user tables.

Columns:

- `id` (external id, `idColumn()`)
- `entryVersionstamp` (`string`, not null) — outbox entry versionstamp (hex)
- `mutationVersionstamp` (`string`, not null) — per‑mutation versionstamp (hex)
- `uowId` (`string`, not null)
- `schema` (`string`, not null) — same value used in outbox payloads (`namespace ?? ""`)
- `table` (`string`, not null)
- `externalId` (`string`, not null)
- `op` (`string`, not null) — `"create" | "update" | "delete"`
- `createdAt` (`timestamp`, not null, default now)

Indexes:

- `idx_outbox_mutations_entry` on `entryVersionstamp`
- `idx_outbox_mutations_key` on `[schema, table, externalId, entryVersionstamp]`
- `idx_outbox_mutations_uow` on `[uowId]`

Notes:

- Versionstamps are **hex strings** (lowercase). String comparison is lexicographic.
- Mutation rows are written **only when outbox is enabled** and for non‑internal tables.
- `schema` uses the same namespace string as the outbox payload (`op.namespace ?? ""`).

### 6.2 Internal table: `fragno_db_sync_requests`

Purpose: idempotency for submit batches (`already_handled`).

Columns:

- `id` (external id, `idColumn()`)
- `requestId` (`string`, not null)
- `status` (`string`, not null) — `"applied" | "conflict"`
- `confirmedCommandIds` (`json`, not null)
- `conflictCommandId` (`string`, nullable)
- `baseVersionstamp` (`string`, nullable)
- `lastVersionstamp` (`string`, nullable)
- `createdAt` (`timestamp`, not null, default now)

Indexes:

- `idx_sync_request_id` on `requestId` (unique)

Rationale:

- Allows replays of identical submit requests without re‑executing commands.
- Response payload can be reconstructed by re‑loading outbox entries from `baseVersionstamp` onward;
  only minimal metadata is stored.

### 6.3 Outbox versionstamp storage

Outbox `versionstamp` columns are stored as **hex strings** in the DB. All new logic should treat
versionstamps as strings, including the new mutation log.

## 7. Sync Commands API (Isomorphic)

### 7.1 Registry + definition

Commands are registered at the fragment level (handlerTx‑based, serviceTx allowed via
`withServiceCalls(...)`). A new helper `defineSyncCommands` lives in a browser‑safe entrypoint
(`@fragno-dev/db/sync`).

Example:

```ts
import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import { defineSyncCommands } from "@fragno-dev/db/sync";
import { schema } from "./schema";

export const syncCommands = defineSyncCommands({ schema }).create(({ defineCommand }) => [
  defineCommand({
    name: "addComment",
    inputSchema,
    context: {
      client: (ctx) => ({ ...ctx, scope: createClientScope(ctx) }),
      server: (ctx) => ({ ...ctx, scope: createServerScope(ctx) }),
    },
    handler: async ({ input, tx, ctx }) => {
      return tx()
        .retrieve(({ forSchema }) =>
          forSchema(schema).find("posts", (b) =>
            ctx.scope.posts(b.whereIndex("primary", (eb) => eb("id", "=", input.postId))),
          ),
        )
        .mutate(({ forSchema }) =>
          forSchema(schema).create("comments", {
            postId: input.postId,
            authorId: ctx.scope.userId,
            body: input.body,
          }),
        )
        .execute();
    },
  }),
]);

export const fragmentDef = defineFragment("comments")
  .extend(withDatabase(schema))
  .withSyncCommands(syncCommands)
  .build();
```

### 7.2 Context separation (auth‑scoped queries)

Commands are **isomorphic**, but the context differs between client and server. The handler must use
**scope helpers** to apply auth rules so the handler body is identical in both environments.

```ts
type SyncCommandContext<TEnv extends "client" | "server", TAuth> = {
  mode: TEnv;
  auth: TAuth; // auth/session data (client vs server)
  scope: {
    // Helpers for query scoping; server can add extra guards
    posts<T>(builder: T): T;
    users<T>(builder: T): T;
  };
};
```

Rules:

- Handlers must be **browser‑safe** (no Node imports, no server‑only globals).
- Server‑only data flows through `context.server(...)`, not through module scope captures.
- All auth restrictions **must** be applied via `scope` helpers so the query shape can be tracked
  consistently for conflict detection.
- HandlerTx and serviceTx must not perform external IO; use hooks for side effects.

### 7.3 ServiceTx allowed inside handlerTx (no direct services)

Sync commands run inside handlerTx and **may call serviceTx** via `withServiceCalls(...)`. Direct
service access is not part of the client API: **handlers are the RPC layer** and the browser should
not be able to invoke services directly.

Implications:

- Service implementations **must be available to the browser bundle**, because sync handlers may
  call them during optimistic execution.
- The unplugin must preserve **service implementation code** while still stripping server‑only route
  handlers and other RPC wiring (see §13).
- If a service uses Node‑only code, browser bundling will fail — this is acceptable and enforces
  browser‑safe serviceTx logic for commands intended to run client‑side.

### 7.4 Registration

Commands must be discoverable by the internal sync route. Registration is done by attaching to the
fragment definition:

- `defineSyncCommands(...)` returns a registry object.
- `withSyncCommands(...)` attaches that registry to the fragment definition.
- `DatabaseFragmentDefinitionBuilder` registers the commands with the adapter registry when the
  fragment is built.
- Registration stores `{ fragmentName, schemaName, namespace }` alongside the command map so the
  server can resolve `{ fragment, schema } → namespace` for submit.

### 7.5 Route reuse

Routes may call sync commands directly so the handler logic is defined once and shared between
standard HTTP handlers and Lofi submit/optimistic execution.

## 8. Submit Endpoint

### 8.1 Route

```
POST /_internal/sync
```

Preflight:

- `GET /_internal` must include `adapterIdentity` so clients can populate submit requests.

### 8.2 Request

```ts
type SubmitRequest = {
  baseVersionstamp?: string; // last applied outbox entry versionstamp (hex)
  requestId: string; // idempotency key for this submit batch
  conflictResolutionStrategy: "server" | "disabled";
  adapterIdentity: string; // required, from GET /_internal
  commands: Array<{
    id: string; // client-local id
    name: string;
    target: {
      fragment: string; // fragment definition name
      schema: string; // logical schema name (schema.name)
    };
    input: unknown;
  }>;
};
```

Resolution rules:

- The server resolves `commands[].target` by `{ fragment, schema }` against the adapter registry.
- The logical `schema` name is mapped to the fragment’s registered **namespace** for execution.
- Unknown fragment/schema combinations are rejected.

### 8.3 Response

```ts
type SubmitResponse =
  | {
      status: "applied";
      requestId: string;
      confirmedCommandIds: string[]; // prefix applied in order
      lastVersionstamp?: string;
      entries: OutboxEntry[]; // unseen entries since base
    }
  | {
      status: "conflict";
      requestId: string;
      confirmedCommandIds: string[]; // prefix applied in order (may be empty)
      conflictCommandId?: string; // first failing command
      lastVersionstamp?: string;
      entries: OutboxEntry[]; // unseen entries since base
      reason:
        | "conflict"
        | "write_congestion"
        | "client_far_behind"
        | "no_commands"
        | "already_handled"
        | "limit_exceeded";
    };
```

Semantics:

- Commands are processed **in order**.
- The server applies a **prefix**; later commands are ignored once a conflict is detected.
- Atomicity is per command (handlerTx). The prefix either fully applies or fails for each command.
- `already_handled` responses are served from `fragno_db_sync_requests` metadata.
- `conflictResolutionStrategy = "disabled"` skips conflict checks but still respects OCC/version
  checks; failures are reported as `write_congestion`.
- `client_far_behind` is returned when unseen mutations exceed `maxUnseenMutations` (see §14);
  clients must first apply unseen entries from the server before submitting new commands.

## 9. Read Tracking Model

### 9.1 Read keys are part of the query

Read keys are **derived from query results**, but they are always recorded **together** with the
query shape that produced them (read scope). This is critical because queries can include `where`
conditions and left joins that affect which rows should be considered conflicting.

### 9.2 Read scopes

A read scope captures the query shape for phantom detection:

```ts
type ReadScope = {
  schema: string;
  table: string;
  indexName: string;
  condition?: Condition; // indexed columns only
  joins?: CompiledJoin[]; // left-join tree
};
```

Notes:

- Scopes are derived from `RetrievalOperation` in
  `packages/fragno-db/src/query/unit-of-work/unit-of-work.ts`.
- `whereIndex(...)` guarantees index‑bounded conditions.
- Joins are **left joins** (see `sql-query-compiler.ts`).

### 9.3 Read keys

Read keys are collected from actual query results and include rows returned by joins.

- Every table has an external ID column (`idColumn()`), so read keys always use externalId.
- For joins, read keys are collected from nested join results (one/many) as well as the root
  records.
- When read tracking is enabled, the select builder must **force‑include the external id** so read
  keys can be derived even if the handler did not select `id` explicitly.

## 10. Conflict Detection

### 10.1 Unseen mutations

Unseen mutations are those with:

```
entryVersionstamp > baseVersionstamp
```

The server queries `fragno_db_outbox_mutations` to find mutations that intersect read keys or read
scopes.

### 10.2 Conflict rule

A conflict occurs if any unseen mutation:

- touches a **read key**, or
- touches a **write key**, or
- satisfies a **read scope** query

### 10.3 Scope checks (SQL)

For each read scope, the server runs a conflict query of the form:

```
SELECT 1
FROM <table> t
JOIN fragno_db_outbox_mutations m
  ON m.schema = <schema> AND m.table = <table> AND m.externalId = t.<id>
WHERE m.entryVersionstamp > <base>
  AND <original conditions on t (and joined tables)>
LIMIT 1
```

Notes:

- For joins, the conflict query uses the same join tree (left joins) and adds the mutation log join
  for each participating table alias.
- This avoids storing index keys in the mutation log and works with current query compiler logic.

### 10.4 Unknown read strategy

If a query cannot be represented as a read scope, the server applies `unknownReadStrategy`:

- `"conflict"` (default) — treat as conflicting if any unseen mutation touches the table.
- `"table"` — conflict only if unseen mutations touch the same table (any row).
- `"ignore"` — skip conflict checks for that query (unsafe, opt‑in).

## 11. Plan + Execute (Server)

### 11.1 Plan execution

Each command is first executed in **plan mode**:

1. Run handlerTx with **read tracking enabled**.
2. Collect read scopes from the UOW retrieval operations.
3. Collect read keys from the decoded results (including join results).
4. Collect write keys from mutation operations.
5. Do **not** persist mutations (mutation phase uses a no‑op executor).

Implementation hooks:

- Extend `ExecuteTxOptions` to support `onAfterRetrieve` (read keys) and `onBeforeMutate` (write
  keys capture) callbacks.
- Add a small `plan` executor that skips mutation execution but returns success.
- Plan mode **suppresses hooks**.
- ServiceTx calls run inside handlerTx during planning (via `withServiceCalls(...)`).

### 11.2 Apply execution

If no conflicts, execute the handlerTx normally (with real executor). Use existing outbox
concurrency protection:

- Outbox counter is reserved at transaction start.
- If commit detects the outbox counter advanced, reload unseen entries and retry (bounded).
- After 10 retries, return `write_congestion` (mapped to `conflict`).

### 11.3 Idempotency

- Insert a record into `fragno_db_sync_requests` when a request is processed.
- If `requestId` already exists, return `already_handled` with the stored metadata + fresh outbox
  entries from `baseVersionstamp`.

## 12. Client‑Side Optimistic Execution (Lofi)

### 12.1 Local handlerTx runtime

Provide a **local handlerTx runtime** that uses the same handler code as the server but executes
against Lofi storage.

- Implemented in `packages/lofi/src/submit/local-handler-tx.ts`.
- Uses `LofiQueryableAdapter.createQueryEngine(...)` for reads.
- Converts UOW mutations into `LofiMutation` and applies them via `applyMutations`.
- Executes serviceTx calls inside handlerTx (`withServiceCalls`) using the same local UOW.

### 12.2 Command queue + rebase

- Store submitted commands in a local outbox/queue (`packages/lofi/src/submit/client.ts`).
- On submit response:
  1. Apply all unseen outbox entries to local store.
  2. Replay **confirmed** commands by re‑running handlers against fresh base state.
  3. Stop at the first unconfirmed command; keep remaining commands for next submit.
- Replay uses handlerTx and executes serviceTx calls via `withServiceCalls` using the same local
  UOW.

### 12.3 Client vs server context

- Client context is provided by the app (current user/session snapshot).
- Server context is derived from the authenticated request and may **tighten** query scopes.
- Service implementations must be browser‑safe; external IO is not allowed in handlerTx/serviceTx.

## 13. Unplugin + Build Guarantees

- Add a `defineSyncCommands` transform that **preserves handler bodies** in client builds.
- Ensure new `withSyncCommands(...)` chain method is treated as a no‑op in browser builds.
- Add a client‑side stub for `withSyncCommands(...)` (or equivalent transform) so browser bundles
  can safely import fragments with sync commands.
- Preserve **service implementation code** (the bodies passed to `providesService(...)`) so sync
  handlers can call `serviceTx` in the browser. Do not include route handler logic or RPC wiring.
- Add `@fragno-dev/db/sync` export that is browser‑safe and does not pull SQL adapters.

## 14. Limits & Validation

- `maxCommandsPerSubmit` (default 100)
- `maxUnseenMutations` (default 10,000)
- Validate hex versionstamp format and length (24 hex chars).
- Reject unknown command names or unknown `{ fragment, schema }` targets.
- If `commands.length === 0`, return `conflict` with `reason: "no_commands"`.
- If `commands.length > maxCommandsPerSubmit`, return `conflict` with `reason: "limit_exceeded"`.
- If unseen mutations exceed `maxUnseenMutations`, return `conflict` with
  `reason: "client_far_behind"` (client must apply server entries before resubmitting).

## 15. Security / Authorization

- Submit is internal; host apps must secure it like `/_internal/outbox`.
- Server context enforces auth via query scoping; client context is not trusted.
- Requests must include `adapterIdentity` from `GET /_internal` (describe response); mismatches
  hard‑fail.

## 16. Upgrade / Compatibility

- Internal schema migration adds `fragno_db_outbox_mutations` + `fragno_db_sync_requests`.
- Outbox versionstamp columns are strings; new logic assumes string comparison.
- Submit endpoint is available only when outbox is enabled.

## 17. Decisions (Locked)

- Use **mutation log table** for conflicts (no per‑row clocks).
- Endpoint path: `/_internal/sync`.
- Require `adapterIdentity` in submit requests.
- Commands include a `{ fragment, schema }` target; server resolves schema → namespace.
- Default `unknownReadStrategy = conflict` (safe by default).
- Commands are processed sequentially; **only a prefix** can be applied.
- Atomicity is per handlerTx (each command is its own transaction).
- Conflict responses include `confirmedCommandIds` for applied prefix (if any).
- Sync commands **may use serviceTx** via `withServiceCalls(...)`; service code must be
  browser‑safe.
- Conflict checks include write keys.

## 18. Lofi CLI + Scenario DSL

Extend the existing `fragno-lofi` CLI (`packages/lofi/src/cli/index.ts`) so it can run as both a
**server** and a **client**, and support multi‑client scenarios for validation.

### 18.1 CLI modes

- `fragno-lofi serve` — start a local server that exposes fragment routes and `/_internal/*` for
  outbox + submit. Intended for local test harness usage (not a production server).
- `fragno-lofi client` — run a Lofi client that can **sync + submit** commands against a server.
- `fragno-lofi scenario` — run a DSL‑defined scenario with multiple clients.

### 18.2 Scenario DSL

Add a tiny DSL (TypeScript) to define server/client topology + a trace of reads/writes. This is used
to validate conflict detection, optimistic replay, and read tracking.

Example (sketch):

```ts
import { defineScenario } from "@fragno-dev/lofi/scenario";
import { fragment } from "./fragment";

export default defineScenario({
  server: { fragment, port: 4100 },
  clients: {
    a: { endpointName: "client-a" },
    b: { endpointName: "client-b" },
  },
  steps: [
    { client: "a", command: "addComment", input: { postId: "p1", body: "hi" } },
    { client: "b", read: (db) => db.find("comments", (b) => b.whereIndex("primary")) },
    { assert: (ctx) => ctx.expect.noConflicts() },
  ],
});
```

Required DSL features:

- Start/stop server and clients.
- Execute commands, reads, and arbitrary waits.
- Assertions for conflict outcomes, outbox cursors, and final local state.

### 18.3 Test usage

- Use the DSL in Vitest to run end‑to‑end submit + conflict cases.
- Ensure at least one scenario exercises **read scopes with joins** and **auth scoping**.

## 19. Documentation Updates

- Update `packages/lofi/README.md` with submit flow and sync command usage.
- No docs site updates in this iteration.
