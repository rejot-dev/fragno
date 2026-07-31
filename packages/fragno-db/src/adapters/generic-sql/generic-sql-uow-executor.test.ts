import { describe, it, assert, expect, vi } from "vitest";

import { MysqlDialect, PostgresDialect } from "kysely";

import type { CompiledMutation } from "../../query/unit-of-work/unit-of-work";
import { column, idColumn, schema } from "../../schema/create";
import type { CompiledQuery, Dialect } from "../../sql-driver/sql-driver";
import type { SqlDriverAdapter } from "../../sql-driver/sql-driver-adapter";
import { MySQL2DriverConfig, NodePostgresDriverConfig } from "./driver-config";
import { compileOutboxVersionReservationPlan, executeMutation } from "./generic-sql-uow-executor";

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

const createAdapterReturningRows = (rows: Record<string, unknown>[]) =>
  ({
    transaction: async (
      callback: (trx: { executeQuery: () => Promise<unknown> }) => Promise<unknown>,
    ) =>
      await callback({
        executeQuery: async () => ({ rows }),
      }),
  }) as unknown as SqlDriverAdapter;

const outboxExecutorSchema = schema("outbox_executor", (s) =>
  s.addTable("records", (t) => t.addColumn("id", idColumn()).addColumn("label", column("string"))),
);

const outboxMutationBatch = (query: CompiledQuery): CompiledMutation<CompiledQuery>[] => {
  const operation = {
    type: "update" as const,
    schema: outboxExecutorSchema,
    table: "records" as const,
    id: "record-1",
    checkVersion: false,
    set: { label: "updated" },
  };

  return [
    {
      op: "update",
      query,
      operation,
      materializedOperation: operation,
      uowId: "uow-1",
      expectedAffectedRows: null,
      expectedReturnedRows: null,
    },
  ];
};

const createOutboxInsertFailureAdapter = (error: Error, events: string[]) => {
  let queryCount = 0;

  return {
    transaction: async (
      callback: (trx: { executeQuery: () => Promise<unknown> }) => Promise<unknown>,
    ) => {
      try {
        return await callback({
          executeQuery: async () => {
            queryCount += 1;
            if (queryCount === 1) {
              return { rows: [{ value: "0", nowMs: 1_785_500_800_000 }] };
            }
            if (queryCount === 4) {
              throw error;
            }
            return { rows: [] };
          },
        });
      } catch (transactionError) {
        events.push("rollback");
        throw transactionError;
      }
    },
  } as unknown as SqlDriverAdapter;
};

describe("compileOutboxVersionReservationPlan", () => {
  it("quotes MySQL settings identifiers", () => {
    const dialect = new MysqlDialect({ pool: {} as never });
    const plan = compileOutboxVersionReservationPlan(new MySQL2DriverConfig(), dialect, {
      id: "settings-id",
      key: "fragno-db-settings.outbox_version",
    });

    expect(plan.reservationQuery.sql).toContain(
      "insert into `fragno_db_settings` (`id`, `key`, `value`)",
    );
    expect(plan.reservationQuery.sql).toContain(
      "on duplicate key update `value` = LAST_INSERT_ID(cast(`value` as unsigned) + 1)",
    );
    expect(plan.resultQuery?.sql).toContain("select LAST_INSERT_ID() as `value`,");
  });
});

describe("executeMutation", () => {
  const dialect = {
    createAdapter: () => ({}) as Dialect["createAdapter"] extends () => infer T ? T : never,
    createDriver: () => ({}) as Dialect["createDriver"] extends () => infer T ? T : never,
    createQueryCompiler: () =>
      ({}) as Dialect["createQueryCompiler"] extends () => infer T ? T : never,
  } satisfies Dialect;
  const compiledQuery: CompiledQuery = {
    sql: "SELECT 1",
    parameters: [],
  };
  const outboxDialect = new PostgresDialect({ pool: {} as never });

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
    const result = await executeMutation(adapter, new NodePostgresDriverConfig(), mutationBatch, {
      dialect,
    });
    assert(!result.success);
  });

  it("accepts an empty result for checkAbsent", async () => {
    const adapter = createAdapterReturningRows([]);
    const result = await executeMutation(
      adapter,
      new NodePostgresDriverConfig(),
      [
        {
          op: "check-absent",
          query: compiledQuery,
          expectedAffectedRows: null,
          expectedReturnedRows: 0,
        },
      ],
      { dialect },
    );

    assert(result.success);
  });

  it("returns success=false when checkAbsent finds a row", async () => {
    const adapter = createAdapterReturningRows([{ exists: 1 }]);
    const result = await executeMutation(
      adapter,
      new NodePostgresDriverConfig(),
      [
        {
          op: "check-absent",
          query: compiledQuery,
          expectedAffectedRows: null,
          expectedReturnedRows: 0,
        },
      ],
      { dialect },
    );

    assert(!result.success);
  });

  it("does not log retryable outbox insert failures", async () => {
    const events: string[] = [];
    const adapter = createOutboxInsertFailureAdapter(createError("40P01"), events);
    const logError = vi.spyOn(console, "error").mockImplementation(() => {
      events.push("log");
    });

    try {
      const result = await executeMutation(
        adapter,
        new NodePostgresDriverConfig(),
        outboxMutationBatch(compiledQuery),
        { dialect: outboxDialect, outbox: { enabled: true } },
      );

      assert(!result.success);
      expect(events).toEqual(["rollback"]);
    } finally {
      logError.mockRestore();
    }
  });

  it("logs non-retryable outbox insert diagnostics after rollback", async () => {
    const events: string[] = [];
    const adapter = createOutboxInsertFailureAdapter(createError("54000"), events);
    const logError = vi.spyOn(console, "error").mockImplementation(() => {
      events.push("log");
    });

    try {
      await expect(
        executeMutation(
          adapter,
          new NodePostgresDriverConfig(),
          outboxMutationBatch(compiledQuery),
          { dialect: outboxDialect, outbox: { enabled: true } },
        ),
      ).rejects.toThrow("DB_ERROR_54000");
      expect(events).toEqual(["rollback", "log"]);
    } finally {
      logError.mockRestore();
    }
  });
});
