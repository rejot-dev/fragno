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

  return {
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
