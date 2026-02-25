import { describe, expect, it } from "vitest";
import type { CompiledQuery } from "kysely";
import type { SqlDriverAdapter } from "../../../sql-driver/sql-driver-adapter";
import { executeMigration } from "./executor";

function query(sql: string): CompiledQuery {
  return { sql, parameters: [] } as unknown as CompiledQuery;
}

describe("executeMigration", () => {
  it("runs foreign_keys pragmas outside the transaction", async () => {
    const calls: string[] = [];

    const driver = {
      executeQuery: async (statement: CompiledQuery) => {
        calls.push(`exec:${statement.sql}`);
        return { rows: [] };
      },
      transaction: async (callback: (trx: SqlDriverAdapter) => Promise<void>) => {
        calls.push("tx:begin");
        const tx = {
          executeQuery: async (statement: CompiledQuery) => {
            calls.push(`tx:${statement.sql}`);
            return { rows: [] };
          },
        } as unknown as SqlDriverAdapter;
        await callback(tx);
        calls.push("tx:commit");
      },
    } as unknown as SqlDriverAdapter;

    await executeMigration(driver, {
      statements: [
        query("PRAGMA foreign_keys = OFF"),
        query("alter table users rename to users_tmp"),
        query("PRAGMA foreign_keys = ON"),
      ],
      fromVersion: 0,
      toVersion: 1,
    });

    expect(calls).toEqual([
      "exec:PRAGMA foreign_keys = OFF",
      "tx:begin",
      "tx:alter table users rename to users_tmp",
      "tx:commit",
      "exec:PRAGMA foreign_keys = ON",
    ]);
  });
});
