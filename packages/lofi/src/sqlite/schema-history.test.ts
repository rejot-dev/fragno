import { afterEach, assert, describe, expect, it } from "vitest";

import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { BetterSQLite3DriverConfig } from "@fragno-dev/db/drivers";
import { fetchFragnoInternalDescription } from "@fragno-dev/db/outbox";
import { column, idColumn, schema, type AnySchema } from "@fragno-dev/db/schema";
import BetterSqlite3 from "better-sqlite3";
import { SqliteDialect } from "kysely";

import { defineFragment, instantiate } from "@fragno-dev/core";
import { migrate, withDatabase } from "@fragno-dev/db";

import { lofiSqliteTableName, quoteSqliteIdentifier } from "./layout";
import { openLofiSqliteReplicaOn, type LofiSqliteReplica } from "./replica";
import { openLofiSqliteMemoryFiles, waitForLofiSqliteReplica } from "./testing";

// Version 1 has a task's title. Version 2 adds columns with fixed defaults, which the migration
// gives the rows that exist, and one with a default application code computes, which it does not.
const tasksV1 = schema("tasks", (s) =>
  s.addTable("task", (t) => t.addColumn("id", idColumn()).addColumn("title", column("string"))),
);
const tasksV2 = schema("tasks", (s) =>
  s
    .addTable("task", (t) => t.addColumn("id", idColumn()).addColumn("title", column("string")))
    .alterTable("task", (t) =>
      t
        .addColumn("status", column("string").defaultTo("open's"))
        .addColumn("visible", column("bool").defaultTo(true))
        .addColumn("rank", column("integer").defaultTo(-1))
        // The backend cannot fill it in for existing rows, so the column must allow NULL.
        .addColumn(
          "token",
          column("string")
            .nullable()
            .defaultTo$((b) => b.cuid()),
        ),
    ),
);

const COLUMNS = `"title", "status", "visible", "rank", "token"`;
const taskTable = quoteSqliteIdentifier(lofiSqliteTableName({ schema: tasksV2 }, "task"));

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function serve(adapter: SqlAdapter, taskSchema: AnySchema) {
  return instantiate(defineFragment("tasks").extend(withDatabase(taskSchema)).build())
    .withConfig({})
    .withRoutes([])
    .withOptions({ databaseAdapter: adapter, outbox: { enabled: true } })
    .build();
}

describe("SQLite replica across source schema changes", () => {
  it("replays rows written before a column was added with the values the migration gave them", async () => {
    const server = new BetterSqlite3(":memory:");
    const adapter = new SqlAdapter({
      dialect: new SqliteDialect({ database: server }),
      driverConfig: new BetterSQLite3DriverConfig(),
    });
    cleanups.push(async () => {
      await adapter.close();
      server.close();
    });

    // A task written at version 1, then the migration to version 2, and a task written after it.
    await migrate(serve(adapter, tasksV1));
    const before = adapter.createUnitOfWork(tasksV1, tasksV1.name);
    before.create("task", { title: "Before" });
    assert((await before.executeMutations()).success);
    const fragment = serve(adapter, tasksV2);
    await migrate(fragment);
    const after = adapter.createUnitOfWork(tasksV2, tasksV2.name);
    after.create("task", { title: "After", status: "done", visible: false, rank: 3 });
    assert((await after.executeMutations()).success);

    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return await fragment.callRouteRaw(
        "GET",
        url.pathname as never,
        { query: url.searchParams, signal: init?.signal ?? undefined } as never,
      );
    }) as typeof globalThis.fetch;
    const files = await openLofiSqliteMemoryFiles({ statementDelayMs: 0 });
    const replica: LofiSqliteReplica = await openLofiSqliteReplicaOn(
      {
        baseUrl: "http://tasks.test",
        fetch,
        schemas: [{ schema: tasksV2 }],
        localSchemas: [],
        projections: [],
        ephemeralTables: [],
        onError: (error) => {
          throw error;
        },
        retryDelayMs: 10,
      },
      { openDatabase: files.open },
    );
    cleanups.push(() => replica.close());
    const { currentVersionstamp } = await fetchFragnoInternalDescription({
      internalUrl: new URL("http://tasks.test/_internal"),
      fetch,
    });
    await waitForLofiSqliteReplica(replica, currentVersionstamp!, { timeoutMs: 2_000 });

    // The backend's own table, which has the replica's layout.
    const backend = server
      .prepare(`SELECT ${COLUMNS} FROM ${taskTable} ORDER BY "title" DESC`)
      .all() as Array<Record<string, unknown>>;
    expect(backend).toEqual([
      { title: "Before", status: "open's", visible: 1, rank: -1, token: null },
      { title: "After", status: "done", visible: 0, rank: 3, token: expect.any(String) },
    ]);
    expect(
      await replica.execute(`SELECT ${COLUMNS} FROM ${taskTable} ORDER BY "title" DESC`),
    ).toEqual(backend);
  });
});
