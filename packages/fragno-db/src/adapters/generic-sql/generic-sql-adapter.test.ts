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

function createPostgresAdapter(
  rows: Record<string, unknown>[] = [],
  mutationRows: Record<string, unknown>[] = [],
) {
  const executeQuery = vi.fn(async (query: unknown, _values?: unknown[]) => {
    const result = String(query).includes('from "fragno_db_outbox_mutations"')
      ? mutationRows
      : rows;
    return { command: "SELECT" as const, rowCount: result.length, rows: result };
  });
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
  it("streams Postgres outbox payloads as opaque JSON text", async () => {
    const operationJson = '{"op":"delete", "externalId":"kept as stored"}';
    const { adapter, executeQuery } = createPostgresAdapter(
      [{ versionstamp: "000000000000000000000002", uowId: "uow-2", refMapJson: null }],
      [
        {
          entryVersionstamp: "000000000000000000000002",
          payloadJson: `{"json":${operationJson}}`,
        },
      ],
    );

    try {
      await expect(
        collectRows(
          adapter.streamSerializedOutboxEntries({
            afterVersionstamp: "000000000000000000000001",
            limit: 50,
          }),
        ),
      ).resolves.toEqual([
        {
          versionstamp: "000000000000000000000002",
          entryJson:
            '{"versionstamp":"000000000000000000000002","uowId":"uow-2",' +
            `"payload":{"json":{"version":2,"operations":[${operationJson}]}}}`,
        },
      ]);
      const [entryCall, mutationCall] = executeQuery.mock.calls;
      assert(entryCall && mutationCall);
      expect(entryCall[1]).toContain("000000000000000000000001");
      // Payloads come back as stored text, so the database does not rebuild them as JSON.
      expect(mutationCall[0]).toContain('cast("_fragno_outbox_stream_mutation"."payload" as text)');
      expect(mutationCall[0]).not.toContain("json_agg");
      expect(mutationCall[1]).toEqual(["000000000000000000000002", "000000000000000000000002"]);
    } finally {
      await adapter.close();
    }
  });

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
