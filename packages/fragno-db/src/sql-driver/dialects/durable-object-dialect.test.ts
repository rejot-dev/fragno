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
    [Symbol.iterator]: () => rows.values(),
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
    const recordQuery = vi.fn<DurableObjectQueryInstrumentation["recordQuery"]>();
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
    expect(recordQuery.mock.calls[0]?.[0].executionMs).toBeGreaterThanOrEqual(0);
  });

  test("streams cursor rows in bounded chunks without toArray", async () => {
    const { state, cursor } = createDurableObjectState({
      rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
      rowsRead: 3,
      rowsWritten: 0,
    });
    const recordQuery = vi.fn();
    const connection = await new DurableObjectDialect({
      ctx: state as never,
      queryInstrumentation: { recordQuery },
    })
      .createDriver()
      .acquireConnection();

    const chunks = [];
    for await (const chunk of connection.streamQuery(
      createCompiledQuery("select id from items"),
      2,
    )) {
      chunks.push(chunk.rows);
    }

    expect(chunks).toEqual([[{ id: 1 }, { id: 2 }], [{ id: 3 }]]);
    expect(cursor.toArray).not.toHaveBeenCalled();
    expect(recordQuery).toHaveBeenCalledWith(expect.objectContaining({ rowsReturned: 3 }));
  });

  test("does not claim final cursor metrics when streaming stops early", async () => {
    const { state } = createDurableObjectState({
      rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
      rowsRead: 3,
      rowsWritten: 0,
    });
    const recordQuery = vi.fn();
    const connection = await new DurableObjectDialect({
      ctx: state as never,
      queryInstrumentation: { recordQuery },
    })
      .createDriver()
      .acquireConnection();

    for await (const _chunk of connection.streamQuery(createCompiledQuery("select id"), 1)) {
      break;
    }

    expect(recordQuery).not.toHaveBeenCalled();
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
