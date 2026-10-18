import { afterAll, beforeAll, expect, test, assert } from "vitest";

import { randomUUID } from "node:crypto";

import { GraftControlStore } from "@fragno-private/backoffice-node-runtime/graft-control-store";
import {
  createSqlitePragmaGraftDatabaseOperations,
  defineGraftDatabaseOperations,
} from "@fragno-private/backoffice-node-runtime/graft-database-operations";
import { createAuthorityBoundGraftNodeObjectRuntimeWithDatabaseOperations } from "@fragno-private/backoffice-node-runtime/node-object-runtime";
import { createManualNodeRuntimeClock } from "@fragno-private/backoffice-node-runtime/node-runtime-clock";
import { defineNodeRuntimeObject } from "@fragno-private/backoffice-node-runtime/node-runtime-object";
import {
  createNodeRuntimeScenarioEnvironment,
  createNodeRuntimeScenarioRuntime,
} from "@fragno-private/backoffice-node-runtime/node-runtime-scenario";

import type { createDialectTransactionObject } from "../testing/fixtures/node-dialect-transaction.objects";
import type { createTransactionObject } from "../testing/fixtures/node-transaction.objects";

const transactionObject = defineNodeRuntimeObject<typeof createTransactionObject>(
  new URL("../testing/fixtures/node-transaction.objects.ts", import.meta.url),
  "createTransactionObject",
);
let environment: Awaited<ReturnType<typeof createNodeRuntimeScenarioEnvironment>>;
beforeAll(async () => {
  environment = await createNodeRuntimeScenarioEnvironment();
});
afterAll(async () => {
  await environment.cleanup();
});

function createTransactionRuntime(storage = environment.createStorage()) {
  const clock = createManualNodeRuntimeClock(0);
  const runtime = createNodeRuntimeScenarioRuntime({
    storage,
    clock: clock.source,
    objects: { TRANSACTIONS: transactionObject },
    objectEviction: { kind: "disabled" },
  });
  return { runtime, storage, clock };
}

function createDialectRuntime(storage = environment.createStorage()) {
  const clock = createManualNodeRuntimeClock(0);
  const runtime = createNodeRuntimeScenarioRuntime({
    storage,
    clock: clock.source,
    objects: {
      DIALECT: defineNodeRuntimeObject<typeof createDialectTransactionObject>(
        new URL("../testing/fixtures/node-dialect-transaction.objects.ts", import.meta.url),
        "createDialectTransactionObject",
      ),
    },
    objectEviction: { kind: "disabled" },
  });
  return { runtime, storage };
}

test("SQL, KV, and alarms commit together and roll back together across worker restarts", async () => {
  const { runtime, storage } = createTransactionRuntime();
  const control = new GraftControlStore(storage);
  try {
    using object = runtime.objects.TRANSACTIONS.get("one");
    await object.change(1, false, 100);
    await expect(object.change(2, true, 200)).rejects.toThrow("EXPECTED_TRANSACTION_ROLLBACK");
    await expect(object.changeSync(20, true)).rejects.toThrow("EXPECTED_SYNC_TRANSACTION_ROLLBACK");
    await expect(object.cancelAlarm(true)).rejects.toThrow("EXPECTED_TRANSACTION_ROLLBACK");
    assert((await object.rollbackExplicitly()) === "cancelled");
    expect(await object.inspect()).toEqual({ values: [1], value: 1, alarm: 100, delivered: 0 });
    expect(control.readObjectAlarmWork("TRANSACTIONS:one")).toMatchObject({
      kind: "scheduled",
      dueAtMs: 100,
    });
  } finally {
    control.close();
    await runtime.cleanup();
  }
  const restored = createTransactionRuntime(storage);
  try {
    using object = restored.runtime.objects.TRANSACTIONS.get("one");
    expect(await object.inspect()).toEqual({ values: [1], value: 1, alarm: 100, delivered: 0 });
    await object.changeSync(3, false);
    await object.cancelAlarm(false);
    expect(await object.inspect()).toEqual({
      values: [1, 3, 4],
      value: 99,
      alarm: null,
      delivered: 0,
    });
  } finally {
    await restored.runtime.cleanup();
  }
});

