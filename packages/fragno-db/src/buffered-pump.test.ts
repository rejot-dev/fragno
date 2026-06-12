import { describe, expect, test, assert } from "vitest";

import { SQLocalKysely } from "sqlocal/kysely";

import { defineFragment, instantiate } from "@fragno-dev/core";

import { SQLocalDriverConfig } from "./adapters/generic-sql/driver-config";
import { SqlAdapter } from "./adapters/generic-sql/generic-sql-adapter";
import {
  BufferedDatabasePump,
  BufferedPumpRegistry,
  type BufferedFlushContext,
  type BufferedFlushResult,
  type BufferedItemContext,
} from "./buffered-pump";
import type { DatabaseHandlerContext, DatabaseHandlerTx } from "./db-fragment-definition-builder";
import { internalSchema } from "./fragments/internal-fragment";
import { column, idColumn, schema, type AnySchema } from "./schema/create";
import { withDatabase } from "./with-database";

const handlerTx = (() => {
  throw new Error("handlerTx should not be called by the generic pump");
}) as DatabaseHandlerTx;

const nextMicrotask = () => new Promise<void>((resolve) => queueMicrotask(resolve));

const pumpIntegrationSchema = schema("buffered_pump_integration", (s) =>
  s.addTable("pump_events", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("kind", column("string"))
      .addColumn("scopeKey", column("string"))
      .addColumn("payload", column("json")),
  ),
);

const pumpIntegrationFragmentDef = defineFragment("buffered-pump-integration")
  .extend(withDatabase(pumpIntegrationSchema))
  .build();

async function migrateSchema(adapter: SqlAdapter, schemaToMigrate: AnySchema, namespace: string) {
  const migrations = adapter.prepareMigrations(schemaToMigrate, namespace);
  await migrations.executeWithDriver(adapter.driver, 0);
}

async function buildSqlitePumpIntegration() {
  const { dialect } = new SQLocalKysely(":memory:");
  const adapter = new SqlAdapter({
    dialect,
    driverConfig: new SQLocalDriverConfig(),
  });

  await migrateSchema(adapter, internalSchema, "");
  await migrateSchema(adapter, pumpIntegrationSchema, pumpIntegrationSchema.name);

  const fragment = instantiate(pumpIntegrationFragmentDef)
    .withConfig({})
    .withRoutes([])
    .withOptions({ databaseAdapter: adapter })
    .build();

  return {
    fragment,
    cleanup: async () => {
      await adapter.close();
    },
  };
}

type RecordedFlush = {
  calls: BufferedFlushContext[];
  flush: (context: BufferedFlushContext) => Promise<BufferedFlushResult>;
};

function recordedFlush(
  handler: (context: BufferedFlushContext, callIndex: number) => Promise<BufferedFlushResult>,
): RecordedFlush {
  const calls: BufferedFlushContext[] = [];
  return {
    calls,
    flush: async (context) => {
      calls.push(context);
      return await handler(context, calls.length - 1);
    },
  };
}

const resetAfterOpenScopeFlush = async (
  pump: { flushNow(): Promise<void> },
  recorded: Pick<RecordedFlush, "calls">,
) => {
  await pump.flushNow();
  recorded.calls.length = 0;
};

