# Backoffice Node runtime

Reusable Durable Object execution in Node worker threads, SQLite persistence and coordination, Cap'n
Web RPC, durable-hook processing, and alarm scheduling. Backoffice currently keeps its own runtime
implementation; application integration with this package is deferred.

## Package layout

```text
src/
  graft/            Graft storage, durable control commands, activation, and object-log fencing
  runtime/          Object definitions, worker ownership, lifecycle, clocks, and state APIs
  rpc/              Cap'n Web sessions over Node MessagePorts
  sqlite/           Object storage, state, coordination, and connection configuration
  scheduling/       Alarm scheduling and durable-hook processing
  testing/          Scenario runner
    fixtures/       Importable object factories used by package tests
```

Tests live beside their source files. Build output mirrors these directories; public package
subpaths map directly to the defining modules and remain independent of the internal layout.

Type checking and type-aware lint wait for this package's build because scenario fixtures consume
its compiled public exports; otherwise rebuilding can remove declarations while checks read them.

References:

- `docs/sqlite-ddl-reference.md` inventories every package-owned and test-only SQLite DDL statement.
- `docs/stateless-graft-runtime-plan.md` describes the remaining distributed runtime work.

## Object workers

`createNodeObjectRuntime` from `@fragno-private/backoffice-node-runtime/node-object-runtime` owns
one worker thread per `(binding, object name)`. Fetch, RPC, initialization, alarms, and `waitUntil`
all use the **same object instance and SQLite connection inside that worker**. Different object
identities have separate threads and in-memory state. The routing server stays in the calling
thread.

Factories must be named exports from modules that Node can import directly. They are not serialized
closures and cannot capture the routing server's variables. Use compiled ESM modules for deployment;
native, erasable TypeScript modules also work on the supported Node versions. Module URLs must
resolve in the deployed filesystem, not through Vite or a test runner's module transforms. The
package's `dist/runtime/node-object-worker.js` and the rest of `dist/` must be preserved when
deploying or bundling.

```ts
// counter-object.ts
import type { NodeRuntimeObjectContext } from "@fragno-private/backoffice-node-runtime/node-runtime-object";

export function createCounterObject({ state, nowEpochMs }: NodeRuntimeObjectContext) {
  let memoryCount = 0;
  return {
    async schedule() {
      await state.storage.setAlarm(nowEpochMs() + 100);
    },
    async fetch(_request: Request) {
      return Response.json({ memoryCount, count: (await state.storage.get("count")) ?? 0 });
    },
    async alarm() {
      memoryCount += 1;
      const count = (await state.storage.get<number>("count")) ?? 0;
      await state.storage.put("count", count + 1);
    },
  };
}
```

```ts
import type { createCounterObject } from "./counter-object";
import { createNodeObjectRuntime } from "@fragno-private/backoffice-node-runtime/node-object-runtime";
import { defineNodeRuntimeObject } from "@fragno-private/backoffice-node-runtime/node-runtime-object";
import { startNodeBackofficeAlarmScheduler } from "@fragno-private/backoffice-node-runtime/node-alarm-scheduler";

const runtime = createNodeObjectRuntime({
  directory: "./data",
  clock: { kind: "system" },
  objects: {
    COUNTER: defineNodeRuntimeObject<typeof createCounterObject>(
      new URL("./counter-object.js", import.meta.url),
      "createCounterObject",
    ),
  },
});
const scheduler = startNodeBackofficeAlarmScheduler(runtime);

await runtime.objects.COUNTER.get("one").schedule();
const response = await runtime.objects.COUNTER.get("one").fetch(
  new Request("https://object.test/"),
);
console.log(await response.json());

await scheduler.stop();
await runtime.cleanup();
```

One runtime owns a data directory; do not start independent serving/processing runtimes for it.
Persisted identities are rediscovered on alarm ticks, including after a runtime restart. Object
names can contain colons; binding names must be nonempty and cannot contain colons. Object factories
receive `id`, `name`, `state`, and `nowEpochMs()`. Synchronous and asynchronous methods both wait
for `blockConcurrencyWhile` initialization. Factories may return object literals or class instances.