test("new handlers and already-admitted asynchronous reads wait for transaction rollback", async () => {
  const { runtime } = createTransactionRuntime();
  const readEntered = Promise.withResolvers<void>();
  const releaseRead = Promise.withResolvers<void>();
  const attemptedRead = Promise.withResolvers<void>();
  const transactionEntered = Promise.withResolvers<void>();
  const releaseTransaction = Promise.withResolvers<void>();
  const calls: Promise<unknown>[] = [];
  try {
    using object = runtime.objects.TRANSACTIONS.get("one");
    await object.change(1, false, null);
    const admittedRead = Promise.resolve(
      object.readAfterBarrier(
        async () => {
          readEntered.resolve();
          await releaseRead.promise;
        },
        async () => {
          attemptedRead.resolve();
        },
      ),
    );
    calls.push(admittedRead);
    await readEntered.promise;
    const transaction = Promise.resolve(
      object.holdTransaction(
        2,
        async () => {
          transactionEntered.resolve();
          await releaseTransaction.promise;
        },
        true,
      ),
    );
    // Attach rejection handling before deliberately holding the callback open.
    const rejected = expect(transaction).rejects.toThrow("EXPECTED_TRANSACTION_ROLLBACK");
    calls.push(rejected);
    await transactionEntered.promise;
    releaseRead.resolve();
    const newRead = Promise.resolve(object.inspect());
    calls.push(newRead);
    releaseTransaction.resolve();
    await rejected;
    await attemptedRead.promise;
    assert((await admittedRead) === 1);
    expect(await newRead).toEqual({ values: [1], value: 1, alarm: null, delivered: 0 });
  } finally {
    releaseRead.resolve();
    releaseTransaction.resolve();
    await Promise.allSettled(calls);
    await runtime.cleanup();
  }
});

test("already-admitted synchronous SQL resumes only after another handler commits", async () => {
  const { runtime } = createTransactionRuntime();
  const readEntered = Promise.withResolvers<void>();
  const releaseRead = Promise.withResolvers<void>();
  const attemptedRead = Promise.withResolvers<void>();
  const transactionEntered = Promise.withResolvers<void>();
  const releaseTransaction = Promise.withResolvers<void>();
  const calls: Promise<unknown>[] = [];
  try {
    using object = runtime.objects.TRANSACTIONS.get("one");
    const read = Promise.resolve(
      object.readSqlAfterBarrier(
        async () => {
          readEntered.resolve();
          await releaseRead.promise;
        },
        async () => {
          attemptedRead.resolve();
        },
      ),
    );
    calls.push(read);
    await readEntered.promise;
    const transaction = Promise.resolve(
      object.holdTransaction(
        2,
        async () => {
          transactionEntered.resolve();
          await releaseTransaction.promise;
        },
        false,
      ),
    );
    calls.push(transaction);
    await transactionEntered.promise;
    releaseRead.resolve();
    releaseTransaction.resolve();
    await transaction;
    await attemptedRead.promise;
    expect(await read).toEqual([{ value: 2 }]);
    expect(await object.inspect()).toEqual({ values: [2], value: 2, alarm: null, delivered: 0 });
  } finally {
    releaseRead.resolve();
    releaseTransaction.resolve();
    await Promise.allSettled(calls);
    await runtime.cleanup();
  }
});

test("transactions serialize without blocking another object's worker", async () => {
  const { runtime } = createTransactionRuntime();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const calls: Promise<unknown>[] = [];
  try {
    using object = runtime.objects.TRANSACTIONS.get("one");
    using other = runtime.objects.TRANSACTIONS.get("other");
    const first = Promise.resolve(
      object.holdTransaction(
        1,
        async () => {
          entered.resolve();
          await release.promise;
        },
        false,
      ),
    );
    calls.push(first);
    await entered.promise;
    const second = Promise.resolve(object.change(2, false, null));
    calls.push(second);
    await other.change(7, false, null);
    expect(await other.inspect()).toMatchObject({ values: [7], value: 7 });
    release.resolve();
    await Promise.all([first, second]);
    expect(await object.inspect()).toMatchObject({ values: [1, 2], value: 2 });
  } finally {
    release.resolve();
    await Promise.allSettled(calls);
    await runtime.cleanup();
  }
});

