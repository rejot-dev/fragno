import { afterAll, beforeAll, expect, test, assert } from "vitest";

import { createServer, type ServerResponse } from "node:http";
import path from "node:path";

import { createManualNodeRuntimeClock } from "@fragno-private/backoffice-node-runtime/node-runtime-clock";
import { defineNodeRuntimeObject } from "@fragno-private/backoffice-node-runtime/node-runtime-object";
import {
  createNodeRuntimeScenarioEnvironment,
  createNodeRuntimeScenarioRuntime,
} from "@fragno-private/backoffice-node-runtime/node-runtime-scenario";

import type { createInputGateObject } from "../testing/fixtures/node-input-gate.objects";

type InputConfiguration = Parameters<typeof createInputGateObject>[0]["input"];
const kinds: InputConfiguration["kind"][] = [
  "crypto",
  "crypto-promise",
  "webcrypto",
  "timer",
  "timer-promise",
  "filesystem",
  "filesystem-callback",
  "filesystem-handle",
  "fetch",
  "body",
  "stream-reader",
  "stream-iterator",
  "abort",
];
let environment: Awaited<ReturnType<typeof createNodeRuntimeScenarioEnvironment>>;
beforeAll(async () => {
  environment = await createNodeRuntimeScenarioEnvironment();
});
afterAll(async () => {
  await environment.cleanup();
});

async function createInputRuntime(
  kind: InputConfiguration["kind"],
  url = "http://127.0.0.1:1/unused",
) {
  const storage = environment.createStorage();
  const nativeCompletion = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const runtime = createNodeRuntimeScenarioRuntime({
    storage,
    clock: createManualNodeRuntimeClock(0).source,
    objects: {
      INPUT: defineNodeRuntimeObject<typeof createInputGateObject>(
        new URL("../testing/fixtures/node-input-gate.objects.ts", import.meta.url),
        "createInputGateObject",
        {
          kind,
          filename: path.join(
            path.dirname(storage.configPath),
            `input-${storage.controlRemoteLogId}.txt`,
          ),
          url,
          nativeCompletion,
        },
      ),
    },
    objectEviction: { kind: "disabled" },
  });
  return { runtime, nativeCompletion: new Int32Array(nativeCompletion) };
}

async function waitForNativeCompletion(completion: Int32Array): Promise<void> {
  if (Atomics.load(completion, 0) === 0) {
    const waiting = Atomics.waitAsync(completion, 0, 0, 3_000);
    const result = waiting.async ? await waiting.value : waiting.value;
    expect(result).not.toBe("timed-out");
  }
  assert(Atomics.load(completion, 0) === 1);
}

