import { afterEach, describe, expect, it } from "vitest";

import { guardedSqlViewEngine } from "./guarded-views";
import type { LofiSqliteReader } from "./read-views";
import type { LofiSqliteSyncDatabase } from "./sync-connection";
import { openLofiSqliteMemoryFiles } from "./testing";
import type { SqliteValue } from "./values";

const databases: LofiSqliteSyncDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) {
    await database.close();
  }
});

/**
 * Opens the engine over a `runs` table, as the leader does, and collects what each view reports.
 * `compute` derives the `derived` relation.
 */
async function openEngine({
  compute = () => [],
}: {
  compute?: (reader: LofiSqliteReader) => readonly (readonly SqliteValue[])[];
} = {}) {
  const files = await openLofiSqliteMemoryFiles({ statementDelayMs: 0 });
  const database = await files.open({ databaseName: `guarded-${crypto.randomUUID()}.sqlite` });
  databases.push(database);
  await database.execute(`CREATE TABLE "runs" ("id" TEXT, "status" TEXT)`);
  const views = guardedSqlViewEngine({
    kind: "guarded",
    views: { visible: `SELECT "id", "status" FROM "runs"` },
    derived: { derived: { columns: ["value"], compute } },
    operations: 1_000,
  }).open({ connection: database.connection, registrations: [] });

  const reported = new Map<string, unknown[]>();
  return {
    database,
    views,
    reported,
    watch(id: string, sql: string, params: SqliteValue[] = []) {
      reported.set(id, []);
      // Guarded views report their failures as results, so `fail` never runs.
      views.materialize(
        id,
        { sql, params },
        (data) => reported.get(id)!.push(data),
        (error) => {
          throw error;
        },
      );
    },
  };
}

const ready = (rows: SqliteValue[][]) => ({
  status: "ready",
  columns: expect.any(Array),
  rows,
});
const failed = (message: string) => ({
  status: "error",
  message: expect.stringContaining(message),
});

describe("guarded SQL views", () => {
  it("report a derived relation's recovery, even with the rows it had before it failed", async () => {
    let fails = false;
    const { views, reported, watch } = await openEngine({
      compute: (reader) => {
        // Reads runs, so batches that write runs compute it again.
        reader.query({ sql: `SELECT count(*) AS "count" FROM "runs"`, params: [], columns: {} });
        if (fails) {
          throw new Error("unreadable");
        }
        return [[1]];
      },
    });
    watch("derived", `SELECT "value" FROM "derived"`);

    fails = true;
    views.refresh(new Set(["runs"]));
    fails = false;
    views.refresh(new Set(["runs"]));

    expect(reported.get("derived")).toEqual([
      ready([[1]]),
      failed("The relation derived could not be computed: unreadable"),
      ready([[1]]),
    ]);
  });

  it("keep a query given the wrong number of parameters failing after refreshes", async () => {
    const { database, views, reported, watch } = await openEngine();
    watch("params", `SELECT "id" FROM "visible" WHERE "status" = ?1`);

    await database.execute(`INSERT INTO "runs" VALUES ('a', NULL)`);
    views.refresh(new Set(["runs"]));

    expect(reported.get("params")).toEqual([failed("takes 1 parameters, and was given 0")]);
  });

  it("refuse writes and what would end the leader's transaction, and keep refreshing", async () => {
    const { database, views, reported, watch } = await openEngine();
    await database.execute(`INSERT INTO "runs" VALUES ('a', 'live')`);
    watch("pragma", `SELECT count(*) FROM pragma_table_info('runs')`);
    watch("random", `SELECT typeof(random())`);
    watch("visible", `SELECT "id" FROM "visible"`);
    for (const [id, sql] of [
      // A conflict ends the whole transaction, not just the statement.
      ["rollback", `INSERT OR ROLLBACK INTO "runs" SELECT * FROM "runs"`],
      ["temp", `DELETE FROM "derived"`],
      ["create", `CREATE TEMP TABLE "scratch" ("id" TEXT)`],
      ["commit", `COMMIT`],
      ["savepoint", `SAVEPOINT "page"`],
      ["attach", `ATTACH ':memory:' AS "other"`],
      ["setting", `PRAGMA foreign_keys = OFF`],
    ]) {
      watch(id!, sql!);
    }

    await database.execute(`INSERT INTO "runs" VALUES ('b', 'live')`);
    views.refresh(new Set(["runs"]));

    expect(reported.get("pragma")).toEqual([ready([[2]])]);
    expect(reported.get("random")).toEqual([ready([["integer"]])]);
    expect(reported.get("visible")).toEqual([ready([["a"]]), ready([["a"], ["b"]])]);
    for (const id of ["rollback", "temp", "create"]) {
      expect(reported.get(id)).toEqual([failed("Queries only read: they cannot write.")]);
    }
    expect(reported.get("commit")).toEqual([failed("cannot begin or end transactions")]);
    expect(reported.get("savepoint")).toEqual([failed("cannot begin or end transactions")]);
    expect(reported.get("attach")).toEqual([failed("cannot attach or detach databases")]);
    expect(reported.get("setting")).toEqual([failed("can read a pragma, but not set it")]);
  });
});
