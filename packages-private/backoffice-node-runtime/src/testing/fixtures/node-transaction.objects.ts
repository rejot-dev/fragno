import type {
  NodeDurableObjectSqlStorage,
  NodeDurableObjectTransaction,
} from "../../runtime/node-durable-object-storage";
import type { NodeRuntimeObjectContext } from "../../runtime/node-runtime-object";

/** Exercises SQL, KV, alarms, and asynchronous transaction isolation on the worker-owned connection. */
export function createTransactionObject({ state, nowEpochMs }: NodeRuntimeObjectContext) {
  state.storage.transactionSync(() => {
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS application_values (value INTEGER NOT NULL)",
    );
  });
  let savedTransaction: NodeDurableObjectTransaction | null = null;
  let savedSql: NodeDurableObjectSqlStorage | null = null;
  return {
    async inspect() {
      return {
        values: state.storage.sql
          .exec<{ value: number }>("SELECT value FROM application_values ORDER BY value")
          .toArray()
          .map((row) => row.value),
        value: (await state.storage.get<number>("value")) ?? null,
        alarm: await state.storage.getAlarm(),
        delivered: (await state.storage.get<number>("delivered")) ?? 0,
      };
    },
    async change(value: number, fail: boolean, alarm: number | null) {
      await state.storage.transaction(async (transaction) => {
        state.storage.sql.exec("INSERT INTO application_values (value) VALUES (?)", value);
        await transaction.put("value", value);
        if (alarm !== null) {
          await transaction.setAlarm(alarm);
        }
        if (fail) {
          throw new Error("EXPECTED_TRANSACTION_ROLLBACK");
        }
      });
    },
    changeSync(value: number, fail: boolean) {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("INSERT INTO application_values (value) VALUES (?)", value);
        state.storage.sql.exec("INSERT INTO application_values (value) VALUES (?)", value + 1);
        if (fail) {
          throw new Error("EXPECTED_SYNC_TRANSACTION_ROLLBACK");
        }
      });
    },
    invalidSyncCallback() {
      return state.storage.transactionSync(async () => {
        state.storage.sql.exec("INSERT INTO application_values (value) VALUES (998)");
        await Promise.resolve();
        state.storage.sql.exec("INSERT INTO application_values (value) VALUES (999)");
      });
    },
    async holdTransaction(value: number, barrier: () => Promise<void>, fail: boolean) {
      await state.storage.transaction(async (transaction) => {
        state.storage.sql.exec("INSERT INTO application_values (value) VALUES (?)", value);
        await transaction.put("value", value);
        await barrier();
        if (fail) {
          throw new Error("EXPECTED_TRANSACTION_ROLLBACK");
        }
      });
    },
    startTransactionAndReturn(value: number, barrier: () => Promise<void>) {
      const transaction = state.storage.transaction(async () => {
        state.storage.sql.exec("INSERT INTO application_values (value) VALUES (?)", value);
        await state.storage.put("value", value);
        await barrier();
      });
      state.waitUntil(transaction);
      return value;
    },
    async readAfterBarrier(barrier: () => Promise<void>, attempted: () => Promise<void>) {
      await barrier();
      const reading = state.storage.get<number>("value");
      await attempted();
      return await reading;
    },
    async readSqlAfterBarrier(barrier: () => Promise<void>, attempted: () => Promise<void>) {
      await barrier();
      const values = state.storage.sql
        .exec<{ value: number }>("SELECT value FROM application_values ORDER BY value")
        .toArray();
      await attempted();
      return values;
    },
    async cancelAlarm(fail: boolean) {
      await state.storage.transaction(async (transaction) => {
        await transaction.deleteAlarm();
        await transaction.put("value", 99);
        if (fail) {
          throw new Error("EXPECTED_TRANSACTION_ROLLBACK");
        }
      });
    },
    async rollbackExplicitly() {
      return await state.storage.transaction(async (transaction) => {
        state.storage.sql.exec("INSERT INTO application_values (value) VALUES (999)");
        await transaction.put("value", 999);
        transaction.rollback();
        return "cancelled";
      });
    },
    async retainTransaction() {
      await state.storage.transaction(async (transaction) => {
        savedTransaction = transaction;
        savedSql = state.storage.sql;
        await transaction.put("retained", true);
      });
    },
    useRetainedSql() {
      if (!savedSql) {
        throw new Error("TRANSACTION_FIXTURE_HANDLE_MISSING");
      }
      savedSql.exec("INSERT INTO application_values (value) VALUES (999)");
    },
    async useRetainedTransaction() {
      if (!savedTransaction) {
        throw new Error("TRANSACTION_FIXTURE_HANDLE_MISSING");
      }
      await savedTransaction.put("value", 999);
    },
    async nestedTransaction() {
      await state.storage.transaction(async () => {
        await state.storage.transaction(async () => {});
      });
    },
    async alarm() {
      await state.storage.transaction(async (transaction) => {
        const delivered = (await transaction.get<number>("delivered")) ?? 0;
        await transaction.put("delivered", delivered + 1);
        if (delivered === 0) {
          await transaction.setAlarm(nowEpochMs() + 10);
        }
      });
    },
    async holdAlarmChange(timestamp: number, barrier: () => Promise<void>, fail: boolean) {
      await state.storage.transaction(async (transaction) => {
        await transaction.setAlarm(timestamp);
        await barrier();
        if (fail) {
          throw new Error("EXPECTED_TRANSACTION_ROLLBACK");
        }
      });
    },
    async staleContinuation(barrier: () => Promise<void>) {
      const completed = Promise.withResolvers<string>();
      await state.storage.transaction(async () => {
        void (async () => {
          await barrier();
          try {
            await state.storage.put("value", 999);
            completed.resolve("unexpected write");
          } catch (error) {
            completed.resolve((error as Error).message);
          }
        })();
      });
      return await completed.promise;
    },
    async kvShape() {
      await state.storage.put({ one: 1, two: 2 });
      const missing = [...(await state.storage.get<number>(["one", "missing"]))];
      const deleted = await state.storage.delete(["one", "two", "missing"]);
      return { missing, deleted };
    },
  };
}
