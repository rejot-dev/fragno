// The Workers test pool loads the main module on first Durable Object access; load it untimed.
import "../../../../../workers/vitest-env";

import { describe, expect, test, assert } from "vitest";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { createWorkflowsTestHarness } from "@fragno-dev/workflows/test";
import { defineRemoteWorkflow } from "@fragno-dev/workflows/workflow";
import Ajv from "ajv";
import { env } from "cloudflare:workers";

import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { createCloudflareBackofficeObjectRegistry } from "@/backoffice-runtime/cloudflare-durable-object-factory";
import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeConfig } from "@/backoffice-runtime/runtime-services";
import { parseBackofficeUiResult } from "@/backoffice-ui/result";
import { codemodeWorkflowParamsSchema } from "@/fragno/automation/engine/codemode-invocation";
import { AutomationWorkflowRuntimeRequestError } from "@/fragno/automation/workflow-route-runtime";
import { codemodeRunnerFor } from "@/fragno/codemode/codemode-object-execute";
import {
  MemoryUploadObject,
  createTestStateBackend,
} from "@/fragno/codemode/state-backend.test-utils";
import { runBackofficeCodemodeWorkflow } from "@/fragno/codemode/workflow-execute";
import type { RegisteredAutomationsRuntime } from "@/fragno/runtime-tools/bash-host";
import { EMPTY_BASH_HOST_CONTEXT } from "@/fragno/runtime-tools/bash-host.test-utils";
import { createUnavailableAutomationRouterRuntime } from "@/fragno/runtime-tools/families/automations-routing";
import type {
  AutomationWorkflowRuntime,
  InternalAutomationWorkflowRuntime,
} from "@/fragno/runtime-tools/families/automations-workflow";
import { createTrustedSystemBackofficeToolContext } from "@/fragno/runtime-tools/runtime-tools";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import {
  createExecCodeModeTool as createPiExecCodeModeTool,
  execCodeModeParametersSchema,
} from "./exec-code-mode-tool";