async function createInputServer() {
  const input = Promise.withResolvers<ServerResponse>();
  const server = createServer((request, response) => {
    if (request.url === "/ready") {
      response.end("ready");
      return;
    }
    if (request.url === "/body") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.flushHeaders();
    }
    input.resolve(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("NODE_INPUT_GATE_TEST_LISTENER_INVALID");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    input: input.promise,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test.each(kinds)(
  "foreign %s completion waits for the unchanged dialect's transaction",
  async (kind) => {
    const server = await createInputServer();
    const { runtime, nativeCompletion } = await createInputRuntime(
      kind,
      `${server.origin}/${["body", "stream-reader", "stream-iterator"].includes(kind) ? "body" : "input"}`,
    );
    const readEntered = Promise.withResolvers<void>();
    const transactionEntered = Promise.withResolvers<void>();
    const releaseTransaction = Promise.withResolvers<void>();
    let readSettled = false;
    const calls: Promise<unknown>[] = [];
    try {
      using object = runtime.objects.INPUT.get("one");
      const reading = Promise.resolve(
        object.readAfterNativeInput(async () => {
          readEntered.resolve();
        }),
      ).then(
        (rows) => {
          readSettled = true;
          return rows;
        },
        (error: unknown) => {
          readSettled = true;
          throw error;
        },
      );
      void reading.catch(() => {});
      calls.push(reading);
      await readEntered.promise;
      const transaction = Promise.resolve(
        object.holdTransaction(
          async () => {
            transactionEntered.resolve();
          },
          async () => {
            await releaseTransaction.promise;
          },
          false,
        ),
      );
      void transaction.catch(() => {});
      calls.push(transaction);
      await transactionEntered.promise;
      if (["fetch", "body", "stream-reader", "stream-iterator"].includes(kind)) {
        const response = await server.input;
        await new Promise<void>((resolve) => {
          response.end("completed", resolve);
        });
      } else {
        await waitForNativeCompletion(nativeCompletion);
      }
      assert(!readSettled);
      releaseTransaction.resolve();
      await transaction;
      expect(await reading).toEqual([{ value: 1 }, { value: 2 }]);
    } finally {
      releaseTransaction.resolve();
      await Promise.allSettled(calls);
      await runtime.cleanup();
      await server.close();
    }
  },
);

test.each(kinds)(
  "owning %s completion progresses inside the unchanged dialect's transaction",
  async (kind) => {
    const server = await createInputServer();
    const { runtime } = await createInputRuntime(kind, `${server.origin}/ready`);
    try {
      using object = runtime.objects.INPUT.get("one");
      expect(await object.owningIoProgress()).toEqual([{ value: 1 }, { value: 3 }, { value: 4 }]);
    } finally {
      await runtime.cleanup();
      await server.close();
    }
  },
);

test.each([
  "number",
  "clear",
  "dispose",
  "immediate-clear",
  "immediate-dispose",
  "interval-clear",
  "refresh",
] as const)(
  "%s preserves cancellation or refresh after a timer input has already queued",
  async (mode) => {
    const { runtime, nativeCompletion } = await createInputRuntime("timer");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let result: Promise<number> | null = null;
    try {
      using object = runtime.objects.INPUT.get("one");
      await object.prepareCancelableTimer();
      result = Promise.resolve(
        object.cancelQueuedTimer(
          mode,
          async () => {
            entered.resolve();
          },
          async () => {
            await release.promise;
          },
        ),
      );
      void result.catch(() => {});
      await entered.promise;
      await waitForNativeCompletion(nativeCompletion);
      release.resolve();
      expect(await result).toBe(mode === "refresh" ? 1 : 0);
    } finally {
      release.resolve();
      if (result) {
        await Promise.allSettled([result]);
      }
      await runtime.cleanup();
    }
  },
);

test("a runtime-bound callback capability reenters its owning critical section", async () => {
  const { runtime } = await createInputRuntime("crypto");
  try {
    using object = runtime.objects.INPUT.get("one");
    assert((await object.callbackReentry(async (callback) => await callback())) === 2);
  } finally {
    await runtime.cleanup();
  }
});

test("a runtime-bound callback target preserves SQL ownership during RPC reentry", async () => {
  const { runtime } = await createInputRuntime("crypto");
  try {
    using object = runtime.objects.INPUT.get("one");
    assert((await object.callbackTargetReentry(async (callback) => await callback.count())) === 2);
  } finally {
    await runtime.cleanup();
  }
});

test.each(["rollback", "block"] as const)(
  "foreign native completion also waits for %s critical settlement",
  async (boundary) => {
    const { runtime, nativeCompletion } = await createInputRuntime("crypto");
    const readEntered = Promise.withResolvers<void>();
    const criticalEntered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const calls: Promise<unknown>[] = [];
    try {
      using object = runtime.objects.INPUT.get("one");
      const reading = Promise.resolve(
        object.readAfterNativeInput(async () => {
          readEntered.resolve();
        }),
      );
      void reading.catch(() => {});
      calls.push(reading);
      await readEntered.promise;
      const started = async () => {
        criticalEntered.resolve();
      };
      const finish = async () => {
        await release.promise;
      };
      const critical = Promise.resolve(
        boundary === "rollback"
          ? object.holdTransaction(started, finish, true)
          : object.blockAndStartInput(started, finish),
      );
      const settled =
        boundary === "rollback"
          ? expect(critical).rejects.toThrow("EXPECTED_INPUT_GATE_ROLLBACK")
          : critical;
      calls.push(settled);
      await criticalEntered.promise;
      await waitForNativeCompletion(nativeCompletion);
      release.resolve();
      await settled;
      expect(await reading).toEqual(
        boundary === "rollback" ? [{ value: 1 }] : [{ value: 1 }, { value: 2 }],
      );
    } finally {
      release.resolve();
      await Promise.allSettled(calls);
      await runtime.cleanup();
    }
  },
);
