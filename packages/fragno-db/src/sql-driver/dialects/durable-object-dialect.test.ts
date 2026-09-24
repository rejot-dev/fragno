import { describe, expect, test, vi } from "vitest";

import type { CompiledQuery } from "kysely";

import { DurableObjectDialect } from "./durable-object-dialect";

function createCompiledQuery(sql: string): CompiledQuery {
  return { sql, parameters: [], query: {}, queryId: "test-query" } as unknown as CompiledQuery;
}

describe("Durable Object SQLite dialect", () => {
  test("rejects database introspection explicitly", () => {
    const dialect = new DurableObjectDialect({
      ctx: { storage: { sql: {} } } as never,
      queryInstrumentation: null,
    });

    expect(() => dialect.createIntrospector({} as never)).toThrow(
      "Durable Object SQLite introspection is not supported.",
    );
  });

  test("skips row-read measurements when instrumentation is disabled", async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const exec = vi.fn(() => ({
      toArray: () => rows,
      rowsWritten: 4,
      get rowsRead(): never {
        throw new Error("Read metrics must not be collected without instrumentation.");
      },
    }));
    const driver = new DurableObjectDialect({
      ctx: { storage: { sql: { exec } } } as never,
      queryInstrumentation: null,
    }).createDriver();
    const connection = await driver.acquireConnection();

    await expect(
      connection.executeQuery(createCompiledQuery("select id from items")),
    ).resolves.toEqual({
      insertId: undefined,
      numAffectedRows: 4n,
      rows,
    });
    expect(exec).toHaveBeenCalledWith("select id from items");
  });

  test("records row counts and timing when instrumentation is supplied", async () => {
    const recordQuery = vi.fn(() => undefined);
    const driver = new DurableObjectDialect({
      ctx: {
        storage: {
          sql: {
            exec: () => ({ toArray: () => [{ id: 1 }], rowsRead: 37, rowsWritten: 0 }),
          },
        },
      } as never,
      queryInstrumentation: { recordQuery },
    }).createDriver();
    const connection = await driver.acquireConnection();

    await connection.executeQuery(createCompiledQuery("select id from items"));

    expect(recordQuery).toHaveBeenCalledWith({
      sql: "select id from items",
      rowsRead: 37,
      rowsWritten: 0,
      rowsReturned: 1,
      executionMs: expect.any(Number),
    });
  });

  test("does not fail a completed query when instrumentation throws", async () => {
    const driver = new DurableObjectDialect({
      ctx: {
        storage: {
          sql: {
            exec: () => ({ toArray: () => [{ value: 1 }], rowsRead: 1, rowsWritten: 0 }),
          },
        },
      } as never,
      queryInstrumentation: {
        recordQuery() {
          throw new Error("metrics unavailable");
        },
      },
    }).createDriver();
    const connection = await driver.acquireConnection();

    await expect(connection.executeQuery(createCompiledQuery("select 1"))).resolves.toEqual({
      insertId: undefined,
      numAffectedRows: undefined,
      rows: [{ value: 1 }],
    });
  });
});