test("transactional alarm re-arms survive completion of the old installation", async () => {
  const { runtime, clock, storage } = createTransactionRuntime();
  try {
    using object = runtime.objects.TRANSACTIONS.get("one");
    await object.change(1, false, 0);
    await runtime.tick();
    expect(await object.inspect()).toMatchObject({ alarm: 10, delivered: 1 });
  } finally {
    await runtime.cleanup();
  }
  const restored = createTransactionRuntime(storage);
  try {
    restored.clock.advanceBy(clock.nowEpochMs() + 10);
    await restored.runtime.tick();
    using object = restored.runtime.objects.TRANSACTIONS.get("one");
    expect(await object.inspect()).toMatchObject({ alarm: null, delivered: 2 });
  } finally {
    await restored.runtime.cleanup();
  }
});

test("transactional alarm changes stay private until commit and failed callbacks leave discovery unchanged", async () => {
  const { runtime, storage } = createTransactionRuntime();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let settled: Promise<unknown> = Promise.resolve();
  const control = new GraftControlStore(storage);
  try {
    using object = runtime.objects.TRANSACTIONS.get("one");
    await object.change(1, false, 100);
    const pending = Promise.resolve(
      object.holdAlarmChange(
        200,
        async () => {
          entered.resolve();
          await release.promise;
        },
        true,
      ),
    );
    settled = expect(pending).rejects.toThrow("EXPECTED_TRANSACTION_ROLLBACK");
    await entered.promise;
    expect(control.readObjectAlarmWork("TRANSACTIONS:one")).toMatchObject({
      kind: "scheduled",
      dueAtMs: 100,
    });
    release.resolve();
    await settled;
    expect(control.readObjectAlarmWork("TRANSACTIONS:one")).toMatchObject({
      kind: "scheduled",
      dueAtMs: 100,
    });
    expect(await object.inspect()).toMatchObject({ alarm: 100 });
  } finally {
    release.resolve();
    await settled;
    control.close();
    await runtime.cleanup();
  }
});

test("continuations inherited from a completed transaction cannot mutate storage", async () => {
  const { runtime } = createTransactionRuntime();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let settled: Promise<unknown> = Promise.resolve();
  try {
    using object = runtime.objects.TRANSACTIONS.get("one");
    const pending = Promise.resolve(
      object.staleContinuation(async () => {
        entered.resolve();
        await release.promise;
      }),
    );
    settled = pending.catch(() => {});
    await entered.promise;
    // This new event passes admission only after the callback's transaction has committed.
    expect(await object.inspect()).toMatchObject({ value: null });
    release.resolve();
    assert((await pending) === "NODE_RUNTIME_OBJECT_DATABASE_TRANSACTION_CLOSED");
    expect(await object.inspect()).toMatchObject({ value: null });
  } finally {
    release.resolve();
    await settled;
    await runtime.cleanup();
  }
});

test("the existing Fragno dialect shares operation-owned transactions with ordinary SQL, KV, and alarms", async () => {
  const { runtime, storage } = createDialectRuntime();
  try {
    using object = runtime.objects.DIALECT.get("one");
    await object.change(1, false);
    await expect(object.change(2, true)).rejects.toThrow("EXPECTED_DIALECT_ROLLBACK");
    expect(await object.inspect()).toEqual({
      values: [{ value: 1 }],
      value: 1,
      count: 1,
      alarm: 100,
    });
    await object.change(3, false);
    assert((await object.streamTransaction(4)) === 8);
    // The second begin runs outside the storage callback, but still belongs to the owning operation.
    await expect(object.nestedTransaction()).rejects.toThrow(
      "NODE_RUNTIME_OBJECT_DATABASE_NESTED_TRANSACTION",
    );
    expect(await object.inspect()).toEqual({
      values: [{ value: 1 }, { value: 3 }, { value: 4 }],
      value: 4,
      count: 3,
      alarm: 400,
    });
  } finally {
    await runtime.cleanup();
  }
  const restored = createDialectRuntime(storage);
  try {
    using object = restored.runtime.objects.DIALECT.get("one");
    expect(await object.inspect()).toEqual({
      values: [{ value: 1 }, { value: 3 }, { value: 4 }],
      value: 4,
      count: 3,
      alarm: 400,
    });
  } finally {
    await restored.runtime.cleanup();
  }
});