Fetch and RPC cross real worker-thread boundaries through Cap'n Web sessions on Node MessagePorts.
Cap'n Web owns serialization, callback capabilities, returned `RpcTarget` capabilities, promise
pipelining, and Request/Response body streaming. Plain supported values are copied, not shared by
reference. `Date`, `Uint8Array`, and `bigint` values survive the boundary. Unsupported values follow
Cap'n Web's serialization errors (for example, version 0.12.0 rejects `Map` values). Instance fields
and alarm handlers are not exposed as public RPC methods. Every namespace `get(name)` returns an
independently disposable duplicate; disposing it explicitly or with `using` does not invalidate
other callers or the runtime-owned handle. Cap'n Web's reserved method names apply.

SQLite storage retains its separate V8 serialization format; RPC serialization does not change
persisted values. Alarm failures leave alarms pending for retry, and successful alarms can
reschedule themselves. SQLite claim leases use database time, independently of the supplied event
clock. Worker exits reject outstanding and future RPC calls rather than hanging. An exited worker
remains failed until the runtime is recreated; this package does not automatically restart it or
replay requests.

## Single-owner Graft runtime

`createGraftNodeObjectRuntime` is the first stateless-container storage slice. It uses one durable
Graft control database to map object identities to remote logs and one Graft SQLite database per
object. The object database contains application SQL plus the runtime's narrow KV and alarm tables.
Object authors access persistence only through `state.storage`; the worker owns local commits and
Graft pushes. The database assigns every local commit an activation-local storage position. Internal
RPC calls made inside `runtime.runWithOutputGate()` accumulate the highest position their output can
reveal without pushing between calls. Immediately before the enclosing external result or handler
error is exposed, the worker proves that position durable with Graft. A failed push poisons that
worker's database so its speculative local state cannot be read as confirmed state.

`createGraftNodeObjectRuntime` remains the compatibility path for one serving owner. It does not
claim control ownership or write object-log fencing commits, so run only one such runtime for a
control log. Use the authority-bound runtime below for takeover qualification. Fresh-process
recovery is proven, but peer routing, automatic lease renewal, watchdog-driven worker retirement,
and distributed alarm discovery remain incomplete.

Provision the control database once and retain its remote log ID in deployment configuration:

```ts
import { provisionGraftControlDatabase } from "@fragno-private/backoffice-node-runtime/graft-object-directory";

const controlRemoteLogId = provisionGraftControlDatabase("./graft.toml");
```

Then create a runtime from a process-local Graft config and that durable locator:

```ts
import { createGraftNodeObjectRuntime } from "@fragno-private/backoffice-node-runtime/node-object-runtime";

const runtime = createGraftNodeObjectRuntime({
  storage: { configPath: "./graft.toml", controlRemoteLogId },
  clock: { kind: "system" },
  objects: { COUNTER: counterDefinition },
});
```

### Authority-bound activation and takeover

`createAuthorityBoundGraftNodeObjectRuntime` registers one process-incarnation lease, claims each
opened object as `restoring`, pushes an authority fencing commit to the object's stable log,
initializes the worker, and publishes `ready` before its first RPC is admitted. The managed object
database captures the exact object epoch, node generation, claim ID, and confirmed lease deadline.
Every output checks that token before and after its durability push. Expired authority, an authority
row mismatch, or a divergent push poisons the activation instead of rebasing application SQL.

```ts
import { createAuthorityBoundGraftNodeObjectRuntime } from "@fragno-private/backoffice-node-runtime/node-object-runtime";

const runtime = createAuthorityBoundGraftNodeObjectRuntime({
  storage: { configPath: "./graft.toml", controlRemoteLogId },
  clock: { kind: "system" },
  nodeLease: {
    nodeId: crypto.randomUUID(),
    processGeneration: crypto.randomUUID(),
    privateAddress: "node-a.internal:8081",
    compatibilityVersion: 1,
    expiresAtMs: Date.now() + 30_000,
    renewalId: crypto.randomUUID(),
  },
  objects: { COUNTER: counterDefinition },
});
```

This is the minimum local-takeover slice, not a complete fleet runtime. Callers must currently
supply a lease deadline long enough for their qualification run; the runtime does not renew it. It
also does not route calls to a live remote owner. A process therefore activates only objects it can
claim locally, and authority loss is enforced at worker output boundaries rather than by a process
watchdog.

Real two-process scenarios cover both object-log orderings. If an old write reaches remote storage
first, the replacement reclones that head and preserves the write behind its higher-epoch fence,
while the expired caller receives no success. If the replacement fence lands first, the paused old
push diverges and its speculative write is discarded. Both paths delete every local cache and
restore the authoritative result in a third process.

