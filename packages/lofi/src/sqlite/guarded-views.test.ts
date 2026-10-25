import { afterEach, describe, expect, it } from "vitest";

import { guardedSqlViewEngine, type LofiSqliteGuardedLimits } from "./guarded-views";
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

const LIMITS: LofiSqliteGuardedLimits = {
  rows: 100,
  bytes: 10_000,
  operations: 1_000,
  length: 1_000_000,
};

/**
 * Opens the engine over a `runs` table, as the leader does, and collects what each view reports.
 * `compute` derives the `derived` relation.
 */
async function openEngine({
  compute = () => [],
  limits = LIMITS,
}: {
  compute?: (reader: LofiSqliteReader) => readonly (readonly SqliteValue[])[];
  limits?: LofiSqliteGuardedLimits;
} = {}) {
  const files = await openLofiSqliteMemoryFiles({ statementDelayMs: 0 });
  const database = await files.open({ databaseName: `guarded-${crypto.randomUUID()}.sqlite` });
  databases.push(database);
  await database.execute(`CREATE TABLE "runs" ("id" TEXT, "status" TEXT)`);
  const views = guardedSqlViewEngine({
    kind: "guarded",
    views: { visible: `SELECT "id", "status" FROM "runs"` },
    derived: { derived: { columns: ["value"], compute } },
    functions: ["count", "char", "printf", "replace"],
    limits,
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
  truncated: false,
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

  it("count the bytes of text as UTF-8", async () => {
    const { reported, watch } = await openEngine({ limits: { ...LIMITS, bytes: 1_000 } });
    // 漢 is one UTF-16 code unit and three UTF-8 bytes; 😀 is two code units and four bytes.
    watch("over", `SELECT replace(printf('%.334c', 'x'), 'x', char(28450))`);
    watch("under", `SELECT replace(printf('%.333c', 'x'), 'x', char(28450))`);
    watch("pairs", `SELECT replace(printf('%.251c', 'x'), 'x', char(128512))`);

    expect(reported.get("over")).toEqual([failed("more than 1000 bytes")]);
    expect(reported.get("under")).toEqual([ready([["漢".repeat(333)]])]);
    expect(reported.get("pairs")).toEqual([failed("more than 1000 bytes")]);
  });
});
