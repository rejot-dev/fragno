import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { Kysely, type Transaction } from "kysely";

import type { NodeRuntimeObjectContext } from "../../runtime/node-runtime-object";

type DialectDatabase = { dialect_values: { value: number } };

/** The shared dialect uses ordinary SQL and KV across its asynchronous begin/query/commit protocol. */
export function createDialectTransactionObject({ state }: NodeRuntimeObjectContext) {
  const sql = state.storage.sql;
  const database = new Kysely<DialectDatabase>({
    dialect: new DurableObjectDialect({ ctx: state, queryInstrumentation: null }),
  });
  void state.blockConcurrencyWhile(async () => {
    await database.transaction().execute(async (transaction) => {
      await transaction.schema
        .createTable("dialect_values")
        .ifNotExists()
        .addColumn("value", "integer", (column) => column.notNull())
        .execute();
    });
  });

  async function writeValue(transaction: Transaction<DialectDatabase>, value: number) {
    await transaction.insertInto("dialect_values").values({ value }).execute();
    const count = sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM dialect_values")
      .one().count;
    await state.storage.put({ value, count });
    await state.storage.setAlarm(value * 100);
  }

  return {
    async change(value: number, fail: boolean) {
      await database.transaction().execute(async (transaction) => {
        await writeValue(transaction, value);
        if (fail) {
          throw new Error("EXPECTED_DIALECT_ROLLBACK");
        }
      });
    },
    async holdTransaction(value: number, barrier: () => Promise<void>, fail: boolean) {
      await database.transaction().execute(async (transaction) => {
        await writeValue(transaction, value);
        await barrier();
        if (fail) {
          throw new Error("EXPECTED_DIALECT_ROLLBACK");
        }
      });
    },
    async streamTransaction(value: number) {
      return await database.transaction().execute(async (transaction) => {
        await writeValue(transaction, value);
        let total = 0;
        for await (const row of transaction
          .selectFrom("dialect_values")
          .selectAll()
          .orderBy("value")
          .stream(1)) {
          total += row.value;
        }
        return total;
      });
    },
    async nestedTransaction() {
      await database.transaction().execute(async (transaction) => {
        await writeValue(transaction, 999);
        await database.transaction().execute(async () => {});
      });
    },
    async readSqlAfterBarrier(barrier: () => Promise<void>, attempted: () => Promise<void>) {
      await barrier();
      const values = sql
        .exec<{ value: number }>("SELECT value FROM dialect_values ORDER BY value")
        .toArray();
      await attempted();
      return values;
    },
    async readKvAfterBarrier(barrier: () => Promise<void>, attempted: () => Promise<void>) {
      await barrier();
      const reading = state.storage.get<number>("value");
      await attempted();
      return await reading;
    },
    async inspect() {
      return {
        values: await database.selectFrom("dialect_values").selectAll().orderBy("value").execute(),
        value: (await state.storage.get<number>("value")) ?? null,
        count: (await state.storage.get<number>("count")) ?? 0,
        alarm: await state.storage.getAlarm(),
      };
    },
  };
}
