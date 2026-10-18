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

test("migration pragmas preserve real foreign key behavior without exposing Graft management", async () => {
  const { database, cleanup } = openScenarioDatabase();
  const hooks = { beforeCommit() {}, afterCommit() {} };
  try {
    database.executeSql("CREATE TABLE parent (id INTEGER PRIMARY KEY)", []);
    database.executeSql("CREATE TABLE child (parent_id INTEGER REFERENCES parent(id))", []);
    database.executeSql("PRAGMA foreign_keys = ON", []);
    expect(() => database.executeSql("INSERT INTO child VALUES (1)", [])).toThrow();
    const position = database.committedStoragePosition;
    database.executeSql("PRAGMA foreign_keys = OFF", []);
    expect(database.committedStoragePosition).toBe(position);
    database.executeSql("INSERT INTO child VALUES (1)", []);
    database.executeSql("PRAGMA foreign_keys = ON", []);
    await database.transaction(async () => {
      database.executeSql("PRAGMA defer_foreign_keys = ON", []);
      database.executeSql("INSERT INTO child VALUES (2)", []);
      await Promise.resolve();
      database.executeSql("INSERT INTO parent VALUES (2)", []);
      expect(() => database.executeSql("PRAGMA foreign_keys = OFF", [])).toThrow(
        "NODE_RUNTIME_OBJECT_DATABASE_FOREIGN_KEYS_DURING_TRANSACTION",
      );
    }, hooks);
    expect(() => database.executeSql("INSERT INTO child VALUES (3)", [])).toThrow();
    expect(database.executeSql("SELECT parent_id FROM child ORDER BY parent_id", []).rows).toEqual([
      { parent_id: 1 },
      { parent_id: 2 },
    ]);
    expect(() => database.executeSql("PRAGMA graft_push", [])).toThrow("SQL_FORBIDDEN:pragma");
    expect(() => database.executeSql("PRAGMA foreign_keys = OFF; PRAGMA graft_push", [])).toThrow(
      "SQL_FORBIDDEN:pragma",
    );
  } finally {
    await cleanup();
  }
});

test("one transaction advances storage once and a caught write failure leaves no partial mutation", async () => {
  const { database, cleanup } = openScenarioDatabase();
  const hooks = { beforeCommit() {}, afterCommit() {} };
  try {
    database.executeSql("CREATE TABLE transaction_values (value INTEGER NOT NULL)", []);
    const before = database.committedStoragePosition;
    await database.transaction(async () => {
      database.executeSql("INSERT INTO transaction_values (value) VALUES (1)", []);
      await Promise.resolve();
      expect(() =>
        database.write((sql) => {
          sql.run("INSERT INTO transaction_values (value) VALUES (99)", []);
          throw new Error("EXPECTED_INNER_WRITE_FAILURE");
        }),
      ).toThrow("EXPECTED_INNER_WRITE_FAILURE");
      database.executeSql("INSERT INTO transaction_values (value) VALUES (2)", []);
    }, hooks);
    expect(database.committedStoragePosition).toBe(before + 1);
    expect(
      database.executeSql("SELECT value FROM transaction_values ORDER BY value", []).rows,
    ).toEqual([{ value: 1 }, { value: 2 }]);
    await expect(
      database.transaction(async () => {
        database.executeSql("INSERT INTO transaction_values (value) VALUES (3)", []);
        await Promise.resolve();
        throw new Error("EXPECTED_OUTER_ROLLBACK");
      }, hooks),
    ).rejects.toThrow("EXPECTED_OUTER_ROLLBACK");
    expect(database.committedStoragePosition).toBe(before + 1);
    expect(
      database.executeSql("SELECT value FROM transaction_values ORDER BY value", []).rows,
    ).toEqual([{ value: 1 }, { value: 2 }]);
  } finally {
    await cleanup();
  }
});

test("SQL outside a transaction callback shares its originating operation's single commit", async () => {
  const { database, cleanup } = openScenarioDatabase();
  const hooks = { beforeCommit() {}, afterCommit() {} };
  try {
    database.executeSql("CREATE TABLE transaction_values (value INTEGER NOT NULL)", []);
    const before = database.committedStoragePosition;
    await database.runStorageOperation(async () => {
      const ready = Promise.withResolvers<void>();
      const commit = Promise.withResolvers<void>();
      const transaction = database.transaction(async () => {
        ready.resolve();
        await commit.promise;
      }, hooks);
      try {
        await ready.promise;
        database.executeSql("INSERT INTO transaction_values (value) VALUES (1)", []);
        await Promise.resolve();
        database.executeSql("INSERT INTO transaction_values (value) VALUES (2)", []);
        expect(database.committedStoragePosition).toBe(before);
      } finally {
        commit.resolve();
        await transaction;
      }
    });
    expect(database.committedStoragePosition).toBe(before + 1);
    expect(
      database.executeSql("SELECT value FROM transaction_values ORDER BY value", []).rows,
    ).toEqual([{ value: 1 }, { value: 2 }]);
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
