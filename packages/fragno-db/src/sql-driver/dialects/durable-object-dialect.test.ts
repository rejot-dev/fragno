import { describe, expect, test, vi, assert } from "vitest";

import { DurableObjectDialect } from "./durable-object-dialect";

function createIntrospector(
  objects: Array<{ name: string; sql: string | null; type: string }>,
  columns: Array<{
    tableName: string;
    cid: number;
    name: string;
    type: string;
    notnull: number;
    defaultValue: string | number | null;
    primaryKeyPosition: number;
  }>,
) {
  const exec = vi.fn((query: string) => ({
    toArray: () => (query.includes("pragma_table_info") ? columns : objects),
  }));
  const dialect = new DurableObjectDialect({
    ctx: { storage: { sql: { exec } } },
  } as never);
  return { introspector: dialect.createIntrospector({} as never), exec };
}

describe("Durable Object SQLite introspection", () => {
  test("reads view columns from SQLite metadata instead of parsing the view expression", async () => {
    const { introspector } = createIntrospector(
      [
        {
          name: "name-prefixes",
          sql: 'CREATE VIEW "name-prefixes" AS SELECT substr(name, 1, 2) AS prefix FROM people',
          type: "view",
        },
      ],
      [
        {
          tableName: "name-prefixes",
          cid: 0,
          name: "prefix",
          type: "",
          notnull: 0,
          defaultValue: null,
          primaryKeyPosition: 0,
        },
      ],
    );

    await expect(introspector.getTables()).resolves.toEqual([
      {
        name: "name-prefixes",
        isView: true,
        columns: [
          {
            name: "prefix",
            dataType: "",
            isNullable: true,
            isAutoIncrementing: false,
            hasDefaultValue: false,
            comment: undefined,
          },
        ],
      },
    ]);
  });

  test("accepts quoted table names and recognizes an integer primary key", async () => {
    const { introspector } = createIntrospector(
      [
        {
          name: "audit-events",
          sql: 'CREATE TABLE "audit-events" (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)',
          type: "table",
        },
      ],
      [
        {
          tableName: "audit-events",
          cid: 0,
          name: "id",
          type: "INTEGER",
          notnull: 0,
          defaultValue: null,
          primaryKeyPosition: 1,
        },
        {
          tableName: "audit-events",
          cid: 1,
          name: "payload",
          type: "TEXT",
          notnull: 1,
          defaultValue: null,
          primaryKeyPosition: 0,
        },
      ],
    );

    const tables = await introspector.getTables();

    assert(tables[0]?.name === "audit-events");
    assert(tables[0]?.columns[0]?.isAutoIncrementing);
    assert(!tables[0]?.columns[1]?.isNullable);
  });
});
