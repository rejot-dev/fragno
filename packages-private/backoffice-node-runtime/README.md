# Backoffice Node runtime

Reusable Durable Object execution in Node worker threads, SQLite persistence and coordination, Cap'n
Web RPC, durable-hook processing, and alarm scheduling. Backoffice currently keeps its own runtime
implementation; application integration with this package is deferred.

## Package layout

```text
src/
  runtime/          Object definitions, worker ownership, lifecycle, and clocks
  rpc/              Cap'n Web sessions over Node MessagePorts
  sqlite/           Object storage, state, coordination, and connection configuration
  scheduling/       Alarm scheduling and durable-hook processing
  testing/          Scenario runner
    fixtures/       Importable object factories used by package tests
```

Tests live beside their source files. Build output mirrors these directories; public package
subpaths map directly to the defining modules and remain independent of the internal layout.

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
- `server.fetch(request, assertResponse)` calls the routing handler and checks its response.
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
