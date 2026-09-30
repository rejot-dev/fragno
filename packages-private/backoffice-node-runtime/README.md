# Backoffice Node runtime

Reusable local Durable Object execution, SQLite persistence and coordination, durable-hook
processing, and alarm scheduling. Backoffice-specific object factories and authorization stay in the
application.

## Node runtime scenarios

Import from `@fragno-private/backoffice-node-runtime/node-runtime-scenario`.

The scenario runner uses the same `LocalDurableObjectNamespace`,
`ProcessLocalObjectExecutionCoordinator`, `SqliteDurableObjectState`, and `SqliteObjectCoordination`
that Backoffice uses. The main server and each named processor have independent object instances and
SQLite connections sharing one temporary directory, all within one Node process. No HTTP listener,
Vite server, or background polling timer is started.

Define factories for object bindings and a main server with a fetch handler. Object names identify
instances within a binding; `objects.COUNTER.get("one")` returns the real local object stub with its
inferred RPC methods. Declare fetch handlers, RPC methods, and alarm handlers as `async` methods so
the local runtime can prepare state before each event.

```ts
import { assert, expect, test } from "vitest";
import {
  defineNodeRuntimeScenario,
  runNodeRuntimeScenario,
} from "@fragno-private/backoffice-node-runtime/node-runtime-scenario";

test("main server schedules work through RPC", async () => {
  await runNodeRuntimeScenario(
    defineNodeRuntimeScenario({
      name: "scheduled-counter",
      initialTimeEpochMs: 0,
      processors: ["worker"],
      objects: {
        COUNTER: ({ state, nowEpochMs }) => ({
          async schedule() {
            await state.storage.setAlarm(nowEpochMs() + 100);
          },
          async fetch() {
            return Response.json({ count: (await state.storage.get("count")) ?? 0 });
          },
          async alarm() {
            const count = (await state.storage.get<number>("count")) ?? 0;
            await state.storage.put("count", count + 1);
          },
        }),
      },
      server: ({ objects }) => ({
        async fetch(request) {
          const counter = objects.COUNTER.get("one");
          if (request.method === "POST") {
            await counter.schedule();
            return new Response(null, { status: 204 });
          }
          return await counter.fetch();
        },
      }),
      steps: ({ server, processors, clock }) => [
        server.fetch(new Request("https://scenario.test/", { method: "POST" }), (response) => {
          assert.equal(response.status, 204);
        }),
        processors.worker.tick(),
        server.fetch(new Request("https://scenario.test/"), async (response) => {
          expect(await response.json()).toEqual({ count: 0 });
        }),
        clock.advanceBy(100),
        processors.worker.tick(),
        server.fetch(new Request("https://scenario.test/"), async (response) => {
          expect(await response.json()).toEqual({ count: 1 });
        }),
      ],
    }),
  );
});
```

- `given(label, run)`, `when(label, run)`, and `then(label, run)` create custom labeled steps. Their
  context exposes the main `server`, typed main `objects`, named `processors`, and `clock`.
- `server.fetch(request, assertResponse)` calls the main handler and checks its response.
- `processors.worker.tick()` discovers persisted objects, drains their `waitUntil` work, delivers
  due alarms, then drains `waitUntil` again. These are the production alarm scheduler's actual
  stages.
- `clock.advanceBy(ms)` changes the explicit scenario clock without delivering alarms. Use the
  supplied `nowEpochMs()` when scheduling alarms; SQLite claim leases still use real database time.
- `concurrent(processors.first.tick(), processors.second.tick())` exercises competing processors.
  Every branch settles before the scenario can proceed or clean up.

Fetch and RPC calls are direct in-process calls, not network or structured-clone boundaries. Object
storage uses real SQLite serialization. Factories receive `runtimeName` (`"main"` or the processor
name), so scenarios can verify which runtime handled an alarm. Alarms remain pending after failures
and are retried by subsequent explicit ticks.

The runner returns a journal of completed top-level steps. Failures name the scenario and step and
preserve their original cause. All runtimes are closed and the directory is removed on success or
failure. This harness does not install Backoffice's application-specific authorization envelopes,
object registry, or Fragment services.

See `src/node-runtime-scenario.test.ts` for multi-binding fetch/RPC, competing alarms, retry,
rescheduling, and serialization scenarios.
