import { afterEach, assert, describe, expect, it } from "vitest";

import type { LofiSqliteAccess, LofiSqliteGuard, LofiSqliteSyncDatabase } from "./sync-connection";
import { openLofiSqliteMemoryFiles } from "./testing";

const SQLITE_SELECT = 21;
const SQLITE_READ = 20;
const SQLITE_FUNCTION = 31;

const databases: LofiSqliteSyncDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) {
    await database.close();
  }
});

async function openDatabase() {
  const files = await openLofiSqliteMemoryFiles({ statementDelayMs: 0 });
  const database = await files.open({ databaseName: `sync-${crypto.randomUUID()}.sqlite` });
  databases.push(database);
  await database.execute(`CREATE TABLE "runs" ("id" TEXT, "status" TEXT, "secret" TEXT)`);
  await database.execute(`INSERT INTO "runs" VALUES ('a', 'active', 'x'), ('b', 'errored', 'y')`);
  await database.execute(`CREATE TEMP VIEW "visible" AS SELECT "id", "status" FROM "runs"`);
  await database.execute(`CREATE TEMP TABLE "derived" ("value")`);
  return database;
}

/** Reads the result of a statement prepared now, as view engines do: synchronously, in a read. */
function rows(database: LofiSqliteSyncDatabase, sql: string, params: unknown[] = []) {
  return [...database.connection.prepare(sql).rows(params)];
}

/** Allows what a page may read: the view and the temp table, and the listed functions. */
const pageGuard = (overrides: Partial<LofiSqliteGuard> = {}): LofiSqliteGuard => ({
  authorize: (access: LofiSqliteAccess) =>
    access.action === SQLITE_SELECT ||
    (access.action === SQLITE_READ &&
      (access.source === "visible" || ["visible", "derived"].includes(access.details[0]!))) ||
    (access.action === SQLITE_FUNCTION && ["count", "upper"].includes(access.details[1]!)),
  maxOperations: 1_000,
  maxLength: 1_000_000,
  ...overrides,
});

describe("synchronous wa-sqlite statements", () => {
  it("prepare one statement, and report the tables it reads", async () => {
    const database = await openDatabase();
    const { connection } = database;
    // Reads through a view count as reads of the view's tables too.
    expect(connection.prepare(`SELECT "id" FROM "visible" -- trailing comment`).tables).toEqual(
      new Set(["runs", "visible"]),
    );
    expect(
      connection.prepare(`WITH "x" AS (SELECT "value" FROM "derived") SELECT * FROM "x";  `).tables,
    ).toEqual(new Set(["derived"]));
    assert.strictEqual(connection.prepare(`SELECT ?1, ?2`).parameterCount, 2);

    expect(() => connection.prepare(`SELECT 1; SELECT 2`)).toThrow("more than one statement");
    expect(() => connection.prepare(`SELECT 1; DELETE FROM "runs"`)).toThrow(
      "more than one statement",
    );
    expect(() => connection.prepare(`-- nothing`)).toThrow("no statement");
    expect(() => connection.prepare(`SELECT 1; nonsense`)).toThrow('near "nonsense"');
    expect(rows(database, `SELECT count(*) FROM "runs"`)).toEqual([[2]]);
  });

  it("read text as it was stored, with NULs and a leading byte order mark", async () => {
    const database = await openDatabase();
    const texts = ["a\u0000b", "\uFEFFbom", "漢😀", ""];
    expect(rows(database, `SELECT ?1 AS "a", ?2 AS "b", ?3 AS "c", ?4 AS "d"`, texts)).toEqual([
      texts,
    ]);
  });

  it("guard what statements read, which functions they call, and how much work they do", async () => {
    const database = await openDatabase();
    const { connection } = database;
    const guarded = (sql: string, guard = pageGuard()) =>
      connection.guarded(guard, () => [...connection.prepare(sql).rows([])]);

    expect(guarded(`SELECT upper("status") FROM "visible" ORDER BY "id"`)).toEqual([
      ["ACTIVE"],
      ["ERRORED"],
    ]);
    expect(guarded(`SELECT count(*) FROM "derived"`)).toEqual([[0]]);
    // The statement names what was refused, since SQLite only says "not authorized".
    expect(() => guarded(`SELECT "secret" FROM "runs"`)).toThrow(
      "Not authorized: action 20 runs secret.",
    );
    expect(() => guarded(`SELECT randomblob(8)`)).toThrow("randomblob");
    expect(() => guarded(`PRAGMA table_info("runs")`)).toThrow("Not authorized");
    expect(() => guarded(`DELETE FROM "derived"`)).toThrow("Not authorized");

    const recursive = `WITH RECURSIVE "n"("i") AS (SELECT 1 UNION ALL SELECT "i" + 1 FROM "n")
      SELECT count(*) FROM "n"`;
    const counting = pageGuard({ authorize: () => true });
    expect(() => guarded(recursive, counting)).toThrow("more than 1000000 operations");
    expect(() => guarded(`SELECT length(zeroblob(2000000))`, counting)).toThrow("too big");

    // Outside a guarded run, statements may do anything again.
    expect(rows(database, `SELECT "secret" FROM "runs" ORDER BY "id"`)).toEqual([["x"], ["y"]]);
    expect(rows(database, `SELECT length(zeroblob(2000000))`)).toEqual([[2_000_000]]);
  });
});