describe("BufferedPumpRegistry", () => {
  test("creates one pump per string key and one handle per caller", async () => {
    const registry = new BufferedPumpRegistry<BufferedDatabasePump>();
    const firstPump = new BufferedDatabasePump({ handlerTx, flush: async () => ({}) });
    const secondPump = new BufferedDatabasePump({ handlerTx, flush: async () => ({}) });
    let createCount = 0;

    const first = registry.getOrCreate("a", () => {
      createCount += 1;
      return firstPump;
    });
    const second = registry.getOrCreate("a", () => secondPump);

    expect(first).not.toBe(second);
    expect(first.pump).toBe(second.pump);
    expect(first.pump).toBe(firstPump);
    expect(createCount).toBe(1);
    expect(registry.get("a")).toBe(firstPump);
    expect(registry.values()).toEqual([firstPump]);

    await first.close();
    expect(registry.get("a")).toBe(firstPump);
    await first.close();
    expect(registry.get("a")).toBe(firstPump);
    await second.close();
    expect(registry.get("a")).toBeUndefined();
  });

  test("handle.flushAndClose flushes then removes the last handle", async () => {
    const registry = new BufferedPumpRegistry<BufferedDatabasePump>();
    const recorded = recordedFlush(async () => ({}));
    const handle = registry.getOrCreate(
      "a",
      () => new BufferedDatabasePump({ handlerTx, flush: recorded.flush }),
    );

    await handle.flushAndClose();

    expect(recorded.calls).toHaveLength(1);
    expect(registry.get("a")).toBeUndefined();
  });

  test("handle.close releases without flushing", async () => {
    const registry = new BufferedPumpRegistry<BufferedDatabasePump>();
    const recorded = recordedFlush(async () => ({}));
    const handle = registry.getOrCreate(
      "a",
      () => new BufferedDatabasePump({ handlerTx, flush: recorded.flush }),
    );

    await handle.close();

    expect(recorded.calls).toEqual([]);
    expect(registry.get("a")).toBeUndefined();
  });

  test("handle.waitForNextFlushAndClose waits for a background flush before releasing", async () => {
    const registry = new BufferedPumpRegistry<BufferedDatabasePump>();
    const recorded = recordedFlush(async () => ({}));
    const handle = registry.getOrCreate(
      "a",
      () => new BufferedDatabasePump({ handlerTx, flush: recorded.flush, intervalMs: 1 }),
    );

    await handle.waitForNextFlushAndClose();

    expect(recorded.calls.length).toBeGreaterThan(0);
    expect(registry.get("a")).toBeUndefined();
  });
});

