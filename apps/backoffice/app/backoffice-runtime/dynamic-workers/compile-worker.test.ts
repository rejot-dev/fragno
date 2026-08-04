import { describe, expect, test } from "vitest";

import { WorkerCompilationError, compileWorker } from "./compile-worker";

const runtime = { compatibilityDate: "2026-06-11" };

describe("compileWorker", () => {
  test("reserves package configuration for the compiler", async () => {
    await expect(
      compileWorker({
        files: {
          "src/index.ts": "export default {};",
          "package.json": "{}",
        },
        entryPoint: "src/index.ts",
        runtime,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    } satisfies Partial<WorkerCompilationError>);
  });

  test("requires the entry point to be present in the source files", async () => {
    await expect(
      compileWorker({
        files: { "src/other.ts": "export default {};" },
        entryPoint: "src/index.ts",
        runtime,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    } satisfies Partial<WorkerCompilationError>);
  });

  test("requires dependency names and versions", async () => {
    await expect(
      compileWorker({
        files: { "src/index.ts": "export default {};" },
        entryPoint: "src/index.ts",
        dependencies: { zod: "" },
        runtime,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    } satisfies Partial<WorkerCompilationError>);
  });
});
