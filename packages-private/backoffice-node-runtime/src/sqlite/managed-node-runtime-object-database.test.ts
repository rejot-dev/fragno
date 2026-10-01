import { expect, test } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { openLocalNodeRuntimeObjectDatabase } from "./managed-node-runtime-object-database";

test("an async database callback rolls back and cannot reuse its captured SQL session", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "node-runtime-database-"));
  const database = openLocalNodeRuntimeObjectDatabase(directory, "COUNTER:one");
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
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the managed SQL boundary rejects hidden pragmas and mutations in read units", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "node-runtime-database-sql-"));
  const database = openLocalNodeRuntimeObjectDatabase(directory, "COUNTER:one");
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
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