test.each(["direct", "gated"] as const)(
  "%s Kysely continuations own their transaction without admitting other handlers' SQL or KV",
  async (boundary) => {
    const { runtime } = createDialectRuntime();
    const sqlEntered = Promise.withResolvers<void>();
    const kvEntered = Promise.withResolvers<void>();
    const releaseReads = Promise.withResolvers<void>();
    const sqlAttempted = Promise.withResolvers<void>();
    const kvAttempted = Promise.withResolvers<void>();
    const transactionEntered = Promise.withResolvers<void>();
    const releaseTransaction = Promise.withResolvers<void>();
    const calls: Promise<unknown>[] = [];
    const run = async () => {
      using object = runtime.objects.DIALECT.get("one");
      using other = runtime.objects.DIALECT.get("other");
      await object.change(1, false);
      const sqlRead = Promise.resolve(
        object.readSqlAfterBarrier(
          async () => {
            sqlEntered.resolve();
            await releaseReads.promise;
          },
          async () => {
            sqlAttempted.resolve();
          },
        ),
      );
      const kvRead = Promise.resolve(
        object.readKvAfterBarrier(
          async () => {
            kvEntered.resolve();
            await releaseReads.promise;
          },
          async () => {
            kvAttempted.resolve();
          },
        ),
      );
      calls.push(sqlRead, kvRead);
      await Promise.all([sqlEntered.promise, kvEntered.promise]);
      const transaction = Promise.resolve(
        object.holdTransaction(
          2,
          async () => {
            transactionEntered.resolve();
            await releaseTransaction.promise;
          },
          true,
        ),
      );
      const rejected = expect(transaction).rejects.toThrow("EXPECTED_DIALECT_ROLLBACK");
      calls.push(rejected);
      await transactionEntered.promise;
      const newRead = Promise.resolve(object.inspect());
      calls.push(newRead);
      releaseReads.resolve();
      await other.change(7, false);
      expect(await other.inspect()).toEqual({
        values: [{ value: 7 }],
        value: 7,
        count: 1,
        alarm: 700,
      });
      releaseTransaction.resolve();
      await rejected;
      await Promise.all([sqlAttempted.promise, kvAttempted.promise]);
      expect(await sqlRead).toEqual([{ value: 1 }]);
      assert((await kvRead) === 1);
      expect(await newRead).toEqual({ values: [{ value: 1 }], value: 1, count: 1, alarm: 100 });
    };
    try {
      await (boundary === "gated" ? runtime.runWithOutputGate(run) : run());
    } finally {
      releaseReads.resolve();
      releaseTransaction.resolve();
      await Promise.allSettled(calls);
      await runtime.cleanup();
    }
  },
);

test.each(["direct", "gated"] as const)(
  "%s outputs wait for an open transaction even when the owning handler returns",
  async (boundary) => {
    const { runtime } = createTransactionRuntime();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let outputDelivered = false;
    let settled: Promise<unknown> = Promise.resolve();
    try {
      using object = runtime.objects.TRANSACTIONS.get("one");
      using other = runtime.objects.TRANSACTIONS.get("other");
      await object.change(1, false, null);
      const call = async () => {
        using writer = runtime.objects.TRANSACTIONS.get("one");
        return await writer.startTransactionAndReturn(2, async () => {
          entered.resolve();
          await release.promise;
        });
      };
      const pending = (boundary === "gated" ? runtime.runWithOutputGate(call) : call()).then(
        (value) => {
          outputDelivered = true;
          return value;
        },
      );
      settled = pending.catch(() => {});
      await entered.promise;
      expect(await other.inspect()).toMatchObject({ values: [] });
      assert(!outputDelivered);
      release.resolve();
      assert((await pending) === 2);
      expect(await object.inspect()).toMatchObject({ values: [1, 2], value: 2 });
    } finally {
      release.resolve();
      await settled;
      await runtime.cleanup();
    }
  },
);