const unusedObjects = {} as BackofficeObjectRegistry;
const testRuntimeConfig: BackofficeRuntimeConfig = {
  authEmailVerification: { enabled: false },
  signUpInvitationsEnabled: true,
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
    projectConnector: false,
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
  test("its parameter schema rejects empty programs and accepts immediate and durable ones", () => {
    const validate = new Ajv().compile(execCodeModeParametersSchema);

    assert(!validate({ code: "" }));
    expect(validate.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword: "minLength" })]),
    );
    assert(validate({ code: "async () => ({ ok: true })" }));
    assert(validate({ code: 'defineWorkflow({ name: "demo" }, async () => ({}))' }));
  });

  test("runs codemode against the session Upload mount and persists writes", async () => {
    const stateBackend = createTestStateBackend({
      upload: new MemoryUploadObject({ "input.txt": "hello" }),
    });

    const tool = await createExecCodeModeTool({ stateBackend });

    const result = await tool.execute(
      {
        code: `async () => {
          const input = await state.readFile({ path: "/workspace/input.txt" });
          await state.writeFile({ path: "/workspace/output.txt", content: input + " from pi" });
          return await state.readFile({ path: "/workspace/output.txt" });
        }`,
      },
      { taskId: "tool-call-1" } as never,
      BACKGROUND_CONTEXT,
    );

    expect(result.details).toMatchObject({
      result: "hello from pi",
      logs: [],
    });
    const content = result.output[0];
    assert(content?.type === "text");
    if (content?.type !== "text") {
      throw new Error("Expected text content from execCodeMode.");
    }
    expect(content.text).toContain("hello from pi");
    await expect(stateBackend.readFile("/workspace/output.txt")).resolves.toBe("hello from pi");
  });

  test("preserves an immediate generated UI result in details.result", async () => {
    const tool = await createExecCodeModeTool({});

    const result = await tool.execute(
      {
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
      },
      { taskId: "tool-call-ui" } as never,
      BACKGROUND_CONTEXT,
    );

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

  test("renders a ui builder tree into a generated UI with positional element ids", async () => {
    const tool = await createExecCodeModeTool({});

    const result = await tool.execute(
      {
        code: `async () => {
          const orders = [{ id: "ord_1", total: 120 }, { id: "ord_2", total: 80 }];
          return {
            orderIds: orders.map((order) => order.id),
            $ui: ui.render(
              ui.stack({ gap: "md" }, [
                ui.heading({ text: "Open orders" }),
                ui.when(orders.length > 1, ui.metric({ label: "Orders", value: String(orders.length) })),
                ui.table({
                  caption: "Orders",
                  columns: [{ key: "id", label: "ID" }, { key: "total", label: "Total", align: "end" }],
                  rows: orders.map((order) => ({ id: order.id, total: String(order.total) })),
                }),
              ]),
            ),
          };
        }`,
      },
      { taskId: "tool-call-ui-builder" } as never,
      BACKGROUND_CONTEXT,
    );

    assert(!result.isError);
    const generatedUi = parseBackofficeUiResult((result.details as { result: unknown }).result);
    assert(generatedUi.kind === "valid");
    expect(generatedUi.value).toEqual({
      orderIds: ["ord_1", "ord_2"],
      $ui: {
        version: 1,
        state: {},
        spec: {
          root: "root",
          elements: {
            root: {
              type: "Stack",
              props: { gap: "md" },
              children: ["root.0", "root.1", "root.2"],
            },
            "root.0": { type: "Heading", props: { text: "Open orders" }, children: [] },
            "root.1": {
              type: "Metric",
              props: { label: "Orders", value: "2" },
              children: [],
              visible: true,
            },
            "root.2": {
              type: "Table",
              props: {
                caption: "Orders",
                columns: [
                  { key: "id", label: "ID" },
                  { key: "total", label: "Total", align: "end" },
                ],
                rows: [
                  { id: "ord_1", total: "120" },
                  { id: "ord_2", total: "80" },
                ],
              },
              children: [],
            },
          },
        },
      },
    });
  });

  test("fails the tool call with the element and prop that make a generated UI invalid", async () => {
    const tool = await createExecCodeModeTool({});

    const result = await tool.execute(
      {
        code: `async () => ({
          $ui: {
            version: 1,
            state: {},
            spec: {
              root: "report",
              elements: {
                report: { type: "Stack", props: { gap: "md" }, children: ["grid"] },
                grid: { type: "Grid", props: { columns: 6, gap: "md" }, children: ["metric"] },
                metric: { type: "Metric", props: { label: "Orders", value: 2 }, children: [] },
              },
            },
          },
        })`,
      },
      { taskId: "tool-call-invalid-ui" } as never,
      BACKGROUND_CONTEXT,
    );

    assert(result.isError);
    const content = result.output[0];
    assert(content?.type === "text");
    expect(content.text).toContain(
      'Generated UI is invalid: Element "grid" has invalid props for Grid: columns: expected one of 1|2|3|4. Element "metric" has invalid props for Metric: value: Invalid input: expected string, received number.',
    );
  });

  test("rejects form bindings to undeclared fields before the interface leaves the guest", async () => {
    const tool = await createExecCodeModeTool({});

    await expect(
      tool.execute(
        {
          code: `async () => {
            const form = ui.form("approval", { decision: "approve" });
            return { $ui: ui.render(ui.textArea({ label: "Reason", value: form.bind("reason") })) };
          }`,
        },
        { taskId: "tool-call-unknown-field" } as never,
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow(
      'form.bind("reason") names no field of ui.form("approval"); declare it in the initial values.',
    );
  });

  test("surfaces workflow definitions from execCodeMode", async () => {
    const tool = await createExecCodeModeTool({
      workflowRuntime: createPiWorkflowRuntime(),
    });

    const result = await tool.execute(
      {
        code: `defineWorkflow({ name: "pi-session-workflow" }, async (_event, step) => {
          return await step.do("write-file", async () => {
            await state.writeFile({ path: "/workspace/workflow.txt", content: "from workflow" });
            return "defined";
          });
        });`,
      },
      { taskId: "tool-call-1" } as never,
      BACKGROUND_CONTEXT,
    );

    expect(result.details).toMatchObject({
      workflowDefinition: { name: "pi-session-workflow", options: { name: "pi-session-workflow" } },
      result: { instanceId: "12zjsps1wxc2bo" },
    });
    const content = result.output[0];
    assert(content?.type === "text");
    if (content?.type !== "text") {
      throw new Error("Expected text content from execCodeMode.");
    }
    expect(content.text).toContain("12zjsps1wxc2bo");
  });

  test("returns structured scheduling failures as failed tool results", async () => {
    const requiredPermission = BACKOFFICE_PERMISSION.workflow.executeCode;
    const tool = await createExecCodeModeTool({
      workflowRuntime: createPiWorkflowRuntime({
        createInternalInstance: async () => {
          throw new AutomationWorkflowRuntimeRequestError(
            403,
            "principal-permission-denied",
            "Workflows backend returned 403: The current principal does not have the required permission.",
            requiredPermission,
          );
        },
      }),
    });

    const result = await tool.execute(
      {
        code: `defineWorkflow({ name: "denied-workflow" }, async () => ({ ok: true }));`,
      },
      { taskId: "tool-call-denied" } as never,
      BACKGROUND_CONTEXT,
    );

    assert(result.isError);
    expect(result.details).toMatchObject({
      workflowDefinition: { name: "denied-workflow" },
      scheduleError: {
        status: 403,
        code: "principal-permission-denied",
        requiredPermission,
        message:
          "Workflows backend returned 403: The current principal does not have the required permission.",
      },
    });
    expect(result.details).not.toHaveProperty("run");
  });

  test("schedules and runs a workflow defined from execCodeMode", async () => {
    const stateBackend = createTestStateBackend();
    const workflow = defineRemoteWorkflow({ name: "codemode-script" }, async (event, remote) => {
      const params = codemodeWorkflowParamsSchema.parse(event.payload);
      const result = await runBackofficeCodemodeWorkflow({
        code: params.program.code,
        modules: params.program.modules,
        dependencies: params.program.dependencies,
        event: {
          id: event.instanceId,
          payload: params.trigger.type === "manual" ? params.trigger.payload : {},
          instanceId: event.instanceId,
          timestamp: event.timestamp,
        },
        remote,
        env,
        allowedHooks: [],
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

    const tool = await createExecCodeModeTool({
      stateBackend,
      workflowRuntime: createPiWorkflowRuntime({
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
    });

    const result = await tool.execute(
      {
        code: `defineWorkflow({ name: "pi-session-workflow" }, async (_event, step) => {
          return await step.do("write-session-file", async () => {
            await state.writeFile({
              path: "/workspace/from-workflow.txt",
              content: "ran from execCodeMode workflow",
            });
            return await state.readFile({ path: "/workspace/from-workflow.txt" });
          });
        });`,
      },
      { taskId: "tool-call-1" } as never,
      BACKGROUND_CONTEXT,
    );

    expect(result.details).toMatchObject({
      workflowDefinition: { name: "pi-session-workflow", options: { name: "pi-session-workflow" } },
      result: { instanceId: "12zjsps1wxc2bo" },
    });
    await harness.runUntilIdle({
      workflowName: "codemode-script",
      instanceId: "12zjsps1wxc2bo",
      reason: "create",
    });
    await expect(harness.getStatus("PI_CODEMODE_SCRIPT", "12zjsps1wxc2bo")).resolves.toMatchObject({
      status: "complete",
      output: "ran from execCodeMode workflow",
    });
    await expect(stateBackend.readFile("/workspace/from-workflow.txt")).resolves.toBe(
      "ran from execCodeMode workflow",
    );
  });

  // cf-sandbox-bridge's compiler tests install and execute npm dependencies.
  test("schedules a workflow with its requested npm dependencies", async () => {
    const scheduledParams: unknown[] = [];
    const tool = await createExecCodeModeTool({
      workflowRuntime: createPiWorkflowRuntime({
        createInternalInstance: async ({ workflowName, instanceId, params }) => {
          scheduledParams.push(params);
          return { workflowName, instanceId: instanceId ?? "generated-instance-id" };
        },
      }),
    });

    const result = await tool.execute(
      {
        code: `defineWorkflow({ name: "pi-session-workflow-npm" }, async (_event, step) => {
            return await step.do("is-number", async () => {
              const isNumber = (await import("is-number")).default;
              return isNumber(7);
            });
          });`,
        dependencies: { "is-number": "7.0.0" },
      },
      { taskId: "tool-call-1" } as never,
      BACKGROUND_CONTEXT,
    );

    expect(result.details).toMatchObject({ result: { instanceId: "12zjsps1wxc2bo" } });
    expect(scheduledParams.map((params) => codemodeWorkflowParamsSchema.parse(params))).toEqual([
      expect.objectContaining({
        program: expect.objectContaining({ dependencies: { "is-number": "7.0.0" } }),
      }),
    ]);
  });

  test("rejects codemode details that cannot be persisted as strict JSON", async () => {
    const tool = await createExecCodeModeTool({});

    await expect(
      tool.execute(
        {
          code: `async () => {
            return new Map([["key", "value"]]);
          }`,
        },
        { taskId: "tool-call-1" } as never,
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow("Value must contain strict JSON plain objects or arrays");
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

    const result = await tool.execute(
      {
        code: `async () => {
          return await workflow.getInstance({ instanceId: "instance-1" });
        }`,
      },
      { taskId: "tool-call-1" } as never,
      BACKGROUND_CONTEXT,
    );

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

    const result = await tool.execute(
      {
        code: `async () => {
          const existing = await store.get({ key: "telegram/chat-123" });
          return await store.set({
            key: "telegram/chat-456",
            value: existing.value,
          });
        }`,
      },
      { taskId: "tool-call-1" } as never,
      BACKGROUND_CONTEXT,
    );

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
    const content = result.output[0];
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
      tool.execute(
        {
          code: `async () => {
            return await store.set({ key: "", value: "" });
          }`,
        },
        { taskId: "tool-call-1" } as never,
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow("Too small");

    expect(calls).toEqual([]);
  });
});

const createExecCodeModeTool = async ({
  automationsRuntime,
  workflowRuntime,
  stateBackend = createTestStateBackend(),
}: {
  automationsRuntime?: RegisteredAutomationsRuntime;
  workflowRuntime?: PiWorkflowRuntime;
  stateBackend?: ReturnType<typeof createTestStateBackend>;
}) => {
  const runtimeToolContext = {
    ...EMPTY_BASH_HOST_CONTEXT,
    stateBackend,
    workflow: workflowRuntime ? { runtime: workflowRuntime } : null,
    ...(automationsRuntime ? { automations: { runtime: automationsRuntime } } : {}),
  } as never;
  const turn = {
    execution: createPiSystemFileContext().execution,
    billingOrganizationId: "org-1",
    instructions: "",
    codemode: codemodeRunnerFor(
      createCloudflareBackofficeObjectRegistry(env as CloudflareEnv).codemode.singleton().commands,
      createBackofficeSystemExecution({ kind: "system" }),
      null,
    ),
    authorize: async () => undefined,
    toolContext: () => runtimeToolContext,
  };
  const tool = createPiExecCodeModeTool({
    agentName: "assistant",
    scope: { kind: "system" },
    activeTurn: async () => turn,
    turn: () => turn,
  });
  return {
    ...tool,
    async execute(
      args: Parameters<typeof tool.execute>[0],
      api: Parameters<typeof tool.execute>[1],
      context: Parameters<typeof tool.execute>[2],
    ) {
      const result = await tool.execute(args, api, context);
      if (!result.output || result.details === undefined) {
        throw new Error("Expected execCodeMode to return persisted output and details.");
      }
      return {
        output: result.output,
        details: result.details,
        isError: result.isError === true,
      };
    },
  };
};
