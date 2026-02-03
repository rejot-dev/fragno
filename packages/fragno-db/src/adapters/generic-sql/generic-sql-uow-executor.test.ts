import { describe, expect, it } from "vitest";
import type { CompiledMutation } from "../../query/unit-of-work/unit-of-work";
import type { CompiledQuery } from "../../sql-driver/sql-driver";
import type { SqlDriverAdapter } from "../../sql-driver/sql-driver-adapter";
import { NodePostgresDriverConfig } from "./driver-config";
import { executeMutation } from "./generic-sql-uow-executor";

const createError = (code: string) => {
  const error = new Error(`DB_ERROR_${code}`);
  (error as { code?: string }).code = code;
  return error;
};

const createAdapterThatThrows = (error: Error) =>
  ({
    transaction: async (
      callback: (trx: { executeQuery: () => Promise<unknown> }) => Promise<unknown>,
    ) =>
      await callback({
        executeQuery: async () => {
          throw error;
        },
      }),
  }) as unknown as SqlDriverAdapter;

describe("executeMutation", () => {
  const compiledQuery: CompiledQuery = {
    sql: "SELECT 1",
    parameters: [],
  };

  const mutationBatch: CompiledMutation<CompiledQuery>[] = [
    {
      op: "update",
      query: compiledQuery,
      expectedAffectedRows: null,
      expectedReturnedRows: null,
    },
  ];

  it.each(["40001", "40P01"])("returns success=false on SQLSTATE %s", async (code) => {
    const adapter = createAdapterThatThrows(createError(code));
    const result = await executeMutation(adapter, new NodePostgresDriverConfig(), mutationBatch);
    expect(result.success).toBe(false);
  });
});
