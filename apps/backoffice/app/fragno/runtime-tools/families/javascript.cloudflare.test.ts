import { assert, describe, expect, test } from "vitest";

import { env } from "cloudflare:workers";
import { InMemoryFs } from "just-bash";

import { runBackofficeJavaScriptModule } from "@/fragno/codemode/javascript-module-execute";
import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import { createTrustedSystemBackofficeToolContext } from "@/fragno/runtime-tools/runtime-tools";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import { createJavaScriptRuntime } from "./javascript-runtime";

function createTestJavaScriptStateBackend(fileSystem: InMemoryFs): BackofficeStateBackend {
  return {
    readFile: async (path) => await fileSystem.readFile(path),
    readdirWithFileTypes: async (path) =>
      (await fileSystem.readdirWithFileTypes(path))
        .filter((entry) => !entry.isSymbolicLink)
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory ? ("directory" as const) : ("file" as const),
        })),
    resolvePath: (base, path) => fileSystem.resolvePath(base, path),
  } as BackofficeStateBackend;
}

describe("JavaScript file execution in workerd", () => {
  test("runs a saved JavaScript file without type checking", async () => {
    const fileSystem = new InMemoryFs();
    await fileSystem.mkdir("/workspace/scripts", { recursive: true });
    await fileSystem.writeFile(
      "/workspace/scripts/example.js",
      `/** @type {string} */
      const value = await Promise.resolve(42);
      console.log("running saved file", value, typeof js.run);

      export default function hello() {
        console.log("default export should not run");
      }`,
    );
    const runtime = createJavaScriptRuntime({
      getStateBackend: async () => createTestJavaScriptStateBackend(fileSystem),
      typeCheckFiles: null,
      executeModule: async (code, toolContext) =>
        await runBackofficeJavaScriptModule({
          code,
          env,
          families: runtimeToolFamilies,
          toolContext,
        }),
    });
    const toolContext = createTrustedSystemBackofficeToolContext({
      runtimes: { javascript: runtime },
    });
    assert(runtime.runFile);

    await expect(
      runtime.runFile({ path: "/workspace/scripts/example.js" }, toolContext),
    ).resolves.toEqual({
      status: "success",
      path: "/workspace/scripts/example.js",
      logs: ["running saved file 42 function"],
    });
  });
});
