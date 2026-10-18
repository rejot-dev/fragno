import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { scrypt } from "node:crypto";
import { writeFile as writeFileCallback } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { setTimeout as timerPromise } from "node:timers/promises";
import { promisify } from "node:util";

import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { RpcTarget } from "capnweb";
import { Kysely } from "kysely";

import type { NodeRuntimeObjectContext } from "../../runtime/node-runtime-object";

type NativeInputKind =
  | "crypto"
  | "crypto-promise"
  | "webcrypto"
  | "timer"
  | "timer-promise"
  | "filesystem"
  | "filesystem-callback"
  | "filesystem-handle"
  | "fetch"
  | "body"
  | "stream-reader"
  | "stream-iterator"
  | "abort";

type InputGateConfiguration = {
  kind: NativeInputKind;
  filename: string;
  url: string;
  nativeCompletion: SharedArrayBuffer;
};

/** Starts a real foreign native operation from a captured request after another request owns SQL. */
export function createInputGateObject({
  state,
  input,
  onShutdown,
}: NodeRuntimeObjectContext<InputGateConfiguration>) {
  const database = new Kysely<{ input_values: { value: number } }>({
    dialect: new DurableObjectDialect({ ctx: state, queryInstrumentation: null }),
  });
  const sql = state.storage.sql;
  const nativeCompletion = new Int32Array(input.nativeCompletion);
  let startPendingInput: (() => void) | null = null;
  let readFinished = false;
  let pendingResponse: Response | null = null;
  let prepareTimer:
    | ((kind: "timeout" | "immediate" | "interval") => NodeJS.Timeout | NodeJS.Immediate)
    | null = null;
  let timerCallbacks = 0;
  onShutdown(() => database.destroy());
  void state.blockConcurrencyWhile(async () => {
    await database.schema
      .createTable("input_values")
      .ifNotExists()
      .addColumn("value", "integer", (column) => column.notNull())
      .execute();
    await database.insertInto("input_values").values({ value: 1 }).execute();
  });

  async function nativeInput(): Promise<void> {
    // Observe the real provider completing, without replacing it or changing its delivery.
    // Completion of the C++ request precedes the facade's application-facing callback/promise.
    const ids = new Set<number>();
    const resourceTypes = new Set([
      "SCRYPTREQUEST",
      "HASHREQUEST",
      "Timeout",
      "FSREQPROMISE",
      "FSREQCALLBACK",
    ]);
    let registering = true;
    const observer = createHook({
      init(id, type) {
        if (registering && resourceTypes.has(type)) {
          ids.add(id);
        }
      },
      before(id) {
        if (ids.has(id)) {
          Atomics.store(nativeCompletion, 0, 1);
          Atomics.notify(nativeCompletion, 0);
          observer.disable();
        }
      },
    });
    observer.enable();
    let completion: Promise<unknown>;
    switch (input.kind) {
      case "crypto":
        completion = new Promise<Buffer>((resolve, reject) => {
          scrypt("input-gate-password", "input-gate-salt", 32, (error, key) => {
            if (error) {
              reject(error);
            } else {
              resolve(key);
            }
          });
        });
        break;
      case "crypto-promise":
        completion = promisify(scrypt)("input-gate-password", "input-gate-salt", 32);
        break;
      case "webcrypto":
        completion = crypto.subtle.digest("SHA-256", new Uint8Array([1, 2, 3]));
        break;
      case "timer":
        completion = new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        break;
      case "timer-promise":
        completion = timerPromise(0);
        break;
      case "abort":
        completion = new Promise<void>((resolve) => {
          AbortSignal.timeout(0).addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        });
        break;
      case "filesystem":
        completion = writeFile(input.filename, "native file input");
        break;
      case "filesystem-callback":
        completion = new Promise<void>((resolve, reject) => {
          writeFileCallback(input.filename, "native file input", (error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
        break;
      case "filesystem-handle":
        completion = (async () => {
          const handle = await open(input.filename, "w");
          try {
            await handle.writeFile("native file input");
          } finally {
            await handle.close();
          }
        })();
        break;
      case "fetch":
        completion = fetch(input.url);
        break;
      case "body":
      case "stream-reader":
      case "stream-iterator":
        completion = (async () => {
          const response = pendingResponse ?? (await fetch(input.url));
          if (input.kind === "stream-reader") {
            return await response.body!.getReader().read();
          }
          if (input.kind === "stream-iterator") {
            return await response.body!.values().next();
          }
          return await response.text();
        })();
        break;
    }
    registering = false;
    try {
      await completion;
    } finally {
      observer.disable();
    }
  }

  return {
    async readAfterNativeInput(entered: () => Promise<void>) {
      if (["body", "stream-reader", "stream-iterator"].includes(input.kind)) {
        pendingResponse = await fetch(input.url);
      }
      const result = Promise.withResolvers<void>();
      const restore = AsyncLocalStorage.snapshot();
      startPendingInput = () => {
        void restore(nativeInput).then(result.resolve, result.reject);
      };
      await entered();
      await result.promise;
      const rows = await database.selectFrom("input_values").selectAll().orderBy("value").execute();
      readFinished = true;
      return rows;
    },
    async holdTransaction(
      started: () => Promise<void>,
      release: () => Promise<void>,
      rollback: boolean,
    ) {
      await database.transaction().execute(async (transaction) => {
        await transaction.insertInto("input_values").values({ value: 2 }).execute();
        if (!startPendingInput) {
          throw new Error("NODE_INPUT_GATE_FIXTURE_INPUT_MISSING");
        }
        startPendingInput();
        await started();
        await release();
        if (readFinished) {
          throw new Error("NODE_INPUT_GATE_FIXTURE_FOREIGN_INPUT_RESUMED");
        }
        if (rollback) {
          throw new Error("EXPECTED_INPUT_GATE_ROLLBACK");
        }
      });
    },
    async owningIoProgress() {
      await database.transaction().execute(async (transaction) => {
        await transaction.insertInto("input_values").values({ value: 3 }).execute();
        await nativeInput();
        await transaction.insertInto("input_values").values({ value: 4 }).execute();
      });
      return await database.selectFrom("input_values").selectAll().orderBy("value").execute();
    },
    prepareCancelableTimer() {
      const restore = AsyncLocalStorage.snapshot();
      prepareTimer = (kind) =>
        restore(() => {
          const ids = new Set<number>();
          let registering = true;
          const observer = createHook({
            init(id, type) {
              if (registering && (type === "Timeout" || type === "Immediate")) {
                ids.add(id);
              }
            },
            before(id) {
              if (ids.has(id)) {
                Atomics.store(nativeCompletion, 0, 1);
                Atomics.notify(nativeCompletion, 0);
                observer.disable();
              }
            },
          });
          observer.enable();
          const callback = () => {
            timerCallbacks += 1;
          };
          const timer =
            kind === "immediate"
              ? setImmediate(callback)
              : kind === "interval"
                ? setInterval(callback, 1)
                : setTimeout(callback, 0);
          registering = false;
          return timer;
        });
    },
    async cancelQueuedTimer(
      mode:
        | "number"
        | "clear"
        | "dispose"
        | "immediate-clear"
        | "immediate-dispose"
        | "interval-clear"
        | "refresh",
      started: () => Promise<void>,
      release: () => Promise<void>,
    ) {
      await database.transaction().execute(async () => {
        if (!prepareTimer) {
          throw new Error("NODE_INPUT_GATE_FIXTURE_TIMER_MISSING");
        }
        const immediate = mode.startsWith("immediate");
        const timer = prepareTimer(
          immediate ? "immediate" : mode === "interval-clear" ? "interval" : "timeout",
        );
        await started();
        await release();
        if (mode === "number") {
          clearTimeout(Number(timer));
        } else if (mode.endsWith("dispose")) {
          timer[Symbol.dispose]();
        } else if (mode === "refresh") {
          (timer as NodeJS.Timeout).refresh();
        } else if (immediate) {
          clearImmediate(timer as NodeJS.Immediate);
        } else {
          clearTimeout(timer as NodeJS.Timeout);
        }
      });
      await timerPromise(0);
      return timerCallbacks;
    },
    async callbackReentry(invoke: (callback: () => Promise<number>) => Promise<number>) {
      return await database.transaction().execute(async (transaction) => {
        await transaction.insertInto("input_values").values({ value: 5 }).execute();
        return await invoke(
          async () =>
            sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM input_values").one().count,
        );
      });
    },
    async callbackTargetReentry(
      invoke: (callback: { count(): Promise<number> }) => Promise<number>,
    ) {
      class Counter extends RpcTarget {
        async count() {
          return sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM input_values").one()
            .count;
        }
      }
      return await database.transaction().execute(async (transaction) => {
        await transaction.insertInto("input_values").values({ value: 5 }).execute();
        return await invoke(new Counter());
      });
    },
    async blockAndStartInput(started: () => Promise<void>, release: () => Promise<void>) {
      await state.blockConcurrencyWhile(async () => {
        if (!startPendingInput) {
          throw new Error("NODE_INPUT_GATE_FIXTURE_INPUT_MISSING");
        }
        startPendingInput();
        await started();
        await release();
        if (readFinished) {
          throw new Error("NODE_INPUT_GATE_FIXTURE_FOREIGN_INPUT_RESUMED");
        }
        sql.exec("INSERT INTO input_values VALUES (2)");
      });
    },
  };
}
