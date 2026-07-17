import { describe, it, assert, expect } from "vitest";

import { MysqlDialect } from "kysely";

import type { CompiledMutation } from "../../query/unit-of-work/unit-of-work";
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
});
