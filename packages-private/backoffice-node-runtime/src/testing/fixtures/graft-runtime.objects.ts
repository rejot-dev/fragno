import { RpcTarget } from "capnweb";

import type { NodeRuntimeObjectContext } from "../../runtime/node-runtime-object";

class GraftCounterCapability extends RpcTarget {
  readonly #increment: (delta: number) => number;

  constructor(increment: (delta: number) => number) {
    super();
    this.#increment = increment;
  }

  increment(delta: number): number {
    return this.#increment(delta);
  }
}

/** Counter stores application rows and the runtime KV surface in the same Graft object database. */
export function createGraftCounterObject({ state }: NodeRuntimeObjectContext) {
  const initialization = state.blockConcurrencyWhile(() => {
    state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS graft_counter (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        count INTEGER NOT NULL
      ) STRICT`,
    );
    state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS graft_alarm_delivery (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        count INTEGER NOT NULL
      ) STRICT`,
    );
  });
  void initialization.catch(() => {});

  function readCount(): number {
    return (
      state.storage.sql
        .exec<{ count: number }>("SELECT count FROM graft_counter WHERE singleton = 1")
        .toArray()[0]?.count ?? 0
    );
  }

  function increment(delta: number): number {
    state.storage.sql.exec(
      `INSERT INTO graft_counter (singleton, count) VALUES (1, ?)
       ON CONFLICT(singleton) DO UPDATE SET count = graft_counter.count + excluded.count`,
      delta,
    );
    return readCount();
  }

  function readAlarmDeliveryCount(): number {
    return (
      state.storage.sql
        .exec<{ count: number }>("SELECT count FROM graft_alarm_delivery WHERE singleton = 1")
        .toArray()[0]?.count ?? 0
    );
  }

  return {
    inMemoryValue() {
      return "counter-instance";
    },
    increment,
    incrementMany(deltas: number[]) {
      for (const delta of deltas) {
        increment(delta);
      }
      return readCount();
    },
    operationCapability() {
      return new GraftCounterCapability(increment);
    },
    incrementThenThrow(delta: number): never {
      state.storage.sql.exec(
        `INSERT INTO graft_counter (singleton, count) VALUES (1, ?)
         ON CONFLICT(singleton) DO UPDATE SET count = graft_counter.count + excluded.count`,
        delta,
      );
      throw new Error("EXPECTED_GRAFT_COUNTER_FAILURE");
    },
    async writeCompatibilityValue(value: string) {
      await state.storage.put("compatibility-value", value);
    },
    async scheduleAlarm(timestamp: number) {
      await state.storage.setAlarm(timestamp);
    },
    async cancelAlarm() {
      await state.storage.deleteAlarm();
    },
    async rearmOnNextAlarm(timestamp: number) {
      await state.storage.put("alarm-rearm-at", timestamp);
    },
    async failNextAlarm() {
      await state.storage.put("alarm-fail-next", true);
    },
    async readAlarmState() {
      return {
        scheduledAt: await state.storage.getAlarm(),
        deliveryCount: readAlarmDeliveryCount(),
      };
    },
    async alarm() {
      state.storage.sql.exec(
        `INSERT INTO graft_alarm_delivery (singleton, count) VALUES (1, 1)
         ON CONFLICT(singleton) DO UPDATE SET count = graft_alarm_delivery.count + 1`,
      );
      const rearmAt = await state.storage.get<number>("alarm-rearm-at");
      if (rearmAt !== undefined) {
        await state.storage.delete("alarm-rearm-at");
        await state.storage.setAlarm(rearmAt);
      }
      if (await state.storage.get<boolean>("alarm-fail-next")) {
        await state.storage.delete("alarm-fail-next");
        throw new Error("EXPECTED_GRAFT_ALARM_FAILURE");
      }
    },
    async read() {
      return {
        count: readCount(),
        compatibilityValue: (await state.storage.get<string>("compatibility-value")) ?? null,
      };
    },
    async fetch() {
      return Response.json({
        count: readCount(),
        compatibilityValue: (await state.storage.get<string>("compatibility-value")) ?? null,
      });
    },
  };
}
