import { describe, expect, test, assert } from "vitest";

import type { TypeCheckFileSource } from "./compile-worker";
import {
  createCompileWorkerServiceRequest,
  createCompileWorkerServiceResponse,
  createTypeCheckFilesServiceRequest,
  readCompileWorkerServiceRequest,
  readCompileWorkerServiceResponse,
  readTypeCheckFilesServiceRequest,
} from "./compiler-service-protocol";
import { createWorkerBundle } from "./worker-bundle";

function createTypeCheckFileSources(
  files: Readonly<Record<string, string>>,
): TypeCheckFileSource[] {
  return Object.entries(files).map(([path, content]) => ({
    path,
    read: async () => content,
  }));
}

async function materializeTypeCheckFiles(
  files: AsyncIterable<readonly [path: string, content: string]>,
) {
  const materializedFiles: Record<string, string> = {};
  for await (const [path, content] of files) {
    materializedFiles[path] = content;
  }
  return materializedFiles;
}

describe("compiler service protocol", () => {
  test("round-trips complete build projects", async () => {
    const input = {
      files: {
        "src/index.ts": 'import value from "dependency"; export default value;',
        "node_modules/dependency/package.json": JSON.stringify({
          name: "dependency",
          exports: "./index.js",
        }),
        "node_modules/dependency/index.js": "export default 42;",
      },
      entryPoint: "src/index.ts",
      dependencies: {},
      runtime: {
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
      },
    };

    await expect(
      readCompileWorkerServiceRequest(createCompileWorkerServiceRequest(input)),
    ).resolves.toEqual(input);
  });

  test("preserves compiler file paths that match object prototype keys", async () => {
    const files = Object.fromEntries([
      ["__proto__", "export default 'prototype';"],
      ["toString", "export default 'string';"],
    ]);

    const project = await readCompileWorkerServiceRequest(
      createCompileWorkerServiceRequest({
        files,
        entryPoint: "__proto__",
        dependencies: {},
        runtime: {
          compatibilityDate: "2026-08-06",
          compatibilityFlags: [],
        },
      }),
    );

    assert(Object.hasOwn(project.files, "__proto__"));
    assert(Object.hasOwn(project.files, "toString"));
    assert(project.files.__proto__ === "export default 'prototype';");
    assert(
      Object.getOwnPropertyDescriptor(project.files, "toString")?.value ===
        "export default 'string';",
    );
  });

  test("streams complete type-check projects with concurrent source reads", async () => {
    const files = {
      "workspace/example.js": "declaredValue.name;",
      "workspace/globals.d.ts": "declare const declaredValue: { name: string };",
    };
    let activeReads = 0;
    let maximumActiveReads = 0;
    const input = {
      files: createTypeCheckFileSources(files).map((file) => ({
        path: file.path,
        read: async () => {
          activeReads += 1;
          maximumActiveReads = Math.max(maximumActiveReads, activeReads);
          await Promise.resolve();
          const content = await file.read();
          activeReads -= 1;
          return content;
        },
      })),
      sourcePaths: ["workspace/example.js"],
    };

    const project = await readTypeCheckFilesServiceRequest(
      createTypeCheckFilesServiceRequest(input),
    );

    expect(project.sourcePaths).toEqual(input.sourcePaths);
    await expect(materializeTypeCheckFiles(project.files)).resolves.toEqual(files);
    expect(maximumActiveReads).toBe(input.files.length);
  });

  test("round-trips emitted Worker modules", async () => {
    const result = {
      bundle: createWorkerBundle({
        mainModule: "worker.js",
        modules: {
          "worker.js": "export default {};",
          "chunk.js": "export const value = 42;",
        },
        runtime: {
          compatibilityDate: "2026-08-06",
          compatibilityFlags: [],
        },
      }),
      warnings: ["example warning"],
    };

    await expect(
      readCompileWorkerServiceResponse(createCompileWorkerServiceResponse(result)),
    ).resolves.toEqual(result);
  });
});