test.each([
  { phase: "before remote commit", behavior: 1, values: [1], alarm: 100 },
  { phase: "after remote commit", behavior: 2, values: [1, 2], alarm: 200 },
])(
  "a transactional alarm push failure $phase poisons local state and leaves recoverable discovery",
  async ({ behavior, values, alarm }) => {
    const storage = environment.createStorage();
    const clock = createManualNodeRuntimeClock(0);
    const nextPushBehavior = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const runtime = createAuthorityBoundGraftNodeObjectRuntimeWithDatabaseOperations({
      storage,
      clock: clock.source,
      objects: { TRANSACTIONS: transactionObject },
      nodeIdentity: {
        nodeId: randomUUID(),
        processGeneration: randomUUID(),
        privateAddress: "ws://127.0.0.1:1/node-object-peer",
        applicationOrigin: "http://127.0.0.1:1",
        compatibilityVersion: 1,
      },
      leasePolicy: {
        leaseDurationMs: 60_000,
        renewalIntervalMs: 10_000,
        renewalRetryIntervalMs: 1_000,
        selfFenceSafetyMarginMs: 5_000,
        maximumClockSkewMs: 0,
      },
      peerRpc: {
        authenticationSecret: "node-runtime-scenario-authentication-secret",
        authenticationWindowMs: 5_000,
      },
      objectProvisioning: { kind: "lazy" },
      objectEviction: { kind: "disabled" },
      databaseOperations: {
        control: createSqlitePragmaGraftDatabaseOperations(),
        provisioning: createSqlitePragmaGraftDatabaseOperations(),
        worker: defineGraftDatabaseOperations(
          new URL("../testing/fixtures/graft-database-operations.ts", import.meta.url),
          "createControlledGraftDatabaseOperations",
          {
            pushCounter: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
            nextPushBehavior: nextPushBehavior.buffer,
          },
        ),
      },
    });
    const control = new GraftControlStore(storage);
    try {
      using object = runtime.objects.TRANSACTIONS.get("one");
      await object.change(1, false, 100);
      Atomics.store(nextPushBehavior, 0, behavior);
      await expect(object.change(2, false, 200)).rejects.toThrow(
        "NODE_RUNTIME_OBJECT_DATABASE_POISONED",
      );
      await expect(object.inspect()).rejects.toThrow("NODE_RUNTIME_OBJECT_DATABASE_POISONED");
      expect(control.readObjectAlarmWork("TRANSACTIONS:one")).toMatchObject({ kind: "reconcile" });
    } finally {
      control.close();
      // The poisoned activation cannot promise a graceful durability flush or release its object claim.
      await runtime.cleanup().catch(() => {});
    }
    clock.advanceBy(60_000);
    const restored = createNodeRuntimeScenarioRuntime({
      storage,
      clock: clock.source,
      objects: { TRANSACTIONS: transactionObject },
      objectEviction: { kind: "disabled" },
    });
    const restoredControl = new GraftControlStore(storage);
    try {
      using object = restored.objects.TRANSACTIONS.get("one");
      expect(await object.inspect()).toEqual({ values, value: values.at(-1), alarm, delivered: 0 });
      expect(restoredControl.readObjectAlarmWork("TRANSACTIONS:one")).toMatchObject({
        kind: "scheduled",
        dueAtMs: alarm,
      });
    } finally {
      restoredControl.close();
      await restored.cleanup();
    }
  },
);

test("transaction handles close after commit while ordinary SQL remains usable across transactions", async () => {
  const { runtime } = createTransactionRuntime();
  try {
    using object = runtime.objects.TRANSACTIONS.get("one");
    await expect(object.invalidSyncCallback()).rejects.toThrow(
      "NODE_RUNTIME_OBJECT_DATABASE_ASYNC_TRANSACTION",
    );
    await object.retainTransaction();
    await expect(object.useRetainedTransaction()).rejects.toThrow(
      "NODE_RUNTIME_OBJECT_DATABASE_TRANSACTION_HANDLE_CLOSED",
    );
    await expect(object.nestedTransaction()).rejects.toThrow(
      "NODE_RUNTIME_OBJECT_DATABASE_NESTED_TRANSACTION",
    );
    expect(await object.inspect()).toMatchObject({ values: [], value: null });
    expect(await object.kvShape()).toEqual({ missing: [["one", 1]], deleted: 2 });
    await object.useRetainedSql();
    expect(await object.inspect()).toMatchObject({ values: [999], value: null });
  } finally {
    await runtime.cleanup();
  }
});
