import { afterAll, beforeAll, expect, test, assert } from "vitest";

import { GraftControlStore } from "@fragno-private/backoffice-node-runtime/graft-control-store";
import { createManualNodeRuntimeClock } from "@fragno-private/backoffice-node-runtime/node-runtime-clock";
import { defineNodeRuntimeObject } from "@fragno-private/backoffice-node-runtime/node-runtime-object";
import {
  createNodeRuntimeScenarioEnvironment,
  createNodeRuntimeScenarioRuntime,
} from "@fragno-private/backoffice-node-runtime/node-runtime-scenario";

import type {
  createDependencyLedgerObject,
  createDependencyReceiptObject,
} from "../testing/fixtures/node-object-dependencies.objects";

const moduleUrl = new URL(
  "../testing/fixtures/node-object-dependencies.objects.ts",
  import.meta.url,
);
const receiptDefinition = defineNodeRuntimeObject<typeof createDependencyReceiptObject>(
  moduleUrl,
  "createDependencyReceiptObject",
);
let environment: Awaited<ReturnType<typeof createNodeRuntimeScenarioEnvironment>>;
beforeAll(async () => {
  environment = await createNodeRuntimeScenarioEnvironment();
});
afterAll(async () => {
  await environment.cleanup();
});

test("worker-local factories consume cloned configuration and call another object during initialization and RPC", async () => {
  const configuration = { receiptBinding: "RECEIPTS", prefix: "receipt-" };
  const ledgerDefinition = defineNodeRuntimeObject<typeof createDependencyLedgerObject>(
    moduleUrl,
    "createDependencyLedgerObject",
    configuration,
  );
  configuration.prefix = "changed-after-definition-";
  const storage = environment.createStorage();
  const clock = createManualNodeRuntimeClock(0);
  const objects = { LEDGERS: ledgerDefinition, RECEIPTS: receiptDefinition };
  const runtime = createNodeRuntimeScenarioRuntime({
    storage,
    clock: clock.source,
    objects,
    objectEviction: { kind: "disabled" },
  });
  try {
    using ledger = runtime.objects.LEDGERS.get("one");
    using receipt = runtime.objects.RECEIPTS.get("receipt-one");
    expect(await receipt.read()).toMatchObject({ message: null });
    expect(await ledger.inspect()).toMatchObject({ receipt: { message: "initialized in worker" } });
    const published = await ledger.publish("persisted through worker-to-host RPC");
    assert(published.receipt.message === "persisted through worker-to-host RPC");
    assert(published.name === "one");
    expect(published.receipt.threadId).not.toBe(published.ledgerThreadId);
    expect(await receipt.read()).toEqual(published.receipt);
    await expect(ledger.unknownBinding()).rejects.toThrow(
      "NODE_OBJECT_RUNTIME_OBJECT_ADDRESS_INVALID",
    );
    const control = new GraftControlStore(storage);
    try {
      expect(control.readObjectLocation("MISSING:one")).toBeNull();
    } finally {
      control.close();
    }
  } finally {
    await runtime.cleanup();
  }
  const restored = createNodeRuntimeScenarioRuntime({
    storage,
    clock: clock.source,
    objects,
    objectEviction: { kind: "disabled" },
  });
  try {
    using ledger = restored.objects.LEDGERS.get("one");
    expect(await ledger.inspect()).toMatchObject({
      lastPublished: "persisted through worker-to-host RPC",
      receipt: { message: "persisted through worker-to-host RPC" },
    });
  } finally {
    await restored.cleanup();
  }
});

test("worker-local dependencies forward HTTP bodies and responses through the same object route", async () => {
  const ledgerDefinition = defineNodeRuntimeObject<typeof createDependencyLedgerObject>(
    moduleUrl,
    "createDependencyLedgerObject",
    { receiptBinding: "RECEIPTS", prefix: "http:" },
  );
  const runtime = createNodeRuntimeScenarioRuntime({
    storage: environment.createStorage(),
    clock: createManualNodeRuntimeClock(0).source,
    objects: { LEDGERS: ledgerDefinition, RECEIPTS: receiptDefinition },
    objectEviction: { kind: "disabled" },
  });
  try {
    using ledger = runtime.objects.LEDGERS.get("one");
    assert((await ledger.publishHttp("streamed request")) === "POST:streamed request");
    using receipt = runtime.objects.RECEIPTS.get("http:one");
    expect(await receipt.read()).toMatchObject({ message: "streamed request" });
  } finally {
    await runtime.cleanup();
  }
});

test("non-cloneable factory inputs fail before starting a worker", () => {
  expect(() =>
    defineNodeRuntimeObject<typeof createDependencyLedgerObject>(
      moduleUrl,
      "createDependencyLedgerObject",
      {
        receiptBinding: "RECEIPTS",
        prefix: (() => "not configuration") as unknown as string,
      },
    ),
  ).toThrow("NODE_RUNTIME_OBJECT_INPUT_NOT_CLONEABLE");
});
