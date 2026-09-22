import { describe, expect, test } from "vitest";

import { WorkerCompilationError } from "@/backoffice-runtime/dynamic-workers/compile-worker";

import { buildWorkerProject } from "./build-worker-project";

const runtime = { compatibilityDate: "2026-06-11", compatibilityFlags: [] };

describe("buildWorkerProject", () => {
  test("reserves package configuration for the compiler", async () => {
    await expect(
      buildWorkerProject({
        files: {
          "src/index.ts": "export default {};",
          "package.json": "{}",
        },
        entryPoint: "src/index.ts",
        dependencies: {},
        runtime,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    } satisfies Partial<WorkerCompilationError>);
  });

  test("requires the entry point to be present in the source files", async () => {
    await expect(
      buildWorkerProject({
        files: { "src/other.ts": "export default {};" },
        entryPoint: "src/index.ts",
        dependencies: {},
        runtime,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    } satisfies Partial<WorkerCompilationError>);
  });

  test("requires dependency names and versions", async () => {
    await expect(
      buildWorkerProject({
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
