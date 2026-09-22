import { assert, describe, expect, test, vi } from "vitest";

import { createTrustedSystemBackofficeToolContext } from "@/fragno/runtime-tools/runtime-tools";

import { javaScriptCheckToolFamily, javaScriptRunToolFamily } from "./javascript";
import type { JavaScriptRuntime } from "./javascript-runtime";

function createJavaScriptTestRuntime(): JavaScriptRuntime {
  return {
    checkFile: vi.fn(async ({ path }) => ({
      path,
      valid: false,
      diagnostics: [
        {
          code: 2322,
          path: "workspace/example.js",
          line: 1,
          column: 7,
          message: "Type 'number' is not assignable to type 'string'.",
        },
      ],
    })),
    runFile: vi.fn(async ({ path }) => ({
      status: "success" as const,
      path,
      logs: ["running"],
    })),
  };
}

describe("JavaScript runtime tool families", () => {
  test("exposes js.check through the runtime tool contract", async () => {
    const runtime = createJavaScriptTestRuntime();
    const tool = javaScriptCheckToolFamily.tools[0];
    assert(tool);

    await expect(
      tool.execute(
        { path: "/workspace/example.js" },
        createTrustedSystemBackofficeToolContext({ runtimes: { javascript: runtime } }),
      ),
    ).resolves.toMatchObject({
      path: "/workspace/example.js",
      valid: false,
      diagnostics: [expect.objectContaining({ code: 2322 })],
    });
  });

  test("runs a relative file path with js.run", async () => {
    const runtime = createJavaScriptTestRuntime();
    const context = createTrustedSystemBackofficeToolContext({
      runtimes: { javascript: runtime },
    });
    const tool = javaScriptRunToolFamily.tools[0];
    const bash = tool?.adapters?.bash;
    assert(bash?.execute);
    const input = bash.parse(["scripts/example.js"]);

    await expect(
      bash.execute({
        input,
        args: ["scripts/example.js"],
        context,
        commandOutput: { format: "text" },
        shell: {
          cwd: "/workspace",
          fs: {
            resolvePath: (cwd, path) => `${cwd}/${path}`,
            writeFile: async () => {},
          },
        },
      }),
    ).resolves.toEqual({ stdout: "running\n" });
    expect(runtime.runFile).toHaveBeenCalledWith(
      { path: "/workspace/scripts/example.js" },
      context,
    );
  });
});
