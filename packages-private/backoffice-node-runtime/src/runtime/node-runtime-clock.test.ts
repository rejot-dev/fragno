import { expect, test } from "vitest";

import { Worker } from "node:worker_threads";

import {
  createManualNodeRuntimeClock,
  readNodeRuntimeMonotonicMilliseconds,
} from "./node-runtime-clock";

test("system monotonic time is comparable between the main thread and an object worker", async () => {
  const before = readNodeRuntimeMonotonicMilliseconds({ kind: "system" });
  const sample = await readWorkerClock({ kind: "system" });
  const after = readNodeRuntimeMonotonicMilliseconds({ kind: "system" });
  expect(sample.monotonicMs).toBeGreaterThanOrEqual(before);
  expect(sample.monotonicMs).toBeLessThanOrEqual(after);
});

test("a shared manual clock can move wall time backwards without reversing worker elapsed time", async () => {
  const clock = createManualNodeRuntimeClock(1_000);
  clock.advanceBy(200);
  clock.setEpochMilliseconds(500);
  clock.advanceMonotonicBy(300);
  expect(await readWorkerClock(clock.source)).toEqual({ epochMs: 500, monotonicMs: 500 });
});

async function readWorkerClock(
  clock: Parameters<typeof readNodeRuntimeMonotonicMilliseconds>[0],
): Promise<{ epochMs: number; monotonicMs: number }> {
  const worker = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    import("@fragno-private/backoffice-node-runtime/node-runtime-clock").then(({ readNodeRuntimeEpochMilliseconds, readNodeRuntimeMonotonicMilliseconds }) => {
      parentPort.postMessage({
        epochMs: readNodeRuntimeEpochMilliseconds(workerData),
        monotonicMs: readNodeRuntimeMonotonicMilliseconds(workerData),
      });
    });
  `,
    { eval: true, workerData: clock },
  );
  try {
    return await new Promise((resolve, reject) => {
      worker.once("message", (message: { epochMs: number; monotonicMs: number }) =>
        resolve(message),
      );
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`CLOCK_SCENARIO_WORKER_EXITED:${code}`)));
    });
  } finally {
    await worker.terminate();
  }
}
