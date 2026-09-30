import { assert, test } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import { configureBackofficeSqliteConnection } from "./sqlite-connection-config";

test("Node Backoffice SQLite connections use the shared durable configuration", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-sqlite-config-"));
  const database = new Database(path.join(directory, "configured.sqlite"));

  try {
    configureBackofficeSqliteConnection(database);

    assert.equal(database.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(database.pragma("synchronous", { simple: true }), 2);
    assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(database.pragma("busy_timeout", { simple: true }), 5_000);
    assert.equal(database.pragma("wal_autocheckpoint", { simple: true }), 1_000);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
