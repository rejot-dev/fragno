import { describe, expect, test, vi } from "vitest";

import type { WorkerBundle } from "@/backoffice-runtime/dynamic-workers/worker-bundle";

import { DynamicWorkerExecutor, type DynamicWorkerRpcCall } from "./codemode-executor";

const workerBundle: WorkerBundle = {
  mainModule: "executor.js",
  modules: { "executor.js": "export default {};" },
  runtime: {
    compatibilityDate: "2026-05-07",
    compatibilityFlags: [],
  },
};

describe("DynamicWorkerExecutor", () => {
  test("disposes the raw dynamic worker RPC call result", async () => {
    const disposeRpcCall = vi.fn();
    const disposeEntrypoint = vi.fn();
    const response = { result: "done" };
    const rpcCall = Object.assign(Promise.resolve(response), {
      [Symbol.dispose]: disposeRpcCall,
    }) satisfies DynamicWorkerRpcCall<typeof response>;
    const entrypoint = {
      evaluate: vi.fn(() => rpcCall),
      [Symbol.dispose]: disposeEntrypoint,
    };
    const loader = {
      get: vi.fn(() => ({
        getEntrypoint: () => entrypoint,
      })),
    } as unknown as WorkerLoader;
    const executor = new DynamicWorkerExecutor({ loader });

    await expect(executor.evaluateWorkerBundle(workerBundle, {})).resolves.toBe(response);

    expect(disposeRpcCall).toHaveBeenCalledOnce();
    expect(disposeEntrypoint).toHaveBeenCalledOnce();
  });
});
