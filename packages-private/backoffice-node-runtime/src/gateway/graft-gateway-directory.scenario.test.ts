import { afterAll, beforeAll, expect, test } from "vitest";

import { randomUUID } from "node:crypto";

import { GraftControlStore } from "@fragno-private/backoffice-node-runtime/graft-control-store";
import { createSqlitePragmaGraftDatabaseOperations } from "@fragno-private/backoffice-node-runtime/graft-database-operations";
import { startGraftGatewayDirectory } from "@fragno-private/backoffice-node-runtime/graft-gateway-directory";
import { openClonedGraftDatabase } from "@fragno-private/backoffice-node-runtime/graft-sqlite";
import { createNodeRuntimeScenarioEnvironment } from "@fragno-private/backoffice-node-runtime/node-runtime-scenario";

let environment: Awaited<ReturnType<typeof createNodeRuntimeScenarioEnvironment>>;
beforeAll(async () => {
  environment = await createNodeRuntimeScenarioEnvironment();
});
afterAll(async () => {
  await environment.cleanup();
});

test("background discovery discards a previously usable snapshot when refreshed control history becomes invalid", async () => {
  const storage = environment.createStorage();
  const store = new GraftControlStore(storage);
  const lease = {
    nodeId: randomUUID(),
    processGeneration: randomUUID(),
    applicationOrigin: "http://127.0.0.1:8080",
    privateAddress: "ws://127.0.0.1:8080/peer",
    compatibilityVersion: 1,
    renewalId: randomUUID(),
    expiresAtMs: Date.now() + 60_000,
  };
  store.registerNode({ commandId: randomUUID(), commandCreatedAtMs: Date.now(), input: { lease } });
  const directory = startGraftGatewayDirectory(storage);
  try {
    await expect.poll(() => directory.readLiveWorkers()).toEqual([lease]);
    const operations = createSqlitePragmaGraftDatabaseOperations();
    const writer = openClonedGraftDatabase(randomUUID(), storage.controlRemoteLogId, operations);
    try {
      writer.exec("UPDATE node_runtime_control_format SET format = 999");
      operations.push(writer);
      // Allow a scheduled worker refresh under suite load, without waiting out the five-second stale limit.
      await expect.poll(() => directory.readLiveWorkers(), { timeout: 4_000 }).toEqual([]);
    } finally {
      writer.close();
    }
  } finally {
    await Promise.all([directory.close(), directory.close()]);
    store.close();
  }
  expect(directory.readLiveWorkers()).toEqual([]);
});

test("background discovery excludes expired leases without modifying the control log", async () => {
  const storage = environment.createStorage();
  const store = new GraftControlStore(storage);
  const live = {
    nodeId: randomUUID(),
    processGeneration: randomUUID(),
    applicationOrigin: "http://127.0.0.1:8080",
    privateAddress: "ws://127.0.0.1:8080/peer",
    compatibilityVersion: 1,
    renewalId: randomUUID(),
    expiresAtMs: Date.now() + 60_000,
  };
  const expired = { ...live, nodeId: randomUUID(), expiresAtMs: Date.now() - 1_000 };
  for (const lease of [expired, live]) {
    store.registerNode({
      commandId: randomUUID(),
      commandCreatedAtMs: Date.now() - 2_000,
      input: { lease },
    });
  }
  const directory = startGraftGatewayDirectory(storage);
  try {
    await expect.poll(() => directory.readLiveWorkers()).toEqual([live]);
    expect(store.readNodeLease(expired.nodeId)).toEqual(expired);
    expect(store.readNodeLease(live.nodeId)).toEqual(live);
  } finally {
    await directory.close();
    store.close();
  }
});