### Durable control commands

`GraftControlStore` from `@fragno-private/backoffice-node-runtime/graft-control-store` manages the
shared control log through named, receipt-backed commands. It stores process-incarnation leases,
stable object mappings, explicit `unowned`/`restoring`/`ready` ownership, and decimal-string fencing
epochs. Available commands register and renew nodes, register object databases, claim objects, mark
claims ready, and conditionally release exact claims.

Every command opens a clean clone, checks an existing command receipt, evaluates its preconditions
in a short SQLite transaction, writes the result and receipt together, and synchronously pushes.
After a failed or lost push response, the store discards the speculative clone and searches a fresh
remote snapshot for the receipt. If the receipt is absent, it reruns the named command against
current state with the same command ID. It never rebases raw SQL from the losing snapshot.

Independent-process scenarios prove that concurrent claims produce one fresh epoch, losing clients
recompute against the winning history, a remotely committed command survives a lost response, an
expired owner can be replaced, and a late completion from the old claim cannot publish readiness.
The authority-bound runtime now consumes these decisions for local activation and object-log
fencing. Node lease renewal, terminal process watchdogs, remote-owner routing, and alarm discovery
remain to be connected before a general multi-node deployment is safe.

`GraftDatabaseOperations` owns the `clone`, `pull`, `push`, and remote-log lookup pragmas. The
default runtime imports the production pragma implementation inside each worker. Tests and
alternative adapters can use `defineGraftDatabaseOperations` with
`createGraftNodeObjectRuntimeWithDatabaseOperations` or
`createAuthorityBoundGraftNodeObjectRuntimeWithDatabaseOperations`; the definition transfers only a
module URL, export name, and structured-clonable factory input across the worker boundary. The
package scenario uses a recording decorator around the real pragmas to prove both boundaries: direct
RPC calls push before returning to their caller, while separate RPCs inside one external output gate
perform no intermediate pushes and share one final push. Concurrent scenarios also prove that RPCs
within one scope and separate writer scopes can share a push, while a reader does not wait for a
later storage position it did not observe.

Routing code places all internal object RPCs used to produce one external result inside an output
gate. The runtime owns the gate; object factories still receive no transaction or push controls:

```ts
const response = await runtime.runWithOutputGate(async () => {
  using counter = runtime.objects.COUNTER.get("one");
  await counter.increment();
  await counter.increment();
  return await counter.fetch(new Request("https://object.test/"));
});
```

A second request that reads locally committed state inherits that object's storage position. Its
output gate pushes that position before releasing the response, even when the request that wrote the
state is still running. When the writer later reaches its own output gate, the already-proven
position causes no additional push. These are visibility dependencies, not transactions: separate
RPC calls may observe each other's intermediate commits, and atomic state changes still require a
SQLite transaction. One output gate may touch several objects, but it pushes each object log
independently and provides no cross-object atomicity.

Object factories use the Durable Object-style SQL surface:

```ts
export function createCounterObject({ state }: NodeRuntimeObjectContext) {
  return {
    increment() {
      state.storage.sql.exec("UPDATE counters SET count = count + 1 WHERE id = 1");
      return state.storage.sql
        .exec<{ count: number }>("SELECT count FROM counters WHERE id = 1")
        .one().count;
    },
  };
}
```

Calls outside `runWithOutputGate()` retain an implicit per-call gate, so a direct public RPC cannot
return unconfirmed state. Initialization, alarms, and drained `waitUntil` work also retain immediate
worker-owned durability boundaries. Returned `RpcTarget` capabilities inherit the output scope in
which they were created and reject use after that scope closes. This is not a general side-effect
gate: outbound fetches, callback arguments, and response-stream work performed after the handler
returns are not transactional or delayed. Detached unregistered work remains unsupported.

The Graft runtime requires Node.js 24.11 or newer. `state.storage.sql.exec()` accepts one
application statement and does not expose transaction control, `PRAGMA`, `ATTACH`, or tables whose
names begin with `node_runtime_`. The Graft configuration must be established before the extension
loads, use `make_default = false`, and use a distinct `data_dir` for each container cache. Graft
0.2.1 is pinned; its VFS uses `journal_mode = MEMORY`, not WAL. The filesystem remote supports local
scenarios, while deployment can supply Graft's S3-compatible configuration. See
`docs/stateless-graft-runtime-plan.md` for the remaining control plane, fencing, routing, and
scheduling work.

