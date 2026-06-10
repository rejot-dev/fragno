import { describe, expect, test } from "vitest";

import { createWorkflowsTestHarness } from "@fragno-dev/workflows/test";
import { defineRemoteWorkflow } from "@fragno-dev/workflows/workflow";
import { env } from "cloudflare:workers";
import { InMemoryFs } from "just-bash";

import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { MasterFileSystem } from "@/files/master-file-system";
import type { ResolvedFileMount } from "@/files/types";

import { runBackofficeCodemodeWorkflow } from "../codemode/workflow-execute";
import type { AutomationStoreRuntime } from "../runtime-tools/families/automations-bindings";
import type { AutomationWorkflowRuntime } from "../runtime-tools/families/automations-workflow";
import { createPiToolRegistry } from "./pi";
import { createPiCodemodeRuntime } from "./pi-codemode";

describe("Pi execCodeMode tool", () => {
  test("runs codemode against a session filesystem and persists writes", async () => {
    const fs = createTestMasterFileSystem({
      "/workspace/input.txt": "hello",
    });
    const sessionFileSystems = new Map<string, Promise<MasterFileSystem>>([
      ["session-1", Promise.resolve(fs)],
    ]);

    const tools = createPiToolRegistry({
      sessionFileSystems,
      sessionFileSystemContext: {
        orgId: "org-1",
        env,
      },
      codemode: createPiCodemodeRuntime(env),
    });

    const execCodeModeFactory = tools.execCodeMode;
    if (typeof execCodeModeFactory !== "function") {
      throw new Error("Expected execCodeMode tool to be registered as a factory.");
    }

    const tool = await execCodeModeFactory({
      session: { id: "session-1" },
      turnId: "turn-1",
      toolConfig: null,
      messages: [],
    } as never);

    const result = await tool.execute("tool-call-1", {
      code: `async () => {
        const input = await state.readFile("/workspace/input.txt");
        await state.writeFile("/workspace/output.txt", input + " from pi");
        return await state.readFile("/workspace/output.txt");
      }`,
    });

    expect(result.details).toMatchObject({
      result: "hello from pi",
      logs: [],
    });
    const content = result.content[0];
    expect(content?.type).toBe("text");
    if (content?.type !== "text") {
      throw new Error("Expected text content from execCodeMode.");
    }
    expect(content.text).toContain("hello from pi");
    await expect(fs.readFile("/workspace/output.txt")).resolves.toBe("hello from pi");
  });

  test("surfaces workflow definitions from execCodeMode", async () => {
    const tool = await createExecCodeModeTool({
      workflowRuntime: {
        createInstance: async ({ workflowName, instanceId }) => ({
          workflowName,
          instanceId: instanceId ?? "generated-instance-id",
        }),
        getStatus: async () => {
          throw new Error("unused");
        },
        sendEvent: async () => {
          throw new Error("unused");
        },
      },
    });

    const result = await tool.execute("tool-call-1", {
      code: `defineWorkflow({ name: "pi-session-workflow" }, async (_event, step) => {
        return await step.do("write-file", async () => {
          await state.writeFile("/workspace/workflow.txt", "from workflow");
          return "defined";
        });
      });`,
    });

    expect(result.details).toMatchObject({
      workflowDefinition: { name: "pi-session-workflow", options: { name: "pi-session-workflow" } },
      result: { workflowName: "pi-codemode-script", instanceId: "session-1--tool-call-1" },
    });
    const content = result.content[0];
    expect(content?.type).toBe("text");
    if (content?.type !== "text") {
      throw new Error("Expected text content from execCodeMode.");
    }
    expect(content.text).toContain("session-1--tool-call-1");
  });

  test("schedules and runs a workflow defined from execCodeMode", async () => {
    const fs = createTestMasterFileSystem({});
    const sessionFileSystems = new Map<string, Promise<MasterFileSystem>>([
      ["session-1", Promise.resolve(fs)],
    ]);
    const workflow = defineRemoteWorkflow({ name: "pi-codemode-script" }, async (event, remote) => {
      const params = event.payload as { code: string; sessionId: string };
      const sessionFs = await sessionFileSystems.get(params.sessionId);
      if (!sessionFs) {
        throw new Error("Missing session filesystem");
      }
      const result = await runBackofficeCodemodeWorkflow({
        code: params.code,
        event,
        remote,
        fs: sessionFs,
        env,
        tools: [],
        context: { runtimes: {} },
      });
      if (result.error) {
        throw new Error(result.error);
      }
      return result.result;
    });
    const harness = await createWorkflowsTestHarness({
      workflows: { PI_CODEMODE_SCRIPT: workflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    const tools = createPiToolRegistry({
      sessionFileSystems,
      sessionFileSystemContext: {
        orgId: "org-1",
        env,
      },
      codemode: {
        ...createPiCodemodeRuntime(env),
        workflow: {
          createInstance: async ({ workflowName, remoteWorkflowName, instanceId, params }) => {
            const resolvedInstanceId = instanceId ?? "generated-instance-id";
            await harness.createInstance(workflowName, {
              id: resolvedInstanceId,
              params,
              remoteWorkflowName,
            });
            return { workflowName, instanceId: resolvedInstanceId };
          },
          getStatus: async ({ instanceId }) =>
            await harness.getStatus("PI_CODEMODE_SCRIPT", instanceId),
          sendEvent: async ({ workflowName, instanceId, type, payload }) =>
            await harness.sendEvent(workflowName, instanceId, { type, payload }),
        },
      },
    });
    const execCodeModeFactory = tools.execCodeMode;
    if (typeof execCodeModeFactory !== "function") {
      throw new Error("Expected execCodeMode tool to be registered as a factory.");
    }
    const tool = await execCodeModeFactory({
      session: { id: "session-1" },
      turnId: "turn-1",
      toolConfig: null,
      messages: [],
    } as never);

    const result = await tool.execute("tool-call-1", {
      code: `defineWorkflow({ name: "pi-session-workflow" }, async (_event, step) => {
        return await step.do("write-session-file", async () => {
          await state.writeFile("/workspace/from-workflow.txt", "ran from execCodeMode workflow");
          return await state.readFile("/workspace/from-workflow.txt");
        });
      });`,
    });

    expect(result.details).toMatchObject({
      workflowDefinition: { name: "pi-session-workflow", options: { name: "pi-session-workflow" } },
      result: { workflowName: "pi-codemode-script", instanceId: "session-1--tool-call-1" },
    });
    await harness.runUntilIdle({
      workflowName: "pi-codemode-script",
      instanceId: "session-1--tool-call-1",
      reason: "create",
    });
    await expect(
      harness.getStatus("PI_CODEMODE_SCRIPT", "session-1--tool-call-1"),
    ).resolves.toMatchObject({
      status: "complete",
      output: "ran from execCodeMode workflow",
    });
    await expect(fs.readFile("/workspace/from-workflow.txt")).resolves.toBe(
      "ran from execCodeMode workflow",
    );
  });

  test("shows current raw text behavior when codemode returns a Map", async () => {
    const tool = await createExecCodeModeTool({});

    const result = await tool.execute("tool-call-1", {
      code: `async () => {
        return new Map([["key", "value"]]);
      }`,
    });

    expect((result.details as { result?: unknown }).result).toBeInstanceOf(Map);
    expect([...(result.details as { result: Map<string, string> }).result]).toEqual([
      ["key", "value"],
    ]);
    const content = result.content[0];
    expect(content?.type).toBe("text");
    if (content?.type !== "text") {
      throw new Error("Expected text content from execCodeMode.");
    }
    expect(content.text).toBe("{}");
  });

  test("calls workflow domain tools through codemode when configured", async () => {
    const tool = await createExecCodeModeTool({
      workflowRuntime: {
        createInstance: async () => {
          throw new Error("unused");
        },
        getStatus: async () => ({ status: "complete" }),
        getInstance: async (input) => ({
          id: input.instanceId,
          details: { status: "complete", output: input },
          meta: {},
        }),
        sendEvent: async (input) => input,
      },
    });

    const result = await tool.execute("tool-call-1", {
      code: `async () => {
        return await workflow.getInstance({
          workflowName: "pi-codemode-script",
          instanceId: "instance-1",
        });
      }`,
    });

    expect(result.details).toMatchObject({
      result: {
        id: "instance-1",
        details: {
          status: "complete",
          output: {
            workflowName: "pi-codemode-script",
            instanceId: "instance-1",
          },
        },
      },
    });
  });

  test("calls automation identity domain tools through codemode", async () => {
    const calls: unknown[] = [];
    const actor = { scope: "external", source: "telegram", type: "chat", id: "chat-123" } as const;
    const automationsRuntime: AutomationStoreRuntime = {
      get: async (input) => {
        calls.push(["get", input]);
        return {
          key: input.key,
          value: "user-55",
          category: [],
          actor,
        };
      },
      set: async (input) => {
        calls.push(["set", input]);
        return {
          key: input.key,
          value: input.value,
          category: input.category ?? [],
          actor: input.actor,
        };
      },
      delete: async (input) => {
        calls.push(["delete", input]);
        return { ok: true, key: input.key };
      },
      list: async (input) => {
        calls.push(["list", input]);
        return [{ key: `${input.prefix}chat-123`, value: "user-55", category: [], actor }];
      },
    };

    const tool = await createExecCodeModeTool({
      automationsRuntime,
    });

    const result = await tool.execute("tool-call-1", {
      code: `async () => {
        const existing = await store.get({ key: "telegram/chat-123" });
        return await store.set({
          key: "telegram/chat-456",
          value: existing.value,
          actor: existing.actor,
        });
      }`,
    });

    expect(result.details).toMatchObject({
      result: { key: "telegram/chat-456", value: "user-55" },
      logs: [],
      toolCalls: [
        {
          providerName: "store",
          toolName: "get",
          inputSummary: '{"key":"telegram/chat-123"}',
          status: "success",
          resultSummary:
            '{"key":"telegram/chat-123","value":"user-55","category":[],"actor":{"scope":"external","type":"chat","id":"chat-123","source":"telegram"}}',
        },
        {
          providerName: "store",
          toolName: "set",
          inputSummary:
            '{"key":"telegram/chat-456","value":"user-55","actor":{"scope":"external","type":"chat","id":"chat-123","source":"telegram"}}',
          status: "success",
        },
      ],
    });
    const content = result.content[0];
    expect(content?.type).toBe("text");
    if (content?.type !== "text") {
      throw new Error("Expected text content from execCodeMode.");
    }
    expect(content.text).toBe(
      '{"key":"telegram/chat-456","value":"user-55","category":[],"actor":{"scope":"external","type":"chat","id":"chat-123","source":"telegram"}}',
    );
    expect(calls).toEqual([
      ["get", { key: "telegram/chat-123" }],
      ["set", { key: "telegram/chat-456", value: "user-55", actor }],
    ]);
  });

  test("rejects domain tool validation errors so the agent records a failed tool result", async () => {
    const calls: unknown[] = [];
    const actor = { scope: "external", source: "telegram", type: "chat", id: "chat-123" } as const;
    const automationsRuntime: AutomationStoreRuntime = {
      get: async (input) => {
        calls.push(["get", input]);
        return null;
      },
      set: async (input) => {
        calls.push(["set", input]);
        return {
          key: input.key,
          value: input.value,
          category: input.category ?? [],
          actor: input.actor,
        };
      },
      delete: async (input) => {
        calls.push(["delete", input]);
        return { ok: true, key: input.key };
      },
      list: async (input) => {
        calls.push(["list", input]);
        return [{ key: `${input.prefix}chat-123`, value: "user-55", category: [], actor }];
      },
    };

    const tool = await createExecCodeModeTool({ automationsRuntime });
    await expect(
      tool.execute("tool-call-1", {
        code: `async () => {
          return await store.set({ key: "", value: "" });
        }`,
      }),
    ).rejects.toThrow("Too small");

    expect(calls).toEqual([]);
  });
});

const createExecCodeModeTool = async ({
  automationsRuntime,
  workflowRuntime,
}: {
  automationsRuntime?: AutomationStoreRuntime;
  workflowRuntime?: AutomationWorkflowRuntime;
}) => {
  const fs = createTestMasterFileSystem({});
  const sessionFileSystems = new Map<string, Promise<MasterFileSystem>>([
    ["session-1", Promise.resolve(fs)],
  ]);

  const tools = createPiToolRegistry({
    sessionFileSystems,
    sessionFileSystemContext: {
      orgId: "org-1",
      env,
    },
    codemode: { ...createPiCodemodeRuntime(env), workflow: workflowRuntime },
    bashCommandContext: automationsRuntime
      ? ({ automations: { runtime: automationsRuntime } } as never)
      : undefined,
  });

  const execCodeModeFactory = tools.execCodeMode;
  if (typeof execCodeModeFactory !== "function") {
    throw new Error("Expected execCodeMode tool to be registered as a factory.");
  }

  return await execCodeModeFactory({
    session: { id: "session-1" },
    turnId: "turn-1",
    toolConfig: null,
    messages: [],
  } as never);
};

const createTestMasterFileSystem = (files: Record<string, string | Uint8Array>): MasterFileSystem =>
  new MasterFileSystem({
    mounts: [createMount("workspace", "/workspace", files)],
  });

const createMount = (
  id: string,
  mountPoint: string,
  files: Record<string, string | Uint8Array>,
): ResolvedFileMount => ({
  id,
  kind: "custom",
  mountPoint,
  title: id,
  readOnly: false,
  persistence: "session",
  fs: createMountedInMemoryFs(files),
});

const createMountedInMemoryFs = (files: Record<string, string | Uint8Array>) => {
  const fs = new InMemoryFs(files);

  return {
    readFile: (path: string) => fs.readFile(path),
    readFileBuffer: (path: string) => fs.readFileBuffer(path),
    writeFile: (path: string, content: string | Uint8Array) => fs.writeFile(path, content),
    appendFile: (path: string, content: string | Uint8Array) => fs.appendFile(path, content),
    exists: (path: string) => fs.exists(path),
    stat: (path: string) => fs.stat(path),
    mkdir: (path: string, options?: { recursive?: boolean }) => fs.mkdir(path, options),
    readdir: (path: string) => fs.readdir(path),
    readdirWithFileTypes: (path: string) => fs.readdirWithFileTypes(path),
    rm: (path: string, options?: { recursive?: boolean; force?: boolean }) => fs.rm(path, options),
    cp: (src: string, dest: string, options?: { recursive?: boolean }) => fs.cp(src, dest, options),
    mv: (src: string, dest: string) => fs.mv(src, dest),
    resolvePath: (base: string, path: string) => fs.resolvePath(base, path),
    getAllPaths: () => fs.getAllPaths(),
    chmod: (path: string, mode: number) => fs.chmod(path, mode),
    symlink: (target: string, linkPath: string) => fs.symlink(target, linkPath),
    link: (existingPath: string, newPath: string) => fs.link(existingPath, newPath),
    readlink: (path: string) => fs.readlink(path),
    lstat: (path: string) => fs.lstat(path),
    realpath: (path: string) => fs.realpath(path),
    utimes: (path: string, atime: Date, mtime: Date) => fs.utimes(path, atime, mtime),
  };
};
