import { describe, expect, test } from "vitest";

import type { TypeCheckFileSource } from "@/backoffice-runtime/dynamic-workers/compile-worker";
import {
  createCompileWorkerServiceRequest,
  createTypeCheckFilesServiceRequest,
  readCompileWorkerServiceResponse,
  readTypeCheckFilesServiceResponse,
} from "@/backoffice-runtime/dynamic-workers/compiler-service-protocol";

import CodemodeCompilerWorker from "../compiler";
import { typeCheckProject } from "./type-check-project";

function createTypeCheckFileSources(
  files: Readonly<Record<string, string>>,
): TypeCheckFileSource[] {
  return Object.entries(files).map(([path, content]) => ({
    path,
    read: async () => content,
  }));
}

async function* streamTypeCheckFiles(files: Readonly<Record<string, string>>) {
  for (const entry of Object.entries(files)) {
    yield entry as readonly [string, string];
  }
}

describe("codemode compiler in workerd", () => {
  test("streams TypeScript source and the emitted Worker bundle", async () => {
    const service = Object.create(CodemodeCompilerWorker.prototype) as CodemodeCompilerWorker;
    await expect(
      readCompileWorkerServiceResponse(
        await service.compileWorker(
          createCompileWorkerServiceRequest({
            files: {
              "worker.ts": "const value: number = 42; export default value;",
            },
            entryPoint: "worker.ts",
            dependencies: {},
            runtime: {
              compatibilityDate: "2026-08-06",
              compatibilityFlags: ["nodejs_compat"],
            },
          }),
        ),
      ),
    ).resolves.toMatchObject({
      bundle: {
        mainModule: expect.any(String),
        modules: expect.any(Object),
      },
    });
  }, 60_000);

  test("type-checks streamed JavaScript against caller-provided declarations", async () => {
    const files = {
      "workspace/example.js": "const value = declaredValue; const invalid = value.missing;",
      "workspace/globals.d.ts": "declare const declaredValue: { name: string };",
    };
    const sourcePaths = ["workspace/example.js"];

    await expect(
      typeCheckProject({ files: streamTypeCheckFiles(files), sourcePaths }),
    ).resolves.toEqual({
      diagnostics: [
        expect.objectContaining({
          code: 2339,
          path: "workspace/example.js",
          line: 1,
        }),
      ],
    });

    const service = Object.create(CodemodeCompilerWorker.prototype) as CodemodeCompilerWorker;
    await expect(
      readTypeCheckFilesServiceResponse(
        await service.typeCheckFiles(
          createTypeCheckFilesServiceRequest({
            files: createTypeCheckFileSources(files),
            sourcePaths,
          }),
        ),
      ),
    ).resolves.toEqual({
      diagnostics: [
        expect.objectContaining({
          code: 2339,
          path: "workspace/example.js",
          line: 1,
        }),
      ],
    });
  }, 60_000);
});
