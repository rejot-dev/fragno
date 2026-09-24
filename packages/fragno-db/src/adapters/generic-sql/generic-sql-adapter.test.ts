import { assert, describe, expect, it, vi } from "vitest";

import { PostgresDialect } from "kysely";

import type { RetrievalOperation } from "../../query/unit-of-work/unit-of-work";
import { column, idColumn, schema } from "../../schema/create";
import type { AnySchema } from "../../schema/create";
import { NodePostgresDriverConfig } from "./driver-config";
import { SqlAdapter } from "./generic-sql-adapter";

const retrievalSchema = schema("stream_retrieval", (s) =>
  s.addTable("records", (t) => t.addColumn("id", idColumn()).addColumn("value", column("string"))),
);

function createPostgresAdapter() {
  const executeQuery = vi.fn(async () => ({
    command: "SELECT" as const,
    rowCount: 0,
    rows: [],
  }));
  const release = vi.fn();
  const pool = {
    connect: vi.fn(async () => ({ query: executeQuery, release })),
    end: vi.fn(async () => {}),
  };
  const dialect = new PostgresDialect({ pool: pool as never });
  return {
    adapter: new SqlAdapter({ dialect, driverConfig: new NodePostgresDriverConfig() }),
    executeQuery,
  };
}

function createRetrievalOperation(
  adapter: SqlAdapter,
  pageSize: number | null,
): RetrievalOperation<AnySchema> {
  const uow = adapter.createUnitOfWork(retrievalSchema, null);
  uow.find("records", (builder) => {
    const ordered = builder.whereIndex("primary").orderByIndex("primary", "asc");
    return pageSize === null ? ordered : ordered.pageSize(pageSize);
  });
  const [operation] = uow.getRetrievalOperations();
  assert(operation);
  return operation as RetrievalOperation<AnySchema>;
}

async function collectRows(iterable: AsyncIterableIterator<unknown>): Promise<unknown[]> {
  const rows: unknown[] = [];
  for await (const row of iterable) {
    rows.push(row);
  }
  return rows;
}

describe("SqlAdapter bounded retrieval execution", () => {
  it("uses one buffered query when Postgres has no cursor implementation", async () => {
    const { adapter, executeQuery } = createPostgresAdapter();

    try {
      const operation = createRetrievalOperation(adapter, 50);

      await expect(collectRows(adapter.streamRetrieval(operation))).resolves.toEqual([]);
      expect(executeQuery).toHaveBeenCalledOnce();
    } finally {
      await adapter.close();
    }
  });

  it("rejects an unbounded retrieval before querying Postgres", async () => {
    const { adapter, executeQuery } = createPostgresAdapter();

    try {
      const operation = createRetrievalOperation(adapter, null);

      await expect(collectRows(adapter.streamRetrieval(operation))).rejects.toThrow(
        "SqlAdapter.streamRetrieval buffered-page execution requires a positive page size.",
      );
      expect(executeQuery).not.toHaveBeenCalled();
    } finally {
      await adapter.close();
    }
  });
});