describe("BufferedDatabasePump", () => {
  test("resolves scope metadata before opening a scope", () => {
    const pump = new BufferedDatabasePump<
      string,
      { value: string },
      string,
      never,
      { input: string }
    >({
      handlerTx,
      flush: async () => ({}),
      resolveScopeMeta: ({ key, meta }) => ({ value: `${key}:${meta?.input}` }),
    });

    const scope = pump.openScope("scope", { input: "meta" });

    expect(scope.meta).toEqual({ value: "scope:meta" });
  });

  test("uses configured debug labels", () => {
    const pump = new BufferedDatabasePump({
      handlerTx,
      flush: async () => ({}),
      debugLabel: () => "custom-label",
    });

    assert(pump.debugLabel() === "custom-label");
  });

  test("flushes scoped outgoing buffers", async () => {
    const recorded = recordedFlush(async ({ batch }) => ({
      observedItems: [...(batch.outgoingByScope.get("step") ?? [])],
    }));
    const pump = new BufferedDatabasePump({ handlerTx, flush: recorded.flush });
    const scope = pump.openScope("step", { epoch: "e1" });
    const observed: unknown[] = [];
    pump.observe((message) => {
      observed.push(message);
    });
    await resetAfterOpenScopeFlush(pump, recorded);

    scope.enqueueOutgoing({ out: 1 });
    await pump.flushNow();

    expect(recorded.calls).toHaveLength(1);
    const ctx = recorded.calls[0]!;
    expect(ctx.scopes.get("step")).toEqual({ key: "step", meta: { epoch: "e1" }, closed: false });
    expect(ctx.batch.outgoingByScope.get("step")).toEqual([{ out: 1 }]);
    expect(observed).toEqual([{ out: 1 }]);
  });

  test("materializes outgoing factories immediately before flush with current buffer view", async () => {
    const recorded = recordedFlush(async (ctx) => ({
      snapshot: [...(ctx.batch.outgoingByScope.get("s") ?? [])],
    }));
    const pump = new BufferedDatabasePump({ handlerTx, flush: recorded.flush });
    const scope = pump.openScope("s", { tag: "scope-meta" });
    await resetAfterOpenScopeFlush(pump, recorded);

    scope.enqueueOutgoing((view: BufferedItemContext) => ({
      kind: "outgoing",
      scope: view.scope,
      previousOutgoing: view.outgoingFor("s").length,
    }));
    scope.enqueueOutgoing((view: BufferedItemContext) => [
      {
        kind: "outgoing",
        previousOutgoing: view.outgoingFor("s").length,
      },
      { kind: "outgoing-extra" },
    ]);

    await pump.flushNow();

    expect(recorded.calls[0]!.batch.outgoingByScope.get("s")).toEqual([
      {
        kind: "outgoing",
        scope: { key: "s", meta: { tag: "scope-meta" }, closed: false },
        previousOutgoing: 0,
      },
      { kind: "outgoing", previousOutgoing: 1 },
      { kind: "outgoing-extra" },
    ]);
  });

  test("reruns factories when a failed flush restores drained outgoing work", async () => {
    let factoryRuns = 0;
    let shouldFail = true;
    const recorded = recordedFlush(async (ctx) => {
      if (shouldFail && (ctx.batch.outgoingByScope.get("s")?.length ?? 0) > 0) {
        shouldFail = false;
        throw new Error("boom");
      }
      return {};
    });
    const errors: unknown[] = [];
    const pump = new BufferedDatabasePump({
      handlerTx,
      flush: recorded.flush,
      onError: (error) => {
        errors.push(error);
      },
    });
    const scope = pump.openScope("s");
    await resetAfterOpenScopeFlush(pump, recorded);

    scope.enqueueOutgoing(() => ({ run: ++factoryRuns }));

    await expect(pump.flushNow()).rejects.toThrow("boom");
    await pump.flushNow();

    expect(errors).toHaveLength(1);
    expect(recorded.calls[0]!.batch.outgoingByScope.get("s")).toEqual([{ run: 1 }]);
    expect(recorded.calls[1]!.batch.outgoingByScope.get("s")).toEqual([{ run: 2 }]);
  });

  test("delivers scope deliveries and observed items returned by flush", async () => {
    const recorded = recordedFlush(async () => ({
      scopeDeliveries: [
        { scopeKey: "a", message: "to-a" },
        { scopeKey: "missing", message: "ignored" },
      ],
      observedItems: ["observed-1", "observed-2"],
    }));
    const pump = new BufferedDatabasePump({ handlerTx, flush: recorded.flush });
    const a = pump.openScope("a");
    const deliveries: unknown[] = [];
    const observed: unknown[] = [];
    a.onDelivery((message) => {
      deliveries.push(message);
    });
    pump.observe((message) => {
      observed.push(message);
    });
    await resetAfterOpenScopeFlush(pump, recorded);
    deliveries.length = 0;
    observed.length = 0;

    await pump.flushNow();

    expect(deliveries).toEqual(["to-a"]);
    expect(observed).toEqual(["observed-1", "observed-2"]);
  });

  test("suppresses repeated scope deliveries with the same cursor", async () => {
    let enabled = false;
    const recorded = recordedFlush(async () => ({
      scopeDeliveries: enabled
        ? [{ scopeKey: "scope", message: "delivered", cursor: "row-1" }]
        : [],
    }));
    const pump = new BufferedDatabasePump({ handlerTx, flush: recorded.flush });
    const scope = pump.openScope("scope");
    const delivered: unknown[] = [];
    scope.onDelivery((message) => {
      delivered.push(message);
    });
    await resetAfterOpenScopeFlush(pump, recorded);
    delivered.length = 0;

    enabled = true;
    await pump.flushNow();
    await pump.flushNow();

    expect(delivered).toEqual(["delivered"]);
  });

  test("does not deliver to unregistered scope handlers", async () => {
    const recorded = recordedFlush(async () => ({
      scopeDeliveries: [{ scopeKey: "scope", message: "delivered" }],
    }));
    const pump = new BufferedDatabasePump({ handlerTx, flush: recorded.flush });
    const scope = pump.openScope("scope");
    const delivered: unknown[] = [];
    scope.onDelivery((message) => {
      delivered.push(message);
    });
    const unregister = scope.onDelivery((message) => {
      delivered.push({ removed: message });
    });
    await resetAfterOpenScopeFlush(pump, recorded);
    delivered.length = 0;

    unregister();
    await pump.flushNow();

    expect(delivered).toEqual(["delivered"]);
  });

  test("observe starts polling and unsubscribe allows the pump to stop when idle", async () => {
    let flushCount = 0;
    const pump = new BufferedDatabasePump({
      handlerTx,
      intervalMs: 1,
      flush: async () => {
        flushCount += 1;
        return { observedItems: [flushCount] };
      },
    });
    const observed: unknown[] = [];

    const unsubscribe = pump.observe((message) => {
      observed.push(message);
    });
    await pump.waitForNextFlush();

    expect(flushCount).toBeGreaterThan(0);
    expect(observed.length).toBeGreaterThan(0);
    assert(pump.isRunning());

    unsubscribe();
    await nextMicrotask();

    assert(!pump.isRunning());
  });

  test("snapshot uses explicit snapshot override when provided", async () => {
    const pump = new BufferedDatabasePump({
      handlerTx,
      flush: async () => ({ observedItems: ["observed"], snapshot: ["snapshot"] }),
    });

    await pump.flushNow();

    await expect(pump.snapshot()).resolves.toEqual(["snapshot"]);
  });

  test("observe after-cursors suppress already observed items", async () => {
    type Item = { id: string; payload: string };
    let call = 0;
    const pump = new BufferedDatabasePump<Item, unknown, Item>({
      handlerTx,
      flush: async () => ({
        observedItems:
          call++ === 0
            ? [
                { id: "row-1", payload: "first" },
                { id: "row-2", payload: "second" },
              ]
            : [
                { id: "row-2", payload: "second" },
                { id: "row-3", payload: "third" },
              ],
      }),
      cursorForObservedItem: (item) => item.id,
    });

    const snapshot = await pump.snapshot();
    const observed: Item[] = [];
    const unsubscribe = pump.observe(
      (item) => {
        observed.push(item);
      },
      { after: snapshot },
    );
    await pump.flushNow();
    unsubscribe();

    expect(observed).toEqual([{ id: "row-3", payload: "third" }]);
  });

  test("publishObserved appends only newly observed items to snapshots", async () => {
    type Item = { id: string; payload: string };
    const pump = new BufferedDatabasePump<Item, unknown, Item>({
      handlerTx,
      flush: async () => ({ observedItems: [{ id: "row-1", payload: "first" }] }),
      cursorForObservedItem: (item) => item.id,
    });
    const observed: Item[] = [];
    pump.observe((item) => {
      observed.push(item);
    });

    await pump.flushNow();
    await pump.publishObserved([
      { id: "row-1", payload: "stale" },
      { id: "row-2", payload: "second" },
      { id: "row-2", payload: "duplicate" },
    ]);

    expect(observed).toEqual([
      { id: "row-1", payload: "first" },
      { id: "row-2", payload: "second" },
    ]);
    await expect(pump.snapshot()).resolves.toEqual([
      { id: "row-1", payload: "first" },
      { id: "row-2", payload: "second" },
    ]);
  });

  test("flush failures restore drained outgoing buffers and rethrow", async () => {
    const errors: unknown[] = [];
    let shouldFail = true;
    const pump = new BufferedDatabasePump({
      handlerTx,
      flush: async ({ batch }) => {
        if (shouldFail && (batch.outgoingByScope.get("s")?.length ?? 0) > 0) {
          throw new Error("flush failed");
        }
        return { observedItems: ["after-retry"] };
      },
      onError: (error) => {
        errors.push(error);
      },
    });
    const scope = pump.openScope("s");
    const observed: unknown[] = [];
    pump.observe((message) => {
      observed.push(message);
    });
    await resetAfterOpenScopeFlush(pump, { calls: [] });
    observed.length = 0;

    scope.enqueueOutgoing("pending");
    await expect(pump.flushNow()).rejects.toThrow("flush failed");

    shouldFail = false;
    await pump.flushNow();

    expect(errors).toHaveLength(1);
    expect(observed).toEqual(["after-retry"]);
    expect(pump.getFailure()).toBeUndefined();
  });

  test("integration: flush uses a real sqlite handlerTx to read and write scoped outgoing items", async () => {
    const { fragment, cleanup } = await buildSqlitePumpIntegration();
    let pump: { stop(): void } | undefined;

    try {
      await fragment.inContext(async function (this: DatabaseHandlerContext) {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            forSchema(pumpIntegrationSchema).create("pump_events", {
              kind: "preexisting",
              scopeKey: "remote-scope",
              payload: { message: "already-written-by-another-server" },
            });
          })
          .execute();

        const createdPump = new BufferedDatabasePump({
          handlerTx: this.handlerTx,
          flush: async ({ handlerTx, batch }) => {
            return await handlerTx()
              .retrieve(({ forSchema }) =>
                forSchema(pumpIntegrationSchema).find("pump_events", (b) =>
                  b.whereIndex("primary"),
                ),
              )
              .mutate(({ forSchema, retrieveResult: [persistedRows] }) => {
                const uow = forSchema(pumpIntegrationSchema);
                const materializedRows = persistedRows.map((row) => ({
                  kind: row.kind,
                  scopeKey: row.scopeKey,
                  payload: row.payload,
                }));
                for (const event of batch.outgoingByScope.get("scope-a") ?? []) {
                  const row = event as { kind: string; scopeKey: string; payload: unknown };
                  uow.create("pump_events", row);
                  materializedRows.push(row);
                }
                return materializedRows;
              })
              .transform(({ mutateResult }) => ({ observedItems: mutateResult }))
              .execute();
          },
        });
        pump = createdPump;
        const scope = createdPump.openScope("scope-a");
        const observed: unknown[] = [];
        createdPump.observe((message) => {
          observed.push(message);
        });
        await createdPump.flushNow();
        observed.length = 0;

        scope.enqueueOutgoing((view: BufferedItemContext) => ({
          kind: "outgoing",
          scopeKey: "scope-a",
          payload: { message: "from-scope", previousForScope: view.outgoingFor("scope-a").length },
        }));
        await createdPump.flushNow();

        const rows = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(pumpIntegrationSchema).find("pump_events", (b) => b.whereIndex("primary")),
          )
          .transformRetrieve(([result], _serviceResult) => result)
          .execute();

        expect(observed).toEqual([
          {
            kind: "preexisting",
            scopeKey: "remote-scope",
            payload: { message: "already-written-by-another-server" },
          },
          {
            kind: "outgoing",
            scopeKey: "scope-a",
            payload: { message: "from-scope", previousForScope: 0 },
          },
        ]);
        expect(rows).toHaveLength(2);
        expect(
          rows.map((row) => ({ kind: row.kind, scopeKey: row.scopeKey, payload: row.payload })),
        ).toEqual(
          expect.arrayContaining([
            {
              kind: "preexisting",
              scopeKey: "remote-scope",
              payload: { message: "already-written-by-another-server" },
            },
            {
              kind: "outgoing",
              scopeKey: "scope-a",
              payload: { message: "from-scope", previousForScope: 0 },
            },
          ]),
        );
      });
    } finally {
      pump?.stop();
      await nextMicrotask();
      await cleanup();
    }
  });
});
