import { describe, expect, test, vi } from "vitest";

import type { CompiledQuery } from "kysely";

import {
  DurableObjectDialect,
  type DurableObjectQueryInstrumentation,
} from "./durable-object-dialect";

function createCompiledQuery(sql: string): CompiledQuery {
  return { sql, parameters: [], query: {}, queryId: "test-query" } as unknown as CompiledQuery;
}

function createDurableObjectState({
  rows,
  rowsRead,
  rowsWritten,
}: {
  rows: Record<string, string | number>[];
  rowsRead: number;
  rowsWritten: number;
}) {
  const cursor = {
    rowsRead,
    rowsWritten,
    toArray: vi.fn(() => rows),
  };
  const exec = vi.fn(() => cursor);

  return {
    state: { storage: { sql: { exec } } },
    cursor,
    exec,
  };
}

describe("Durable Object SQLite dialect", () => {
  test("rejects database introspection explicitly", () => {
    const dialect = new DurableObjectDialect({
      ctx: { storage: { sql: {} } },
      queryInstrumentation: null,
    } as never);

    expect(() => dialect.createIntrospector({} as never)).toThrow(
      "Durable Object SQLite introspection is not supported.",
    );
  });

  test("records final query row counters after consuming the cursor", async () => {
    const { state, cursor } = createDurableObjectState({
      rows: [{ id: 1 }, { id: 2 }],
      rowsRead: 37,
      rowsWritten: 4,
    });
    const recordQuery = vi.fn();
    const driver = new DurableObjectDialect({
      ctx: state as never,
      queryInstrumentation: { recordQuery },
    }).createDriver();
    const connection = await driver.acquireConnection();

    const result = await connection.executeQuery(createCompiledQuery("select id from items"));

    expect(cursor.toArray).toHaveBeenCalledOnce();
    expect(result).toEqual({
      insertId: undefined,
      numAffectedRows: 4n,
      rows: [{ id: 1 }, { id: 2 }],
    });
    expect(recordQuery).toHaveBeenCalledWith({
      sql: "select id from items",
      rowsRead: 37,
      rowsWritten: 4,
      rowsReturned: 2,
    });
  });

  test("rejects promise-returning instrumentation callbacks", () => {
    const promiseReturningInstrumentation = {
      recordQuery: () => Promise.resolve(),
    };

    // @ts-expect-error Query instrumentation must complete before recordQuery returns.
    const instrumentation: DurableObjectQueryInstrumentation = promiseReturningInstrumentation;

    expect(instrumentation).toBe(promiseReturningInstrumentation);
  });

  test("does not fail a completed query when instrumentation throws", async () => {
    const { state } = createDurableObjectState({
      rows: [{ value: 1 }],
      rowsRead: 1,
      rowsWritten: 0,
    });
    const driver = new DurableObjectDialect({
      ctx: state as never,
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
