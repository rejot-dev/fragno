import { afterAll, beforeAll, expect, test, assert } from "vitest";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  GraftControlStore,
  type GraftNodeLease,
} from "@fragno-private/backoffice-node-runtime/graft-control-store";
import { createSqlitePragmaGraftDatabaseOperations } from "@fragno-private/backoffice-node-runtime/graft-database-operations";
import { createManualNodeRuntimeClock } from "@fragno-private/backoffice-node-runtime/node-runtime-clock";
import { createNodeRuntimeScenarioEnvironment } from "@fragno-private/backoffice-node-runtime/node-runtime-scenario";

import { ControlScenarioGraftOperations } from "../testing/fixtures/control-scenario-graft-operations";

let environment: Awaited<ReturnType<typeof createNodeRuntimeScenarioEnvironment>>;
beforeAll(async () => {
  environment = await createNodeRuntimeScenarioEnvironment();
});
afterAll(async () => {
  await environment.cleanup();
});

function nodeLease(): GraftNodeLease {
  return {
    nodeId: randomUUID(),
    processGeneration: randomUUID(),
    privateAddress: "ws://127.0.0.1:1/peer",
    applicationOrigin: "http://127.0.0.1:1",
    compatibilityVersion: 1,
    expiresAtMs: 2_000,
    renewalId: randomUUID(),
  };
}

function renewalCommand(lease: GraftNodeLease, expiresAtMs: number) {
  return {
    commandId: randomUUID(),
    commandCreatedAtMs: 1_100,
    input: {
      nodeId: lease.nodeId,
      processGeneration: lease.processGeneration,
      expectedRenewalId: lease.renewalId,
      nextRenewalId: randomUUID(),
      attemptedAtMs: 1_100,
      expiresAtMs,
    },
  };
}

test("one clean control replica observes independent writes without creating another volume", () => {
  const storage = environment.createStorage();
  const operations = new ControlScenarioGraftOperations(createManualNodeRuntimeClock(1_000));
  const reader = new GraftControlStore(storage, operations);
  const writer = new GraftControlStore(storage);
  const lease = nodeLease();
  try {
    expect(reader.readNodeLease(lease.nodeId)).toBeNull();
    writer.registerNode({ commandId: randomUUID(), commandCreatedAtMs: 1_000, input: { lease } });
    expect(reader.readNodeLease(lease.nodeId)).toEqual(lease);
    const renewed = writer.renewNodeLease(renewalCommand(lease, 3_000));
    assert(renewed.outcome === "renewed");
    expect(reader.readNodeLease(lease.nodeId)).toMatchObject({ expiresAtMs: 3_000 });
    expect(operations.counts).toEqual({ clones: 1, pulls: 3, pushes: 0 });
    const database = operations.connections[0];
    expect(database.prepare("PRAGMA query_only").get()).toEqual({ query_only: 1 });
    expect(() => database.exec("DELETE FROM node_runtime_node_lease")).toThrow(/readonly/);
    expect(reader.readNodeLease(lease.nodeId)).toMatchObject({ expiresAtMs: 3_000 });
  } finally {
    reader.close();
    writer.close();
  }
  expect(() => operations.connections[0].prepare("SELECT 1")).toThrow();
  expect(() => reader.readNodeLease(lease.nodeId)).toThrow("GRAFT_CONTROL_STORE_CLOSED");
});

test("a retained reader observes another process's commits from an independent native cache", async () => {
  const storage = environment.createStorage();
  const operations = new ControlScenarioGraftOperations(createManualNodeRuntimeClock(1_000));
  const reader = new GraftControlStore(storage, operations);
  const lease = nodeLease();
  const directory = await mkdtemp(path.join(path.dirname(storage.configPath), "remote-writer-"));
  const cache = path.join(directory, "cache");
  const configPath = path.join(directory, "graft.toml");
  await mkdir(cache);
  await writeFile(
    configPath,
    (await readFile(storage.configPath, "utf8")).replace(
      /^data_dir = .*$/m,
      `data_dir = ${JSON.stringify(cache)}`,
    ),
  );
  const fixture = new URL("../testing/fixtures/graft-control-store-process.ts", import.meta.url);
  async function execute(invocation: unknown) {
    await promisify(execFile)(process.execPath, [
      fixture.pathname,
      "execute",
      configPath,
      storage.controlRemoteLogId,
      JSON.stringify(invocation),
    ]);
  }
  try {
    expect(reader.readNodeLease(lease.nodeId)).toBeNull();
    await execute({
      operation: "register-node",
      pushBehavior: "normal",
      command: { commandId: randomUUID(), commandCreatedAtMs: 1_000, input: { lease } },
    });
    expect(reader.readNodeLease(lease.nodeId)).toEqual(lease);
    await execute({
      operation: "renew-node-lease",
      pushBehavior: "lose-response-after-commit",
      command: renewalCommand(lease, 3_000),
    });
    expect(reader.readNodeLease(lease.nodeId)).toMatchObject({ expiresAtMs: 3_000 });
    expect(operations.counts).toEqual({ clones: 1, pulls: 3, pushes: 0 });
  } finally {
    reader.close();
  }
});

