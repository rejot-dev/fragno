import { afterAll, assert, beforeAll, expect, test } from "vitest";

import { GraftControlStore } from "../graft/graft-control-store";
import { createSqlitePragmaGraftDatabaseOperations } from "../graft/graft-database-operations";
import { prepareGraftObjectActivation } from "../graft/graft-object-activation";
import { provisionGraftObject } from "../graft/graft-object-provisioning";
import { createManualNodeRuntimeClock } from "../runtime/node-runtime-clock";
import {
  createNodeRuntimeScenarioEnvironment,
  createNodeRuntimeScenarioRuntime,
} from "../testing/node-runtime-scenario";
import { manageAuthorityBoundGraftObjectDatabase } from "./managed-node-runtime-object-database";

let environment: Awaited<ReturnType<typeof createNodeRuntimeScenarioEnvironment>>;
beforeAll(async () => {
  environment = await createNodeRuntimeScenarioEnvironment();
});
afterAll(async () => {
  await environment.cleanup();
});

test("an async database callback rolls back and cannot reuse its captured SQL session", async () => {
  const { database, cleanup } = openScenarioDatabase();
  const continued = Promise.withResolvers<void>();
  let continuationError: unknown = null;
  try {
    expect(() =>
      database.write(async (sql) => {
        sql.run("CREATE TABLE rejected_write (value INTEGER NOT NULL)", []);
        await Promise.resolve();
        try {
          sql.run("INSERT INTO rejected_write (value) VALUES (1)", []);
        } catch (error) {
          continuationError = error;
        } finally {
          continued.resolve();
        }
      }),
    ).toThrow("NODE_RUNTIME_OBJECT_DATABASE_ASYNC_TRANSACTION");
    await continued.promise;
    expect(continuationError).toMatchObject({
      message: "NODE_RUNTIME_OBJECT_DATABASE_SESSION_CLOSED",
    });
    expect(
      database.read((sql) =>
        sql.get("SELECT name FROM sqlite_master WHERE name = 'rejected_write'", []),
      ),
    ).toBeNull();
  } finally {
    await cleanup();
  }
});

test("the managed SQL boundary rejects hidden pragmas and mutations in read units", async () => {
  const { database, cleanup } = openScenarioDatabase();
  try {
    database.write((sql) => {
      sql.run("CREATE TABLE read_boundary (value INTEGER NOT NULL)", []);
    });
    expect(() => database.read((sql) => sql.get("/* hidden */ PRAGMA graft_status", []))).toThrow(
      "NODE_RUNTIME_OBJECT_DATABASE_SQL_FORBIDDEN:pragma",
    );
    expect(() =>
      database.read((sql) => sql.run("INSERT INTO read_boundary (value) VALUES (1)", [])),
    ).toThrow("NODE_RUNTIME_OBJECT_DATABASE_READ_SQL_FORBIDDEN:insert");
    expect(
      database.read((sql) => sql.get("SELECT value FROM read_boundary LIMIT 1", [])),
    ).toBeNull();
    expect(() => database.executeSql("SELECT 1; SELECT 2", [])).toThrow(
      "NODE_DURABLE_OBJECT_SQL_MULTIPLE_STATEMENTS_FORBIDDEN",
    );
    expect(() =>
      database.executeSql("CREATE TABLE node_runtime_fake (value INTEGER NOT NULL)", []),
    ).toThrow("NODE_RUNTIME_OBJECT_DATABASE_RUNTIME_SQL_FORBIDDEN");
  } finally {
    await cleanup();
  }
});

function openScenarioDatabase() {
  const storage = environment.createStorage();
  const clock = createManualNodeRuntimeClock(0);
  const operations = createSqlitePragmaGraftDatabaseOperations();
  const controlStore = new GraftControlStore(storage);
  const location = (() => {
    try {
      return provisionGraftObject({
        storage,
        controlStore,
        clock: clock.source,
        objectId: "COUNTER:one",
        databaseOperations: operations,
      });
    } finally {
      controlStore.close();
    }
  })();
  const runtime = createNodeRuntimeScenarioRuntime({
    storage,
    objects: {},
    clock: clock.source,
    objectEviction: { kind: "disabled" },
  });
  const status = runtime.readNodeAuthorityStatus();
  assert(status.state === "serving");
  const activation = prepareGraftObjectActivation({
    storage,
    objectId: "COUNTER:one",
    remoteLogId: location.location.remoteLogId,
    nodeAuthority: status.window,
    maximumClockSkewMs: 0,
    clock: clock.source,
    objectOperations: operations,
    maxFenceAttempts: 4,
  });
  const database = manageAuthorityBoundGraftObjectDatabase(
    activation.database,
    operations,
    activation.authority,
    clock.source,
  );
  activation.markReady();
  return {
    database,
    async cleanup() {
      database.close();
      await runtime.cleanup();
    },
  };
}
