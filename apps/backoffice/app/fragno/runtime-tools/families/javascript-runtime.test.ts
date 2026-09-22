import { assert, describe, expect, test, vi } from "vitest";

import { InMemoryFs } from "just-bash";

import type { WorkerTypeChecker } from "@/backoffice-runtime/dynamic-workers/compile-worker";
import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import { createTrustedSystemBackofficeToolContext } from "@/fragno/runtime-tools/runtime-tools";

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

describe("createJavaScriptRuntime", () => {
  test("checks a JavaScript file with static declarations", async () => {
    const fileSystem = new InMemoryFs();
    await fileSystem.mkdir("/static/codemode/sources", { recursive: true });
    await fileSystem.mkdir("/workspace/types", { recursive: true });
    await fileSystem.writeFile("/workspace/example.js", "declaredMcpValue.toUpperCase();");
    await fileSystem.writeFile(
      "/workspace/types/globals.d.ts",
      "declare const declaredWorkspaceValue: number;",
    );
    await fileSystem.writeFile(
      "/static/codemode/sources/mcp.d.ts",
      "declare const declaredMcpValue: string;",
    );
    await fileSystem.writeFile("/workspace/ignored.txt", "not TypeScript input");
    let checkedFiles: Record<string, string> = {};
    const typeCheckFiles = vi.fn<WorkerTypeChecker>(async (input) => {
      checkedFiles = Object.fromEntries(
        await Promise.all(input.files.map(async (file) => [file.path, await file.read()] as const)),
      );
      return {
        diagnostics: [
          {
            code: 2339,
            path: "workspace/example.js",
            line: 1,
            column: 24,
            message: "Property 'missing' does not exist.",
          },
        ],
      };
    });
    const runtime = createJavaScriptRuntime({
      getStateBackend: async () => createTestJavaScriptStateBackend(fileSystem),
      typeCheckFiles,
      executeModule: null,
    });
    assert(runtime.checkFile);
    const readdirWithFileTypes = vi.spyOn(fileSystem, "readdirWithFileTypes");

    await expect(runtime.checkFile({ path: "/workspace/example.js" })).resolves.toEqual({
      path: "/workspace/example.js",
      valid: false,
      diagnostics: [
        {
          code: 2339,
          path: "/workspace/example.js",
          line: 1,
          column: 24,
          message: "Property 'missing' does not exist.",
        },
      ],
    });

    const input = typeCheckFiles.mock.calls[0]?.[0];
    assert(input);
    expect(input.sourcePaths).toEqual(["workspace/example.js"]);
    expect(checkedFiles).toEqual({
      "workspace/example.js": "declaredMcpValue.toUpperCase();",
      "static/codemode/sources/mcp.d.ts": "declare const declaredMcpValue: string;",
    });
    expect(readdirWithFileTypes).not.toHaveBeenCalledWith("/workspace");
  });

  test("rejects imports before type checking", async () => {
    const fileSystem = new InMemoryFs();
    await fileSystem.mkdir("/workspace", { recursive: true });
    await fileSystem.writeFile(
      "/workspace/example.js",
      "  import value from './helper.js';\nconsole.log(value);",
    );
    const typeCheckFiles = vi.fn<WorkerTypeChecker>(async () => ({ diagnostics: [] }));
    const runtime = createJavaScriptRuntime({
      getStateBackend: async () => createTestJavaScriptStateBackend(fileSystem),
      typeCheckFiles,
      executeModule: null,
    });
    assert(runtime.checkFile);

    await expect(runtime.checkFile({ path: "/workspace/example.js" })).resolves.toEqual({
      path: "/workspace/example.js",
      valid: false,
      diagnostics: [
        {
          code: 95001,
          path: "/workspace/example.js",
          line: 1,
          column: 3,
          message:
            "Standalone JavaScript import is not supported in '/workspace/example.js' at line 1, column 3. Saved JavaScript files must not import other modules.",
        },
      ],
    });
    expect(typeCheckFiles).not.toHaveBeenCalled();
  });

  test("ignores import-like text in comments and templates", async () => {
    const fileSystem = new InMemoryFs();
    await fileSystem.mkdir("/static", { recursive: true });
    await fileSystem.mkdir("/workspace", { recursive: true });
    await fileSystem.writeFile(
      "/workspace/example.js",
      `/* import value from "./unused.js"; */\nconst message = \`export * from "./unused.js"\`;`,
    );
    const typeCheckFiles = vi.fn<WorkerTypeChecker>(async () => ({ diagnostics: [] }));
    const runtime = createJavaScriptRuntime({
      getStateBackend: async () => createTestJavaScriptStateBackend(fileSystem),
      typeCheckFiles,
      executeModule: null,
    });
    assert(runtime.checkFile);

    await expect(runtime.checkFile({ path: "/workspace/example.js" })).resolves.toMatchObject({
      path: "/workspace/example.js",
      valid: true,
      diagnostics: [],
    });
    expect(typeCheckFiles).toHaveBeenCalledOnce();
  });

  test("rejects dynamic imports regardless of their position", async () => {
    const fileSystem = new InMemoryFs();
    await fileSystem.mkdir("/workspace", { recursive: true });
    await fileSystem.writeFile(
      "/workspace/example.js",
      `const value = await import("./helper.js");`,
    );
    const typeCheckFiles = vi.fn<WorkerTypeChecker>(async () => ({ diagnostics: [] }));
    const runtime = createJavaScriptRuntime({
      getStateBackend: async () => createTestJavaScriptStateBackend(fileSystem),
      typeCheckFiles,
      executeModule: null,
    });
    assert(runtime.checkFile);

    await expect(runtime.checkFile({ path: "/workspace/example.js" })).resolves.toMatchObject({
      path: "/workspace/example.js",
      valid: false,
      diagnostics: [
        expect.objectContaining({
          code: 95001,
          line: 1,
          column: 21,
        }),
      ],
    });
    expect(typeCheckFiles).not.toHaveBeenCalled();
  });

  test("allows import.meta in standalone JavaScript", async () => {
    const fileSystem = new InMemoryFs();
    await fileSystem.mkdir("/static", { recursive: true });
    await fileSystem.mkdir("/workspace", { recursive: true });
    await fileSystem.writeFile("/workspace/example.js", "console.log(import.meta.url);");
    const typeCheckFiles = vi.fn<WorkerTypeChecker>(async () => ({ diagnostics: [] }));
    const runtime = createJavaScriptRuntime({
      getStateBackend: async () => createTestJavaScriptStateBackend(fileSystem),
      typeCheckFiles,
      executeModule: null,
    });
    assert(runtime.checkFile);

    await expect(runtime.checkFile({ path: "/workspace/example.js" })).resolves.toMatchObject({
      path: "/workspace/example.js",
      valid: true,
      diagnostics: [],
    });
  });

  test("allows optional-chain property access named import", async () => {
    const fileSystem = new InMemoryFs();
    await fileSystem.mkdir("/static", { recursive: true });
    await fileSystem.mkdir("/workspace", { recursive: true });
    await fileSystem.writeFile("/workspace/example.js", "object?.import();");
    const typeCheckFiles = vi.fn<WorkerTypeChecker>(async () => ({ diagnostics: [] }));
    const runtime = createJavaScriptRuntime({
      getStateBackend: async () => createTestJavaScriptStateBackend(fileSystem),
      typeCheckFiles,
      executeModule: null,
    });
    assert(runtime.checkFile);

    await expect(runtime.checkFile({ path: "/workspace/example.js" })).resolves.toMatchObject({
      path: "/workspace/example.js",
      valid: true,
      diagnostics: [],
    });
    expect(typeCheckFiles).toHaveBeenCalledOnce();
  });

  test("runs a saved JavaScript module", async () => {
    const fileSystem = new InMemoryFs();
    await fileSystem.mkdir("/workspace/scripts", { recursive: true });
    await fileSystem.writeFile("/workspace/scripts/example.js", "console.log('done');");
    const executeModule = vi.fn(async () => ({
      result: "done",
      logs: ["running"],
      toolCalls: [],
    }));
    const runtime = createJavaScriptRuntime({
      getStateBackend: async () => createTestJavaScriptStateBackend(fileSystem),
      typeCheckFiles: null,
      executeModule,
    });
    const toolContext = createTrustedSystemBackofficeToolContext({ runtimes: {} });
    assert(runtime.runFile);

    await expect(
      runtime.runFile({ path: "/workspace/scripts/example.js" }, toolContext),
    ).resolves.toEqual({
      status: "success",
      path: "/workspace/scripts/example.js",
      logs: ["running"],
    });
    expect(executeModule).toHaveBeenCalledWith("console.log('done');", toolContext);
  });

  test("rejects imports before running a saved JavaScript module", async () => {
    const fileSystem = new InMemoryFs();
    await fileSystem.mkdir("/workspace/scripts", { recursive: true });
    await fileSystem.writeFile(
      "/workspace/scripts/example.js",
      "export { helper } from './helper.js';",
    );
    const executeModule = vi.fn();
    const runtime = createJavaScriptRuntime({
      getStateBackend: async () => createTestJavaScriptStateBackend(fileSystem),
      typeCheckFiles: null,
      executeModule,
    });
    assert(runtime.runFile);

    await expect(
      runtime.runFile(
        { path: "/workspace/scripts/example.js" },
        createTrustedSystemBackofficeToolContext({ runtimes: {} }),
      ),
    ).resolves.toEqual({
      status: "error",
      path: "/workspace/scripts/example.js",
      error:
        "Standalone JavaScript import is not supported in '/workspace/scripts/example.js' at line 1, column 1. Saved JavaScript files must not import other modules.",
      logs: [],
    });
    expect(executeModule).not.toHaveBeenCalled();
  });

  test("directs workflow files to the workflow runtime", async () => {
    const executeModule = vi.fn();
    const runtime = createJavaScriptRuntime({
      getStateBackend: async () => createTestJavaScriptStateBackend(new InMemoryFs()),
      typeCheckFiles: null,
      executeModule,
    });
    assert(runtime.runFile);

    await expect(
      runtime.runFile(
        { path: "/workspace/automations/example.workflow.js" },
        createTrustedSystemBackofficeToolContext({ runtimes: {} }),
      ),
    ).resolves.toEqual({
      status: "error",
      path: "/workspace/automations/example.workflow.js",
      error:
        "JavaScript run cannot execute a workflow file. Use workflow.instances.create instead.",
      logs: [],
    });
    expect(executeModule).not.toHaveBeenCalled();
  });

  test.each(["workspace/example.js", "/system/example.js", "/workspace/example.ts"])(
    "rejects unsupported source path %s",
    async (path) => {
      const runtime = createJavaScriptRuntime({
        getStateBackend: async () => createTestJavaScriptStateBackend(new InMemoryFs()),
        typeCheckFiles: async () => ({ diagnostics: [] }),
        executeModule: null,
      });
      assert(runtime.checkFile);

      await expect(runtime.checkFile({ path })).rejects.toThrow("JavaScript file path");
    },
  );
});
