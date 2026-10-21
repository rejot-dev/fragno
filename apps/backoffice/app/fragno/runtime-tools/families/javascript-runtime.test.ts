import { assert, describe, expect, test, vi } from "vitest";

import type { WorkerTypeChecker } from "@fragno-dev/codemode/compiler/compile-worker";
import { InMemoryFs } from "just-bash";

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
    stat: async (path) => {
      if (!(await fileSystem.exists(path))) {
        return null;
      }
      const stat = await fileSystem.stat(path);
      return { type: stat.isDirectory ? "directory" : "file", size: stat.size };
    },
  } as BackofficeStateBackend;
}

describe("createJavaScriptRuntime", () => {
  test("checks a JavaScript file with static declarations", async () => {
    const fileSystem = new InMemoryFs();
    await fileSystem.mkdir("/static/codemode/providers", { recursive: true });
    await fileSystem.mkdir("/workspace/types", { recursive: true });
    await fileSystem.writeFile("/workspace/example.js", "declaredStaticValue.toUpperCase();");
    await fileSystem.writeFile(
      "/workspace/types/globals.d.ts",
      "declare const declaredWorkspaceValue: number;",
    );
    await fileSystem.writeFile(
      "/static/codemode/providers/fixture.d.ts",
      "declare const declaredStaticValue: string;",
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
      "workspace/example.js": "declaredStaticValue.toUpperCase();",
      "static/codemode/providers/fixture.d.ts": "declare const declaredStaticValue: string;",
    });
    expect(readdirWithFileTypes).not.toHaveBeenCalledWith("/workspace");
  });

  test("reports an import of a missing module before type checking", async () => {
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
          column: 21,
          message: expect.stringContaining("Import './helper.js' cannot be read:"),
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

  test("allows semicolonless local exports before from-named declarations", async () => {
    const fileSystem = new InMemoryFs();
    await fileSystem.mkdir("/static", { recursive: true });
    await fileSystem.mkdir("/workspace", { recursive: true });
    await fileSystem.writeFile(
      "/workspace/example.js",
      "const value = 1;\nexport { value }\nconst from = 2;",
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

  test("reports dynamic imports of missing modules regardless of their position", async () => {
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
          column: 28,
        }),
      ],
    });
    expect(typeCheckFiles).not.toHaveBeenCalled();
  });

  test("allows import.meta", async () => {
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
      status: "success" as const,
      runId: "run-1",
      logs: [{ at: 0, channel: "log" as const, text: "running" }],
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
      runId: "run-1",
      path: "/workspace/scripts/example.js",
      logs: [{ at: 0, channel: "log", text: "running" }],
    });
    expect(executeModule).toHaveBeenCalledWith(
      {
        kind: "source",
        path: "/workspace/scripts/example.js",
        modules: { "/workspace/scripts/example.js": "console.log('done');" },
      },
      toolContext,
    );
  });

  test("rejects package imports before running a saved JavaScript module", async () => {
    const fileSystem = new InMemoryFs();
    await fileSystem.mkdir("/workspace/scripts", { recursive: true });
    await fileSystem.writeFile("/workspace/scripts/example.js", "export { helper } from 'helper';");
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
      status: "rejected",
      path: "/workspace/scripts/example.js",
      error:
        "JavaScript run cannot install packages (helper); compile with js.build and run the built module.",
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
      status: "rejected",
      path: "/workspace/automations/example.workflow.js",
      error:
        "JavaScript run cannot execute a workflow file. Use workflow.instances.create instead.",
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
