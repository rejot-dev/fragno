// The Workers test pool loads the main module on first Durable Object access; load it untimed.
import "../../../../workers/vitest-env";

import { afterAll, assert, describe, expect, test } from "vitest";

import { env } from "cloudflare:workers";
import { InMemoryFs } from "just-bash";

import { createCloudflareBackofficeObjectRegistry } from "@/backoffice-runtime/cloudflare-durable-object-factory";
import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { drainCodemodeAlarms } from "@/fragno/codemode/codemode-alarms.test-support";
import { codemodeRunnerFor } from "@/fragno/codemode/codemode-object-execute";
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
  afterAll(drainCodemodeAlarms);

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
      executeModule: async (program, toolContext) =>
        await runBackofficeJavaScriptModule({
          program,
          codemode: codemodeRunnerFor(
            createCloudflareBackofficeObjectRegistry(env as CloudflareEnv).codemode.singleton()
              .commands,
            createBackofficeSystemExecution({ kind: "system" }),
          ),
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
      runId: expect.any(String),
      logs: [{ at: expect.any(Number), channel: "log", text: "running saved file 42 function" }],
    });
  });
});
