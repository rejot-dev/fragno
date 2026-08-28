import { describe, expect, test, assert, vi } from "vitest";

import { SQLocalKysely } from "sqlocal/kysely";

import { defineFragment, instantiate } from "@fragno-dev/core";

import { SQLocalDriverConfig } from "./adapters/generic-sql/driver-config";
import { SqlAdapter } from "./adapters/generic-sql/generic-sql-adapter";
import {
  BufferedDatabasePump,
  BufferedPumpObserveTimeoutError,
  BufferedPumpSchedulerLeaseActiveError,
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
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  pump: { flushNow(handlerTx: DatabaseHandlerTx): Promise<void> },
  recorded: Pick<RecordedFlush, "calls">,
) => {
  await pump.flushNow(handlerTx);
  recorded.calls.length = 0;
};

describe("BufferedPumpRegistry", () => {
  test("creates one pump per string key and one handle per caller", async () => {
    const registry = new BufferedPumpRegistry<BufferedDatabasePump>();
    const firstPump = new BufferedDatabasePump({ flush: async () => ({}) });
    const secondPump = new BufferedDatabasePump({ flush: async () => ({}) });
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
      () => new BufferedDatabasePump({ flush: recorded.flush }),
    );

    await handle.flushAndClose(handlerTx);

    expect(recorded.calls).toHaveLength(1);
    expect(registry.get("a")).toBeUndefined();
  });

  test("handle.close releases without flushing", async () => {
    const registry = new BufferedPumpRegistry<BufferedDatabasePump>();
    const recorded = recordedFlush(async () => ({}));
    const handle = registry.getOrCreate(
      "a",
      () => new BufferedDatabasePump({ flush: recorded.flush }),
    );

    await handle.close();

    expect(recorded.calls).toEqual([]);
    expect(registry.get("a")).toBeUndefined();
  });

  test("handle.close rejects while its actor-owned scheduler lease is active", async () => {
    const registry = new BufferedPumpRegistry<BufferedDatabasePump>();
    const handle = registry.getOrCreate(
      "a",
      () => new BufferedDatabasePump({ intervalMs: 1, flush: async () => ({}) }),
    );
    const schedulerAbortController = new AbortController();
    const schedulerLease = handle.runWhile({
      kind: "writer",
      signal: schedulerAbortController.signal,
      handlerTx,
    });

    await expect(handle.close()).rejects.toMatchObject({
      name: "BufferedPumpSchedulerLeaseActiveError",
      pumpKey: "a",
      activeLeaseCount: 1,
    } satisfies Partial<BufferedPumpSchedulerLeaseActiveError>);
    assert(registry.get("a") === handle.pump);

    schedulerAbortController.abort();
    await schedulerLease;
    await handle.close();
    assert(registry.get("a") === undefined);
  });

  test("handle.close drains an active flush before completing", async () => {
    const registry = new BufferedPumpRegistry<BufferedDatabasePump>();
    let releaseFlush!: () => void;
    const flushReleased = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const handle = registry.getOrCreate(
      "a",
      () =>
        new BufferedDatabasePump({
          flush: async () => {
            await flushReleased;
            return {};
          },
        }),
    );
    const flush = handle.pump.flushNow(handlerTx);
    let closeCompleted = false;
    const close = handle.close().then(() => {
      closeCompleted = true;
    });

    await nextMicrotask();
    assert(!closeCompleted);
    releaseFlush();
    await flush;
    await close;

    assert(closeCompleted);
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
      flush: async () => ({}),
      resolveScopeMeta: ({ key, meta }) => ({ value: `${key}:${meta?.input}` }),
    });

    const scope = pump.openScope("scope", { input: "meta" });

    expect(scope.meta).toEqual({ value: "scope:meta" });
  });

  test("uses configured debug labels", () => {
    const pump = new BufferedDatabasePump({
      flush: async () => ({}),
      debugLabel: () => "custom-label",
    });

    assert(pump.debugLabel() === "custom-label");
  });

  test("flushes scoped outgoing buffers", async () => {
    const recorded = recordedFlush(async ({ batch }) => ({
      observedItems: [...(batch.outgoingByScope.get("step") ?? [])],
    }));
    const pump = new BufferedDatabasePump({ flush: recorded.flush });
    const scope = pump.openScope("step", { epoch: "e1" });
    const observed: unknown[] = [];
    pump.observe((message) => {
      observed.push(message);
    });
    await resetAfterOpenScopeFlush(pump, recorded);

    scope.enqueueOutgoing({ out: 1 });
    await pump.flushNow(handlerTx);

    expect(recorded.calls).toHaveLength(1);
    const ctx = recorded.calls[0]!;
    expect(ctx.scopes.get("step")).toEqual({ key: "step", meta: { epoch: "e1" }, closed: false });
    expect(ctx.batch.outgoingByScope.get("step")).toEqual([{ out: 1 }]);
    expect(observed).toEqual([{ out: 1 }]);
  });

  test("observer refreshes never drain writable scopes", async () => {
    const recorded = recordedFlush(async ({ batch }) => ({
      observedItems: [...(batch.outgoingByScope.get("step") ?? [])],
    }));
    const pump = new BufferedDatabasePump({ flush: recorded.flush });
    const scope = pump.openScope("step", { epoch: "e1" });
    scope.enqueueOutgoing({ out: 1 });

    await pump.refreshObserved(handlerTx);

    assert(recorded.calls[0]!.scopes.size === 0);
    assert(recorded.calls[0]!.batch.outgoingByScope.size === 0);

    await pump.flushNow(handlerTx);

    expect(recorded.calls[1]!.scopes.get("step")).toEqual({
      key: "step",
      meta: { epoch: "e1" },
      closed: false,
    });
    expect(recorded.calls[1]!.batch.outgoingByScope.get("step")).toEqual([{ out: 1 }]);
  });

  test("materializes outgoing factories immediately before flush with current buffer view", async () => {
    const recorded = recordedFlush(async (ctx) => ({
      snapshot: [...(ctx.batch.outgoingByScope.get("s") ?? [])],
    }));
    const pump = new BufferedDatabasePump({ flush: recorded.flush });
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

    await pump.flushNow(handlerTx);

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
      flush: recorded.flush,
      onError: (error) => {
        errors.push(error);
      },
    });
    const scope = pump.openScope("s");
    await resetAfterOpenScopeFlush(pump, recorded);

    scope.enqueueOutgoing(() => ({ run: ++factoryRuns }));

    await expect(pump.flushNow(handlerTx)).rejects.toThrow("boom");
    await pump.flushNow(handlerTx);

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
    const pump = new BufferedDatabasePump({ flush: recorded.flush });
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

    await pump.flushNow(handlerTx);

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
    const pump = new BufferedDatabasePump({ flush: recorded.flush });
    const scope = pump.openScope("scope");
    const delivered: unknown[] = [];
    scope.onDelivery((message) => {
      delivered.push(message);
    });
    await resetAfterOpenScopeFlush(pump, recorded);
    delivered.length = 0;

    enabled = true;
    await pump.flushNow(handlerTx);
    await pump.flushNow(handlerTx);

    expect(delivered).toEqual(["delivered"]);
  });

  test("does not deliver to unregistered scope handlers", async () => {
    const recorded = recordedFlush(async () => ({
      scopeDeliveries: [{ scopeKey: "scope", message: "delivered" }],
    }));
    const pump = new BufferedDatabasePump({ flush: recorded.flush });
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
    await pump.flushNow(handlerTx);

    expect(delivered).toEqual(["delivered"]);
  });

  test("an actor-owned scheduler lease stops polling after its signal aborts", async () => {
    let flushCount = 0;
    const pump = new BufferedDatabasePump({
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
    const schedulerAbortController = new AbortController();
    const schedulerLease = pump.runWhile({
      kind: "writer",
      signal: schedulerAbortController.signal,
      handlerTx,
    });

    await vi.waitFor(() => {
      expect(flushCount).toBeGreaterThan(0);
      expect(observed.length).toBeGreaterThan(0);
      assert(pump.activeSchedulerLeaseCount() === 1);
    });

    schedulerAbortController.abort();
    await schedulerLease;
    const flushCountAfterAbort = flushCount;
    await sleep(10);

    assert(flushCount === flushCountAfterAbort);
    assert(pump.activeSchedulerLeaseCount() === 0);
    unsubscribe();
  });

  test("scheduler leases elect one writer loop and hand ownership to the next actor", async () => {
    const firstHandlerTx = (() => undefined) as unknown as DatabaseHandlerTx;
    const secondHandlerTx = (() => undefined) as unknown as DatabaseHandlerTx;
    const flushCountByHandlerTx = new Map<DatabaseHandlerTx, number>();
    const pump = new BufferedDatabasePump({
      intervalMs: 1,
      flush: async ({ handlerTx: currentHandlerTx }) => {
        flushCountByHandlerTx.set(
          currentHandlerTx,
          (flushCountByHandlerTx.get(currentHandlerTx) ?? 0) + 1,
        );
        return {};
      },
    });
    const firstAbortController = new AbortController();
    const secondAbortController = new AbortController();
    const firstLease = pump.runWhile({
      kind: "writer",
      signal: firstAbortController.signal,
      handlerTx: firstHandlerTx,
    });
    const secondLease = pump.runWhile({
      kind: "writer",
      signal: secondAbortController.signal,
      handlerTx: secondHandlerTx,
    });

    await vi.waitFor(() => {
      assert(pump.activeSchedulerLeaseCount() === 2);
      assert(pump.activeSchedulerLoopCount() === 1);
      expect(flushCountByHandlerTx.get(firstHandlerTx)).toBeGreaterThan(0);
    });
    assert(flushCountByHandlerTx.get(secondHandlerTx) === undefined);

    firstAbortController.abort();
    await firstLease;
    assert(pump.activeSchedulerLeaseCount() === 1);
    assert(pump.activeSchedulerLoopCount() === 1);
    const firstFlushCountAfterAbort = flushCountByHandlerTx.get(firstHandlerTx);
    await vi.waitFor(() => {
      expect(flushCountByHandlerTx.get(secondHandlerTx)).toBeGreaterThan(0);
    });
    assert(flushCountByHandlerTx.get(firstHandlerTx) === firstFlushCountAfterAbort);

    secondAbortController.abort();
    await secondLease;
    assert(pump.activeSchedulerLeaseCount() === 0);
    assert(pump.activeSchedulerLoopCount() === 0);
  });

  test("writer leases preempt observer polling and observers resume after the writer exits", async () => {
    const observerHandlerTx = (() => undefined) as unknown as DatabaseHandlerTx;
    const writerHandlerTx = (() => undefined) as unknown as DatabaseHandlerTx;
    const flushCountByHandlerTx = new Map<DatabaseHandlerTx, number>();
    const pump = new BufferedDatabasePump({
      intervalMs: 1,
      flush: async ({ handlerTx: currentHandlerTx }) => {
        flushCountByHandlerTx.set(
          currentHandlerTx,
          (flushCountByHandlerTx.get(currentHandlerTx) ?? 0) + 1,
        );
        return {};
      },
    });
    const observerAbortController = new AbortController();
    const observerLease = pump.runWhile({
      kind: "observer",
      signal: observerAbortController.signal,
      handlerTx: observerHandlerTx,
    });
    await vi.waitFor(() => {
      expect(flushCountByHandlerTx.get(observerHandlerTx)).toBeGreaterThan(0);
    });

    const writerAbortController = new AbortController();
    const writerLease = pump.runWhile({
      kind: "writer",
      signal: writerAbortController.signal,
      handlerTx: writerHandlerTx,
    });
    await vi.waitFor(() => {
      expect(flushCountByHandlerTx.get(writerHandlerTx)).toBeGreaterThan(0);
    });
    const observerFlushCountWhileWriterRuns = flushCountByHandlerTx.get(observerHandlerTx);
    await sleep(10);
    assert(flushCountByHandlerTx.get(observerHandlerTx) === observerFlushCountWhileWriterRuns);
    assert(pump.activeSchedulerLoopCount() === 1);

    writerAbortController.abort();
    await writerLease;
    await vi.waitFor(() => {
      expect(flushCountByHandlerTx.get(observerHandlerTx)).toBeGreaterThan(
        observerFlushCountWhileWriterRuns ?? 0,
      );
    });

    observerAbortController.abort();
    await observerLease;
    assert(pump.activeSchedulerLeaseCount() === 0);
    assert(pump.activeSchedulerLoopCount() === 0);
  });

  test("an aborted scheduler lease drains its active flush without starting more I/O", async () => {
    const flushStarted = Promise.withResolvers<void>();
    const releaseFlush = Promise.withResolvers<void>();
    let flushCount = 0;
    const pump = new BufferedDatabasePump({
      intervalMs: 1,
      flush: async () => {
        flushCount += 1;
        flushStarted.resolve();
        await releaseFlush.promise;
        return {};
      },
    });
    const schedulerAbortController = new AbortController();
    const schedulerLease = pump.runWhile({
      kind: "writer",
      signal: schedulerAbortController.signal,
      handlerTx,
    });

    await flushStarted.promise;
    schedulerAbortController.abort();
    let leaseSettled = false;
    const recordLeaseSettlement = schedulerLease.then(() => {
      leaseSettled = true;
    });
    await nextMicrotask();
    assert(!leaseSettled);

    releaseFlush.resolve();
    await schedulerLease;
    await recordLeaseSettlement;
    const flushCountAfterAbort = flushCount;
    await sleep(10);

    assert(flushCount === flushCountAfterAbort);
    assert(pump.activeSchedulerLeaseCount() === 0);
  });

  test("drain waits for an active flush before completing", async () => {
    let resolveFlushStarted!: () => void;
    const flushStarted = new Promise<void>((resolve) => {
      resolveFlushStarted = resolve;
    });
    let releaseFlush!: () => void;
    const flushReleased = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const pump = new BufferedDatabasePump({
      flush: async () => {
        resolveFlushStarted();
        await flushReleased;
        return {};
      },
    });

    const flush = pump.flushNow(handlerTx);
    await flushStarted;

    let drainCompleted = false;
    const drain = pump.drain().then(() => {
      drainCompleted = true;
    });
    await nextMicrotask();
    assert(!drainCompleted);

    releaseFlush();
    await flush;
    await drain;

    assert(drainCompleted);
  });

  test("waitForNextWritableFlush ignores an in-progress flush that already drained its batch", async () => {
    const firstFlushStarted = Promise.withResolvers<void>();
    const releaseFirstFlush = Promise.withResolvers<void>();
    const outgoingBatches: string[][] = [];
    const pump = new BufferedDatabasePump<string, unknown, string>({
      flush: async ({ batch }) => {
        outgoingBatches.push([...(batch.outgoingByScope.get("step") ?? [])]);
        if (outgoingBatches.length === 1) {
          firstFlushStarted.resolve();
          await releaseFirstFlush.promise;
        }
        return {};
      },
    });
    const scope = pump.openScope("step", undefined);

    const firstFlush = pump.flushNow(handlerTx);
    await firstFlushStarted.promise;
    scope.enqueueOutgoing("checkpoint-emission");

    let checkpointFlushCompleted = false;
    const checkpointFlush = pump.waitForNextWritableFlush().then(() => {
      checkpointFlushCompleted = true;
    });

    releaseFirstFlush.resolve();
    await firstFlush;
    await nextMicrotask();
    assert(!checkpointFlushCompleted);

    await pump.flushNow(handlerTx);
    await checkpointFlush;

    expect(outgoingBatches).toEqual([[], ["checkpoint-emission"]]);
    assert(checkpointFlushCompleted);
  });

  test("snapshot uses explicit snapshot override when provided", async () => {
    const pump = new BufferedDatabasePump({
      flush: async () => ({ observedItems: ["observed"], snapshot: ["snapshot"] }),
    });

    await pump.flushNow(handlerTx);

    await expect(pump.snapshot(handlerTx)).resolves.toEqual(["snapshot"]);
  });

  test("observe after-cursors suppress already observed items", async () => {
    type Item = { id: string; payload: string };
    let call = 0;
    const pump = new BufferedDatabasePump<Item, unknown, Item>({
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

    const snapshot = await pump.snapshot(handlerTx);
    const observed: Item[] = [];
    const unsubscribe = pump.observe(
      (item) => {
        observed.push(item);
      },
      { after: snapshot },
    );
    await pump.flushNow(handlerTx);
    unsubscribe();

    expect(observed).toEqual([{ id: "row-3", payload: "third" }]);
  });

  test("passive observers do not start scheduler loops or database flushes", async () => {
    let flushCount = 0;
    const pump = new BufferedDatabasePump<string, unknown, string>({
      intervalMs: 1,
      flush: async () => {
        flushCount += 1;
        return { observedItems: [] };
      },
    });

    const unsubscribe = pump.observe(() => {});
    await sleep(10);

    assert(flushCount === 0);
    assert(pump.activeSchedulerLeaseCount() === 0);
    assert(pump.activeSchedulerLoopCount() === 0);
    unsubscribe();
  });

  test("observeWithReplay closes the gap between an initial snapshot and subscription", async () => {
    type Item = { id: string; payload: string };
    const pump = new BufferedDatabasePump<Item, unknown, Item>({
      flush: async () => ({ observedItems: [{ id: "row-1", payload: "initial" }] }),
      cursorForObservedItem: (item) => item.id,
    });

    const snapshot = await pump.snapshot(handlerTx);
    await pump.publishObserved([{ id: "row-2", payload: "published-before-subscribe" }]);
    const observed: Item[] = [];
    const unsubscribe = await pump.observeWithReplay(
      (item) => {
        observed.push(item);
      },
      { after: snapshot },
    );

    expect(observed).toEqual([{ id: "row-2", payload: "published-before-subscribe" }]);
    unsubscribe();
  });

  test("waitForObserved resolves with the first matching observed item", async () => {
    const pump = new BufferedDatabasePump<string, unknown, string>({
      flush: async () => ({ observedItems: [] }),
      intervalMs: 1,
    });

    const wait = pump.waitForObserved((item) => item === "match", { timeoutMs: 100 });
    await pump.publishObserved(["skip", "match", "later"]);

    assert((await wait) === "match");
    assert(pump.activeSchedulerLeaseCount() === 0);
  });

  test("waitForObserved replays items published after the caller's snapshot", async () => {
    type Item = { id: string; payload: string };
    const pump = new BufferedDatabasePump<Item, unknown, Item>({
      flush: async () => ({ observedItems: [{ id: "row-1", payload: "old" }] }),
      cursorForObservedItem: (item) => item.id,
    });
    const snapshot = await pump.snapshot(handlerTx);
    await pump.publishObserved([{ id: "row-2", payload: "new" }]);

    await expect(
      pump.waitForObserved((item) => item.payload === "new", {
        after: snapshot,
        timeoutMs: 100,
      }),
    ).resolves.toEqual({ id: "row-2", payload: "new" });
  });

  test("waitForObserved respects after-cursors", async () => {
    type Item = { id: string; payload: string };
    const pump = new BufferedDatabasePump<Item, unknown, Item>({
      flush: async () => ({ observedItems: [] }),
      cursorForObservedItem: (item) => item.id,
      intervalMs: 1,
    });
    const snapshot = [{ id: "row-1", payload: "old" }];

    const wait = pump.waitForObserved((item) => item.payload === "new", {
      after: snapshot,
      timeoutMs: 100,
    });
    await pump.publishObserved([
      { id: "row-1", payload: "old replay" },
      { id: "row-2", payload: "new" },
    ]);

    await expect(wait).resolves.toEqual({ id: "row-2", payload: "new" });
  });

  test("waitForObserved rejects on timeout and unsubscribes", async () => {
    const pump = new BufferedDatabasePump<string, unknown, string>({
      flush: async () => ({ observedItems: [] }),
      intervalMs: 1,
    });

    await expect(
      pump.waitForObserved((item) => item === "never", {
        timeoutMs: 5,
        timeoutMessage: "no matching item",
      }),
    ).rejects.toMatchObject({
      name: "BufferedPumpObserveTimeoutError",
      message: "no matching item",
      timeoutMs: 5,
    } satisfies Partial<BufferedPumpObserveTimeoutError>);
    assert(pump.activeSchedulerLeaseCount() === 0);
  });

  test("publishObserved appends only newly observed items to snapshots", async () => {
    type Item = { id: string; payload: string };
    const pump = new BufferedDatabasePump<Item, unknown, Item>({
      flush: async () => ({ observedItems: [{ id: "row-1", payload: "first" }] }),
      cursorForObservedItem: (item) => item.id,
    });
    const observed: Item[] = [];
    pump.observe((item) => {
      observed.push(item);
    });

    await pump.flushNow(handlerTx);
    await pump.publishObserved([
      { id: "row-1", payload: "stale" },
      { id: "row-2", payload: "second" },
      { id: "row-2", payload: "duplicate" },
    ]);

    expect(observed).toEqual([
      { id: "row-1", payload: "first" },
      { id: "row-2", payload: "second" },
    ]);
    await expect(pump.snapshot(handlerTx)).resolves.toEqual([
      { id: "row-1", payload: "first" },
      { id: "row-2", payload: "second" },
    ]);
  });

  test("flush failures restore drained outgoing buffers and rethrow", async () => {
    const errors: unknown[] = [];
    let shouldFail = true;
    const pump = new BufferedDatabasePump({
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
    await expect(pump.flushNow(handlerTx)).rejects.toThrow("flush failed");

    shouldFail = false;
    await pump.flushNow(handlerTx);

    expect(errors).toHaveLength(1);
    expect(observed).toEqual(["after-retry"]);
    expect(pump.getFailure()).toBeUndefined();
  });

  test("normalizes non-Error flush failures at the pump boundary", async () => {
    const errors: Error[] = [];
    const pump = new BufferedDatabasePump({
      flush: async () => {
        // oxlint-disable-next-line typescript/only-throw-error -- This regression test verifies normalization at the pump boundary.
        throw "primitive failure";
      },
      onError: (error) => {
        errors.push(error);
      },
    });

    await expect(pump.flushNow(handlerTx)).rejects.toThrow("primitive failure");

    expect(errors).toEqual([expect.any(Error)]);
    expect(pump.getFailure()).toEqual(expect.any(Error));
  });

  test("integration: flush uses a real sqlite handlerTx to read and write scoped outgoing items", async () => {
    const { fragment, cleanup } = await buildSqlitePumpIntegration();
    let pump: { drain(): Promise<void> } | undefined;

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
        await createdPump.flushNow(this.handlerTx);
        observed.length = 0;

        scope.enqueueOutgoing((view: BufferedItemContext) => ({
          kind: "outgoing",
          scopeKey: "scope-a",
          payload: { message: "from-scope", previousForScope: view.outgoingFor("scope-a").length },
        }));
        await createdPump.flushNow(this.handlerTx);

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
      await pump?.drain();
      await cleanup();
    }
  });
});
