import { describe, expect, test, assert } from "vitest";

import { createWorkflowsTestHarness } from "@fragno-dev/workflows/test";
import { defineRemoteWorkflow } from "@fragno-dev/workflows/workflow";
import { env } from "cloudflare:workers";

import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeConfig } from "@/backoffice-runtime/runtime-services";
import { codemodeWorkflowParamsSchema } from "@/fragno/automation/engine/codemode-invocation";

import { MemoryUploadObject, createTestStateBackend } from "../codemode/state-backend.test-utils";
import { runBackofficeCodemodeWorkflow } from "../codemode/workflow-execute";
import type { RegisteredAutomationsRuntime } from "../runtime-tools/bash-host";
import { EMPTY_BASH_HOST_CONTEXT } from "../runtime-tools/bash-host.test-utils";
import { createUnavailableAutomationRouterRuntime } from "../runtime-tools/families/automations-routing";
import type {
  AutomationWorkflowRuntime,
  InternalAutomationWorkflowRuntime,
} from "../runtime-tools/families/automations-workflow";
import { createTrustedSystemBackofficeToolContext } from "../runtime-tools/runtime-tools";
import { runtimeToolFamilies } from "../runtime-tools/tool-families";
import { createPiCodemodeRuntime } from "./pi-codemode";
import { createPiToolRegistry } from "./pi-tools";

const unusedObjects = {} as BackofficeObjectRegistry;
const testRuntimeConfig: BackofficeRuntimeConfig = {
  authEmailVerification: { enabled: false },
  bindings: {
    api: false,
    auth: false,
    automations: false,
    billing: false,
    marketplace: false,
    telegram: false,
    otp: false,
    resend: false,
    reson8: false,
    mcp: false,
    upload: false,
    github: false,
    githubWebhookRouter: false,
    cloudflare: false,
    sandbox: false,
  },
};

const createPiSystemFileContext = () => ({
  objects: unusedObjects,
  runtimeConfig: testRuntimeConfig,
  execution: createBackofficeUserExecution({
    scope: { kind: "org", orgId: "org-1" },
    userId: "test-user",
  }),
});

type PiWorkflowRuntime = AutomationWorkflowRuntime &
  Pick<InternalAutomationWorkflowRuntime, "createInternalInstance">;

const createPiWorkflowRuntime = (
  overrides: Partial<PiWorkflowRuntime> = {},
): PiWorkflowRuntime => ({
  createInternalInstance: async ({ workflowName, instanceId }) => ({
    workflowName,
    instanceId: instanceId ?? "generated-instance-id",
  }),
  createInstance: async ({ instanceId }) => ({ instanceId }),
  listInstances: async () => ({ instances: [], hasNextPage: false }),
  getInstance: async ({ instanceId }) => ({
    id: instanceId,
    details: { status: "waiting" },
    meta: {
      name: "demo",
      path: "/workspace/automations/demo.workflow.js",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
    },
  }),
  retryFailedStep: async ({ instanceId }) => ({
    accepted: true,
    instance: { id: instanceId, details: { status: "waiting" } },
    retry: {
      stepKey: "do:latest",
      attempts: 1,
      maxAttempts: 2,
      scheduledAt: "2026-08-11T00:00:00.000Z",
    },
  }),
  sendEvent: async () => ({ accepted: true }),
  getHistory: async () => ({ steps: [], events: [], emissions: [] }),
  ...overrides,
});