test.each(["before-pull", "after-pull"] as const)(
  "a %s failure discards the replica rather than serving its stale lease",
  (failure) => {
    const storage = environment.createStorage();
    const operations = new ControlScenarioGraftOperations(createManualNodeRuntimeClock(1_000));
    const reader = new GraftControlStore(storage, operations);
    const writer = new GraftControlStore(storage);
    const lease = nodeLease();
    try {
      writer.registerNode({ commandId: randomUUID(), commandCreatedAtMs: 1_000, input: { lease } });
      expect(reader.readNodeLease(lease.nodeId)).toEqual(lease);
      writer.renewNodeLease(renewalCommand(lease, 3_000));
      operations.pullFailure = failure;
      expect(() => reader.readNodeLease(lease.nodeId)).toThrow("EXPECTED_CONTROL_PULL_FAILURE");
      expect(() => operations.connections[0].prepare("SELECT 1")).toThrow();
      operations.pullFailure = "none";
      expect(reader.readNodeLease(lease.nodeId)).toMatchObject({ expiresAtMs: 3_000 });
      expect(operations.counts).toEqual({ clones: 2, pulls: 3, pushes: 0 });
    } finally {
      reader.close();
      writer.close();
    }
  },
);

test("read snapshots stay clean across uncertain commands and receipt-backed retries", () => {
  const operations = new ControlScenarioGraftOperations(createManualNodeRuntimeClock(1_000));
  const store = new GraftControlStore(environment.createStorage(), operations, 2);
  const lease = nodeLease();
  try {
    expect(store.readNodeLease(lease.nodeId)).toBeNull();
    const readConnection = operations.connections[0];
    const registration = { commandId: randomUUID(), commandCreatedAtMs: 1_000, input: { lease } };
    operations.pushFailure = "before-push";
    expect(() => store.registerNode(registration)).toThrow(
      "GRAFT_CONTROL_COMMAND_DURABILITY_UNCERTAIN",
    );
    expect(store.readNodeLease(lease.nodeId)).toBeNull();
    const clonesAfterFailure = operations.counts.clones;
    operations.pushFailure = "none";
    assert(store.registerNode(registration).outcome === "registered");
    expect(store.readNodeLease(lease.nodeId)).toEqual(lease);
    expect(operations.counts.clones).toBe(clonesAfterFailure + 1);

    const renewal = renewalCommand(lease, 3_000);
    operations.pushFailure = "lose-response";
    const renewed = store.renewNodeLease(renewal);
    assert(renewed.outcome === "renewed");
    const pushesAfterRenewal = operations.counts.pushes;
    expect(store.readNodeLease(lease.nodeId)).toMatchObject({ expiresAtMs: 3_000 });
    expect(store.renewNodeLease(renewal)).toEqual(renewed);
    expect(operations.counts.pushes).toBe(pushesAfterRenewal);
    expect(readConnection.prepare("PRAGMA query_only").get()).toEqual({ query_only: 1 });
    expect(
      readConnection.prepare("SELECT expires_at_ms FROM node_runtime_node_lease").get(),
    ).toEqual({
      expires_at_ms: 3_000,
    });
  } finally {
    store.close();
  }
  for (const database of operations.connections) {
    expect(() => database.prepare("SELECT 1")).toThrow();
  }
});

test("a refreshed unsupported schema fails closed instead of using the previous snapshot", () => {
  const storage = environment.createStorage();
  const operations = new ControlScenarioGraftOperations(createManualNodeRuntimeClock(1_000));
  const reader = new GraftControlStore(storage, operations);
  const writerOperations = new ControlScenarioGraftOperations(createManualNodeRuntimeClock(1_000));
  const writer = new GraftControlStore(storage, writerOperations);
  const lease = nodeLease();
  try {
    writer.registerNode({ commandId: randomUUID(), commandCreatedAtMs: 1_000, input: { lease } });
    expect(reader.readNodeLease(lease.nodeId)).toEqual(lease);
    const schemaWriter = writerOperations.connections[0];
    schemaWriter.exec("UPDATE node_runtime_control_format SET format = 999");
    createSqlitePragmaGraftDatabaseOperations().push(schemaWriter);
    expect(() => reader.readNodeLease(lease.nodeId)).toThrow(
      "GRAFT_CONTROL_FORMAT_UNSUPPORTED:999",
    );
    expect(() => operations.connections[0].prepare("SELECT 1")).toThrow();
  } finally {
    reader.close();
    writer.close();
  }
});
