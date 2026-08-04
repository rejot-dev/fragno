import { describe, expect, test } from "vitest";

import { compileInMemoryWorker } from "./compile-worker.in-memory";

const runtime = { compatibilityDate: "2026-06-11" };

describe("compileInMemoryWorker", () => {
  test("creates a bundle from one JavaScript entry point", async () => {
    await expect(
      compileInMemoryWorker({
        files: { "worker.js": "export default {};" },
        entryPoint: "worker.js",
        runtime,
      }),
    ).resolves.toMatchObject({
      bundle: {
        mainModule: "worker.js",
        modules: { "worker.js": "export default {};" },
      },
      warnings: [],
    });
  });

  test("rejects npm dependencies and source graphs it cannot execute", async () => {
    await expect(
      compileInMemoryWorker({
        files: { "worker.js": "export default {};" },
        entryPoint: "worker.js",
        dependencies: { zod: "4.3.5" },
        runtime,
      }),
    ).rejects.toThrow("does not support npm dependencies");

    await expect(
      compileInMemoryWorker({
        files: {
          "worker.js": 'import "./helper.js"; export default {};',
          "helper.js": "export {};",
        },
        entryPoint: "worker.js",
        runtime,
      }),
    ).rejects.toThrow("requires one JavaScript entry point");
  });
});
