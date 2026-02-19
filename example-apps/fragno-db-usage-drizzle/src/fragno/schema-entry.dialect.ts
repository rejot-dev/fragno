import type { Dialect } from "@fragno-dev/db/sql-driver";

export function createNoopDialect({ supportsReturning }: { supportsReturning: boolean }): Dialect {
  return {
    createAdapter: () => ({ supportsReturning }),
    createDriver: () => ({
      async init() {},
      async acquireConnection() {
        return {
          async executeQuery() {
            return { rows: [] };
          },
        };
      },
      async releaseConnection() {},
      async beginTransaction() {},
      async commitTransaction() {},
      async rollbackTransaction() {},
      async destroy() {},
    }),
    createQueryCompiler: () => ({
      compileQuery: (_node: unknown, _queryId: unknown) => ({
        sql: "",
        parameters: [],
      }),
    }),
  };
}
