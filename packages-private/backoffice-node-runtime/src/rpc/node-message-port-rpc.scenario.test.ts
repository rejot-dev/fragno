import { assert, expect, test } from "vitest";

import { MessageChannel, Worker } from "node:worker_threads";

import { createManualNodeRuntimeClock } from "../runtime/node-runtime-clock";
import { createNodeMessagePortRpcSession } from "./node-message-port-rpc";

test("a worker reply queued before suspension cannot escape after main-thread authority expires", async () => {
  const clock = createManualNodeRuntimeClock(100);
  const { port1, port2 } = new MessageChannel();
  const replyQueued = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const worker = new Worker(
    `
    const { workerData } = require("node:worker_threads");
    Promise.all([import("capnweb"), import(workerData.sessionModuleUrl)]).then(([{ RpcTarget }, { createNodeMessagePortRpcSession }]) => {
      class QueuedReplyTarget extends RpcTarget {
        ready() { return "ready"; }
        reply() {
          setImmediate(() => {
            Atomics.store(new Int32Array(workerData.replyQueued), 0, 1);
            Atomics.notify(new Int32Array(workerData.replyQueued), 0);
          });
          return "must-not-escape";
        }
      }
      createNodeMessagePortRpcSession(workerData.port, new QueuedReplyTarget(), null);
    });
  `,
    {
      eval: true,
      workerData: {
        port: port2,
        replyQueued: replyQueued.buffer,
        sessionModuleUrl: new URL("../../dist/rpc/node-message-port-rpc.js", import.meta.url).href,
      },
      transferList: [port2],
    },
  );
  const session = createNodeMessagePortRpcSession<{ ready(): string; reply(): string }>(
    port1,
    undefined,
    () => {
      if (clock.nowMonotonicMs() >= 400) {
        throw new Error("NODE_OBJECT_RUNTIME_NODE_AUTHORITY_FENCED");
      }
    },
  );
  worker.once("error", (error) => session.abort(error));
  worker.once("exit", (code) => session.abort(new Error(`QUEUED_REPLY_WORKER_EXITED:${code}`)));
  try {
    assert.equal(await session.remote.ready(), "ready");
    const pending = session.remote.reply();
    await Promise.resolve();
    // Block delivery in the main thread while the real worker serializes its successful reply.
    Atomics.wait(replyQueued, 0, 0, 2_000);
    assert.equal(Atomics.load(replyQueued, 0), 1);
    clock.advanceMonotonicBy(400);
    await expect(pending).rejects.toThrow("NODE_OBJECT_RUNTIME_NODE_AUTHORITY_FENCED");
    await expect(session.remote.reply()).rejects.toThrow(
      "NODE_OBJECT_RUNTIME_NODE_AUTHORITY_FENCED",
    );
  } finally {
    session.abort(new Error("QUEUED_REPLY_SCENARIO_CLOSED"));
    await worker.terminate();
  }
});