### Caller-coordinated cleanup

Before calling `cleanup()`:

1. Stop accepting application requests and stop the alarm scheduler or other RPC producers.
2. Await every outstanding application RPC, including pipelined calls, returned-capability calls,
   and their callbacks. Unawaited calls are not guaranteed to finish during cleanup.
3. Finish or cancel request and response body streams. Do not use previously acquired object or
   capability handles once cleanup begins.

`cleanup()` is idempotent. It rejects new namespace lookups and runtime scheduling operations, waits
for object-local operations and background work registered with `state.waitUntil`, closes storage,
and terminates workers. It does not provide session-wide RPC draining or admission control for
existing handles. Racing application calls or streams with cleanup is unsupported: those operations
can fail or lose writes even when cleanup succeeds. Register background work with `state.waitUntil`;
detached work is not covered by cleanup.

Cap'n Web is used unmodified. Worker shutdown uses private control RPC after the caller has finished
application work; no custom shutdown envelope or dependency patch is required.

## Node runtime scenarios

Import from `@fragno-private/backoffice-node-runtime/node-runtime-scenario`. Scenarios use the same
worker runtime as production, with real temporary SQLite files and an atomically shared manual
clock. No HTTP listener, application server, or background polling timer is started.

```ts
import { assert, expect, test } from "vitest";
import type { createCounterObject } from "./counter-object";
import { defineNodeRuntimeObject } from "@fragno-private/backoffice-node-runtime/node-runtime-object";
import {
  defineNodeRuntimeScenario,
  runNodeRuntimeScenario,
} from "@fragno-private/backoffice-node-runtime/node-runtime-scenario";

test("fetch and alarms share the counter worker", async () => {
  await runNodeRuntimeScenario(
    defineNodeRuntimeScenario({
      name: "scheduled-counter",
      initialTimeEpochMs: 0,
      objects: {
        COUNTER: defineNodeRuntimeObject<typeof createCounterObject>(
          new URL("./counter-object.ts", import.meta.url),
          "createCounterObject",
        ),
      },
      server: ({ objects }) => ({
        async fetch(request) {
          const counter = objects.COUNTER.get("one");
          if (request.method === "POST") {
            await counter.schedule();
            return new Response(null, { status: 204 });
          }
          return await counter.fetch(request);
        },
      }),
      steps: ({ server, alarms, clock }) => [
        server.fetch(new Request("https://scenario.test/", { method: "POST" }), (response) => {
          assert.equal(response.status, 204);
        }),
        alarms.tick(),
        clock.advanceBy(100),
        alarms.tick(),
        server.fetch(new Request("https://scenario.test/"), async (response) => {
          expect(await response.json()).toEqual({ memoryCount: 1, count: 1 });
        }),
      ],
    }),
  );
});
```

- `given(label, run)`, `when(label, run)`, and `then(label, run)` create labeled custom steps. Their
  context exposes `server`, typed `objects`, `alarms`, and `clock`.
- `server.fetch(request, assertResponse)` runs the routing handler inside
  `runtime.runWithOutputGate()`, then checks the durable response.
- `alarms.tick()` discovers persisted objects, drains `waitUntil`, delivers due alarms in each
  object's existing worker, then drains `waitUntil` again. It uses the production scheduler's
  stages.
- `clock.advanceBy(ms)` changes the clock in all workers without delivering alarms.
- `concurrent(alarms.tick(), alarms.tick())` tests overlapping polls without creating duplicate
  object instances. Every branch settles before the scenario proceeds or cleans up.

The previous `processors` option and inline object factories have been removed. There are no
separate processor instances or runtime names: each object's worker owns both serving and
processing.

Scenarios return a journal of completed top-level steps. Failures name the scenario and step and
preserve serialized RPC error causes. Workers and SQLite connections are closed and the temporary
directory is removed on success or failure. Backoffice's authorization envelopes, object registry,
Fragment services, and durable-hook fragment composition are not installed by this harness.

Package tests exercise the built worker entry point, so build before running Vitest directly.
`pnpm exec turbo run test --filter=@fragno-private/backoffice-node-runtime` handles that dependency.
See `src/testing/node-runtime-scenario.test.ts` and `src/runtime/node-object-runtime.test.ts` for
serialization, capabilities, streaming fetch, alarm retries, persistence across restarts, cleanup,
and worker failures.