describe("Pi execCodeMode tool", () => {
  test("runs codemode against the session Upload mount and persists writes", async () => {
    const stateBackend = createTestStateBackend({
      upload: new MemoryUploadObject({ "input.txt": "hello" }),
    });

    const tools = createPiToolRegistry({
      execution: createPiSystemFileContext().execution,
      codemode: createPiCodemodeRuntime(env),
      runtimeToolContext: { ...EMPTY_BASH_HOST_CONTEXT, stateBackend } as never,
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
        const input = await state.readFile({ path: "/workspace/input.txt" });
        await state.writeFile({ path: "/workspace/output.txt", content: input + " from pi" });
        return await state.readFile({ path: "/workspace/output.txt" });
      }`,
    });

    expect(result.details).toMatchObject({
      result: "hello from pi",
      logs: [],
    });
    const content = result.content[0];
    assert(content?.type === "text");
    if (content?.type !== "text") {
      throw new Error("Expected text content from execCodeMode.");
    }
    expect(content.text).toContain("hello from pi");
    await expect(stateBackend.readFile("/workspace/output.txt")).resolves.toBe("hello from pi");
  });

  test("preserves an immediate generated UI result in details.result", async () => {
    const tool = await createExecCodeModeTool({});

    const result = await tool.execute("tool-call-ui", {
      code: `async () => {
        const total = 24;
        return {
          total,
          $ui: {
            version: 1,
            state: { total },
            spec: {
              root: "report",
              elements: {
                report: {
                  type: "Stack",
                  props: { gap: "md" },
                  children: ["metric"],
                },
                metric: {
                  type: "Metric",
                  props: { label: "Orders", value: String(total) },
                  children: [],
                },
              },
            },
          },
        };
      }`,
    });

    expect((result.details as { result?: unknown }).result).toEqual({
      total: 24,
      $ui: {
        version: 1,
        state: { total: 24 },
        spec: {
          root: "report",
          elements: {
            report: {
              type: "Stack",
              props: { gap: "md" },
              children: ["metric"],
            },
            metric: {
              type: "Metric",
              props: { label: "Orders", value: "24" },
              children: [],
            },
          },
        },
      },
    });
  });

  test("surfaces workflow definitions from execCodeMode", async () => {
    const tool = await createExecCodeModeTool({
      workflowRuntime: createPiWorkflowRuntime(),
    });

    const result = await tool.execute("tool-call-1", {
      code: `defineWorkflow({ name: "pi-session-workflow" }, async (_event, step) => {
        return await step.do("write-file", async () => {
          await state.writeFile({ path: "/workspace/workflow.txt", content: "from workflow" });
          return "defined";
        });
      });`,
    });

    expect(result.details).toMatchObject({
      workflowDefinition: { name: "pi-session-workflow", options: { name: "pi-session-workflow" } },
      result: { instanceId: "18tfv3i1e4o7fe" },
    });
    const content = result.content[0];
    assert(content?.type === "text");
    if (content?.type !== "text") {
      throw new Error("Expected text content from execCodeMode.");
    }
    expect(content.text).toContain("18tfv3i1e4o7fe");
  });

  test("schedules and runs a workflow defined from execCodeMode", async () => {
    const stateBackend = createTestStateBackend();
    const workflow = defineRemoteWorkflow({ name: "codemode-script" }, async (event, remote) => {
      const params = codemodeWorkflowParamsSchema.parse(event.payload);
      const result = await runBackofficeCodemodeWorkflow({
        code: params.program.code,
        dependencies: params.program.dependencies,
        event: {
          id: event.instanceId,
          payload: params.trigger.type === "manual" ? params.trigger.payload : {},
          instanceId: event.instanceId,
          timestamp: event.timestamp,
        },
        remote,
        env,
        families: runtimeToolFamilies,
        toolContext: createTrustedSystemBackofficeToolContext({
          runtimes: { state: stateBackend },
        }),
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
      execution: createPiSystemFileContext().execution,
      codemode: {
        ...createPiCodemodeRuntime(env),
        workflow: createPiWorkflowRuntime({
          createInternalInstance: async ({
            workflowName,
            remoteWorkflowName,
            instanceId,
            params,
          }) => {
            const resolvedInstanceId = instanceId ?? "generated-instance-id";
            await harness.createInstance(workflowName, {
              id: resolvedInstanceId,
              params,
              remoteWorkflowName,
            });
            return { workflowName, instanceId: resolvedInstanceId };
          },
        }),
      },
      runtimeToolContext: { ...EMPTY_BASH_HOST_CONTEXT, stateBackend } as never,
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
          await state.writeFile({
            path: "/workspace/from-workflow.txt",
            content: "ran from execCodeMode workflow",
          });
          return await state.readFile({ path: "/workspace/from-workflow.txt" });
        });
      });`,
    });

    expect(result.details).toMatchObject({
      workflowDefinition: { name: "pi-session-workflow", options: { name: "pi-session-workflow" } },
      result: { instanceId: "18tfv3i1e4o7fe" },
    });
    await harness.runUntilIdle({
      workflowName: "codemode-script",
      instanceId: "18tfv3i1e4o7fe",
      reason: "create",
    });
    await expect(harness.getStatus("PI_CODEMODE_SCRIPT", "18tfv3i1e4o7fe")).resolves.toMatchObject({
      status: "complete",
      output: "ran from execCodeMode workflow",
    });
    await expect(stateBackend.readFile("/workspace/from-workflow.txt")).resolves.toBe(
      "ran from execCodeMode workflow",
    );
  });

  test("schedules and runs a workflow with an npm dependency", async () => {
    const workflow = defineRemoteWorkflow({ name: "codemode-script" }, async (event, remote) => {
      const params = codemodeWorkflowParamsSchema.parse(event.payload);
      const result = await runBackofficeCodemodeWorkflow({
        code: params.program.code,
        dependencies: params.program.dependencies,
        event: {
          id: event.instanceId,
          payload: params.trigger.type === "manual" ? params.trigger.payload : {},
          instanceId: event.instanceId,
          timestamp: event.timestamp,
        },
        remote,
        env,
        families: runtimeToolFamilies,
        toolContext: createTrustedSystemBackofficeToolContext({ runtimes: {} }),
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
      execution: createPiSystemFileContext().execution,
      codemode: {
        ...createPiCodemodeRuntime(env),
        workflow: createPiWorkflowRuntime({
          createInternalInstance: async ({
            workflowName,
            remoteWorkflowName,
            instanceId,
            params,
          }) => {
            const resolvedInstanceId = instanceId ?? "generated-instance-id";
            await harness.createInstance(workflowName, {
              id: resolvedInstanceId,
              params,
              remoteWorkflowName,
            });
            return { workflowName, instanceId: resolvedInstanceId };
          },
        }),
      },
      runtimeToolContext: {
        ...EMPTY_BASH_HOST_CONTEXT,
        stateBackend: createTestStateBackend(),
      } as never,
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
      code: `defineWorkflow({ name: "pi-session-workflow-npm" }, async (_event, step) => {
          return await step.do("is-number", async () => {
            const isNumber = (await import("is-number")).default;
            return isNumber(7);
          });
        });`,
      dependencies: { "is-number": "7.0.0" },
    });

    const details = result.details as { result?: { instanceId?: string } };
    assert(details.result?.instanceId === "18tfv3i1e4o7fe");
    await harness.runUntilIdle({
      workflowName: "codemode-script",
      instanceId: "18tfv3i1e4o7fe",
      reason: "create",
    });
    await expect(harness.getStatus("PI_CODEMODE_SCRIPT", "18tfv3i1e4o7fe")).resolves.toMatchObject({
      status: "complete",
      output: true,
    });
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
    assert(content?.type === "text");
    if (content?.type !== "text") {
      throw new Error("Expected text content from execCodeMode.");
    }
    assert(content.text === "{}");
  });

  test("calls workflow domain tools through codemode when configured", async () => {
    const tool = await createExecCodeModeTool({
      workflowRuntime: createPiWorkflowRuntime({
        getInstance: async (input) => ({
          id: input.instanceId,
          details: { status: "complete", output: input },
          meta: {
            name: "demo",
            path: "/workspace/automations/demo.workflow.js",
            createdAt: "2026-08-10T00:00:00.000Z",
            updatedAt: "2026-08-10T00:00:00.000Z",
            startedAt: null,
            completedAt: null,
          },
        }),
        sendEvent: async () => ({ accepted: true }),
      }),
    });

    const result = await tool.execute("tool-call-1", {
      code: `async () => {
        return await workflow.getInstance({ instanceId: "instance-1" });
      }`,
    });

    expect(result.details).toMatchObject({
      result: {
        id: "instance-1",
        details: {
          status: "complete",
          output: {
            instanceId: "instance-1",
          },
        },
      },
    });
  });

  test("calls automation identity domain tools through codemode", async () => {
    const calls: unknown[] = [];
    const automationsRuntime: RegisteredAutomationsRuntime = {
      ...createUnavailableAutomationRouterRuntime(),
      get: async (input) => {
        calls.push(["get", input]);
        return {
          id: input.key,
          key: input.key,
          value: "user-55",
          category: [],
        };
      },
      set: async (input) => {
        calls.push(["set", input]);
        return {
          id: input.key,
          key: input.key,
          value: input.value,
          category: input.category ?? [],
        };
      },
      delete: async (input) => {
        calls.push(["delete", input]);
        return { ok: true, key: input.key };
      },
      list: async (input) => {
        calls.push(["list", input]);
        return [{ key: `${input.prefix}chat-123`, value: "user-55", category: [] }];
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
            '{"id":"telegram/chat-123","key":"telegram/chat-123","value":"user-55","category":[]}',
        },
        {
          providerName: "store",
          toolName: "set",
          inputSummary: '{"key":"telegram/chat-456","value":"user-55"}',
          status: "success",
        },
      ],
    });
    const content = result.content[0];
    assert(content?.type === "text");
    if (content?.type !== "text") {
      throw new Error("Expected text content from execCodeMode.");
    }
    assert(
      content.text ===
        '{"id":"telegram/chat-456","key":"telegram/chat-456","value":"user-55","category":[]}',
    );
    expect(calls).toEqual([
      ["get", { key: "telegram/chat-123" }],
      ["set", { key: "telegram/chat-456", value: "user-55" }],
    ]);
  });

  test("rejects domain tool validation errors so the agent records a failed tool result", async () => {
    const calls: unknown[] = [];
    const automationsRuntime: RegisteredAutomationsRuntime = {
      ...createUnavailableAutomationRouterRuntime(),
      get: async (input) => {
        calls.push(["get", input]);
        return null;
      },
      set: async (input) => {
        calls.push(["set", input]);
        return {
          id: input.key,
          key: input.key,
          value: input.value,
          category: input.category ?? [],
        };
      },
      delete: async (input) => {
        calls.push(["delete", input]);
        return { ok: true, key: input.key };
      },
      list: async (input) => {
        calls.push(["list", input]);
        return [{ key: `${input.prefix}chat-123`, value: "user-55", category: [] }];
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
  automationsRuntime?: RegisteredAutomationsRuntime;
  workflowRuntime?: PiWorkflowRuntime;
}) => {
  const stateBackend = createTestStateBackend();
  const tools = createPiToolRegistry({
    execution: createPiSystemFileContext().execution,
    codemode: { ...createPiCodemodeRuntime(env), workflow: workflowRuntime },
    runtimeToolContext: automationsRuntime
      ? ({
          ...EMPTY_BASH_HOST_CONTEXT,
          stateBackend,
          automations: { runtime: automationsRuntime },
        } as never)
      : ({ ...EMPTY_BASH_HOST_CONTEXT, stateBackend } as never),
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
