import { isMainThread, threadId } from "node:worker_threads";

import type { NodeRuntimeObjectContext } from "@fragno-private/backoffice-node-runtime/node-runtime-object";
import { RpcTarget } from "capnweb";

type RuntimeShowcaseEventRow = {
  id: number;
  delta: number;
  label: string;
  created_at_ms: number;
};

type RuntimeShowcaseValues = {
  label: string;
  createdAt: Date;
  bytes: Uint8Array;
  total: bigint;
};

class RuntimeShowcaseCounterCapability extends RpcTarget {
  readonly #increment: (delta: number, label: string) => number;

  constructor(increment: (delta: number, label: string) => number) {
    super();
    this.#increment = increment;
  }

  increment(delta: number): number {
    return this.#increment(delta, "returned-capability");
  }
}

/** Demonstrates SQL, KV, alarms, waitUntil, fetch, callbacks, and returned RPC capabilities. */
export function createRuntimeShowcaseObject({ name, state, nowEpochMs }: NodeRuntimeObjectContext) {
  let memoryMutationCount = 0;
  const initialization = state.blockConcurrencyWhile(() => {
    state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS runtime_showcase_counter (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        count INTEGER NOT NULL
      ) STRICT`,
    );
    state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS runtime_showcase_events (
        id INTEGER PRIMARY KEY,
        delta INTEGER NOT NULL,
        label TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      ) STRICT`,
    );
  });
  void initialization.catch(() => {});

  function readCount(): number {
    return (
      state.storage.sql
        .exec<{ count: number }>("SELECT count FROM runtime_showcase_counter WHERE singleton = 1")
        .toArray()[0]?.count ?? 0
    );
  }

  function increment(delta: number, label: string): number {
    memoryMutationCount += 1;
    state.storage.sql.exec(
      `INSERT INTO runtime_showcase_counter (singleton, count) VALUES (1, ?)
       ON CONFLICT(singleton) DO UPDATE SET count = runtime_showcase_counter.count + excluded.count`,
      delta,
    );
    state.storage.sql.exec(
      `INSERT INTO runtime_showcase_events (delta, label, created_at_ms)
       VALUES (?, ?, ?)`,
      delta,
      label,
      nowEpochMs(),
    );
    return readCount();
  }

  async function readSnapshot() {
    const events = state.storage.sql
      .exec<RuntimeShowcaseEventRow>(
        `SELECT id, delta, label, created_at_ms
         FROM runtime_showcase_events
         ORDER BY id DESC
         LIMIT 10`,
      )
      .toArray()
      .map((event) => ({
        id: event.id,
        delta: event.delta,
        label: event.label,
        created_at_ms: event.created_at_ms,
      }));
    return {
      name,
      count: readCount(),
      events,
      compatibilityValue: (await state.storage.get<string>("demo:compatibility-value")) ?? null,
      alarmDeliveries: (await state.storage.get<number>("demo:alarm-deliveries")) ?? 0,
      backgroundNote: (await state.storage.get<string>("demo:background-note")) ?? null,
      alarm: await state.storage.getAlarm(),
      memoryMutationCount,
      databaseSize: state.storage.sql.databaseSize,
      worker: { threadId, isMainThread },
    };
  }

  return {
    increment(delta: number, label: string) {
      return increment(delta, label);
    },
    async read() {
      return await readSnapshot();
    },
    async writeCompatibilityValue(value: string) {
      await state.storage.put("demo:compatibility-value", value);
      return await readSnapshot();
    },
    async scheduleAlarm(delayMs: number) {
      const scheduledAtMs = nowEpochMs() + delayMs;
      await state.storage.setAlarm(scheduledAtMs);
      return { scheduledAtMs };
    },
    async startBackgroundNote(note: string) {
      state.waitUntil(
        (async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 25);
          });
          await state.storage.put("demo:background-note", note);
        })(),
      );
      return { accepted: true };
    },
    async callback(callback: (message: string) => Promise<string>) {
      return await callback(`callback from ${name} on worker ${threadId}`);
    },
    operationCapability() {
      return new RuntimeShowcaseCounterCapability(increment);
    },
    async exchangeValues(value: RuntimeShowcaseValues) {
      await state.storage.put("demo:rpc-values", value);
      value.label = "changed inside worker";
      value.bytes[0] = 9;
      return value;
    },
    async fetch(request: Request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/stream") {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`streamed by ${name} `));
              controller.enqueue(new TextEncoder().encode(`on worker ${threadId}`));
              controller.close();
            },
          }),
          { status: 202, headers: { "content-type": "text/plain; charset=utf-8" } },
        );
      }
      if (request.method === "POST" && pathname === "/increment") {
        const input = (await request.json()) as { delta: number; label: string };
        return Response.json({ count: increment(input.delta, input.label) }, { status: 201 });
      }
      return Response.json(await readSnapshot());
    },
    async alarm() {
      increment(1, "alarm");
      const alarmDeliveries = ((await state.storage.get<number>("demo:alarm-deliveries")) ?? 0) + 1;
      await state.storage.put("demo:alarm-deliveries", alarmDeliveries);
      state.waitUntil(
        state.storage.put(
          "demo:background-note",
          `alarm ${alarmDeliveries} completed at ${nowEpochMs()}`,
        ),
      );
    },
  };
}
