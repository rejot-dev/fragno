// The Workers test pool loads the main module on first Durable Object access; load it untimed.
import "../../../../../workers/vitest-env";

import { afterAll, describe, expect, test, assert, vi } from "vitest";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { createWorkflowsTestHarness } from "@fragno-dev/workflows/test";
import { defineRemoteWorkflow } from "@fragno-dev/workflows/workflow";
import { parseBackofficeUiResult } from "@fragno-private/backoffice-ui/result";
import Ajv from "ajv";
import { env } from "cloudflare:workers";

import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { createCloudflareBackofficeObjectRegistry } from "@/backoffice-runtime/cloudflare-durable-object-factory";
import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeConfig } from "@/backoffice-runtime/runtime-services";
import { codemodeWorkflowParamsSchema } from "@/fragno/automation/engine/codemode-invocation";
import { AutomationWorkflowRuntimeRequestError } from "@/fragno/automation/workflow-route-runtime";
import { drainCodemodeAlarms } from "@/fragno/codemode/codemode-alarms.test-support";
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
import { bytesToBase64 } from "@/lib/base64";

import {
  createCodemodeTool as createPiCodemodeTool,
  codemodeParametersSchema,
} from "./codemode-tool";

const codemode = codemodeRunnerFor(
  createCloudflareBackofficeObjectRegistry(env as CloudflareEnv).codemode.singleton().commands,
  createBackofficeSystemExecution({ kind: "system" }),
);

const unusedObjects = {} as BackofficeObjectRegistry;

/** The tool API a call gets in tests: its task, and somewhere for its live details to go. */
function toolApi(taskId: string) {
  return { taskId, details: async () => {} } as never;
}
const testRuntimeConfig: BackofficeRuntimeConfig = {
  authEmailVerification: { enabled: false },
  sandboxBackofficeBaseUrl: null,
  sandboxContainers: true,
  signUpAccessCodesRequired: true,
  localEmailLog: false,
  workersAi: false,
  bindings: {
    api: false,
    auth: false,
    automations: false,
    billing: false,
    marketplace: false,
    telegram: false,
    otp: false,
    resend: false,
    mcp: false,
    projectConnector: false,
    upload: false,
    blobs: false,
    github: false,
    githubWebhookRouter: false,
    piManager: false,
    cloudflare: false,
    sandbox: false,
  },
};

const createPiSystemFileContext = () => ({
  objects: unusedObjects,
  runtimeConfig: testRuntimeConfig,
  execution: createBackofficeUserExecution({
    scope: { kind: "org", orgId: "org-1", jurisdiction: null },
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
    waitingFor: [],
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
  terminateInstance: async () => ({ terminated: true }),
  sendEvent: async () => ({ accepted: true }),
  getHistory: async () => ({ steps: [], events: [], emissions: [] }),
  ...overrides,
});

describe("Pi codemode tool", () => {
  afterAll(drainCodemodeAlarms);

  test("its parameter schema rejects empty programs and accepts immediate and durable ones", () => {
    const validate = new Ajv().compile(codemodeParametersSchema);

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

    const tool = await createCodemodeTool({ stateBackend });

    const result = await tool.execute(
      {
        code: `async () => {
          const input = await state.readFile({ path: "/workspace/input.txt" });
          await state.writeFile({ path: "/workspace/output.txt", content: input + " from pi" });
          return await state.readFile({ path: "/workspace/output.txt" });
        }`,
      },
      toolApi("tool-call-1"),
      BACKGROUND_CONTEXT,
    );

    expect(result.details).toMatchObject({
      result: "hello from pi",
      logs: [],
    });
    const content = result.output[0];
    assert(content?.type === "text");
    if (content?.type !== "text") {
      throw new Error("Expected text content from codemode.");
    }
    expect(content.text).toContain("hello from pi");
    await expect(stateBackend.readFile("/workspace/output.txt")).resolves.toBe("hello from pi");
  });

  test("shows the model the workspace images its program views", async () => {
    const screenshot = await encodePng(1280, 800);
    // Noise does not compress: each fits on its own, but not beside the other in one tool result.
    const largeScreenshot = await encodePng(448, 448, "noise");
    const stateBackend = createTestStateBackend({
      upload: new MemoryUploadObject({
        "shots/page.png": screenshot,
        "shots/dashboard.png": largeScreenshot,
        "shots/settings.png": await encodePng(448, 449, "noise"),
        "shots/full-page.png": await encodePng(1000, 2400),
        // An upload that stopped early: the header is intact, the pixels are missing.
        "shots/cut-off.png": screenshot.subarray(0, 40),
        "notes.txt": "not an image",
      }),
    });
    const tool = await createCodemodeTool({ stateBackend });

    const result = await tool.execute(
      {
        code: `async () => {
          const refused = async (path) => {
            try {
              await state.viewImage({ path });
              return null;
            } catch (error) {
              return error.message;
            }
          };
          return {
            page: await state.viewImage({ path: "/workspace/shots/page.png" }),
            dashboard: await state.viewImage({ path: "/workspace/shots/dashboard.png" }),
            settings: await refused("/workspace/shots/settings.png"),
            fullPage: await refused("/workspace/shots/full-page.png"),
            cutOff: await refused("/workspace/shots/cut-off.png"),
            notes: await refused("/workspace/notes.txt"),
          };
        }`,
      },
      toolApi("tool-call-view-image"),
      BACKGROUND_CONTEXT,
    );

    assert(!result.isError);
    expect(result.details).toMatchObject({
      result: {
        page: { mimeType: "image/png", width: 1280, height: 800 },
        dashboard: { mimeType: "image/png", width: 448, height: 448 },
        settings: expect.stringContaining("view the rest in another program"),
        fullPage: expect.stringContaining(
          "is 1000×2400 pixels; the most you can view is 2000×2000",
        ),
        cutOff: expect.stringContaining("is not a complete image/png image"),
        notes: expect.stringContaining("must contain a PNG, JPEG, or WebP image"),
      },
    });
    // Only the images the program could view follow its text.
    expect(result.output.slice(1)).toEqual([
      { type: "image", mimeType: "image/png", data: bytesToBase64(screenshot) },
      { type: "image", mimeType: "image/png", data: bytesToBase64(largeScreenshot) },
    ]);

    // A program viewing a dozen screenshots at once reads only the eight it can show. A real read
    // waits on the upload object, so the program's calls overlap; the in-memory one would not.
    const readFileBytes = stateBackend.readFileBytes.bind(stateBackend);
    const reads = vi
      .spyOn(stateBackend, "readFileBytes")
      .mockImplementation(async (path, maxBytes) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return await readFileBytes(path, maxBytes);
      });
    const parallel = await tool.execute(
      {
        code: `async () => {
          const views = await Promise.allSettled(
            Array.from({ length: 12 }, () => state.viewImage({ path: "/workspace/shots/page.png" })),
          );
          return views.map((view) => view.status === "fulfilled" ? "viewed" : view.reason.message);
        }`,
      },
      toolApi("tool-call-view-images-in-parallel"),
      BACKGROUND_CONTEXT,
    );

    const outcomes = (parallel.details as { result: string[] }).result;
    expect(outcomes.filter((outcome) => outcome === "viewed")).toHaveLength(8);
    expect(outcomes.filter((outcome) => outcome !== "viewed")).toEqual(
      Array.from({ length: 4 }, () =>
        expect.stringContaining("A program can view at most 8 images"),
      ),
    );
    expect(parallel.output).toHaveLength(9);
    expect(reads).toHaveBeenCalledTimes(8);
  });

  test("preserves an immediate generated UI result in details.result", async () => {
    const tool = await createCodemodeTool({});

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
      toolApi("tool-call-ui"),
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
    const tool = await createCodemodeTool({});

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
      toolApi("tool-call-ui-builder"),
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
    const tool = await createCodemodeTool({});

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
                metric: { type: "Metric", props: { label: 2, value: "Orders" }, children: [] },
              },
            },
          },
        })`,
      },
      toolApi("tool-call-invalid-ui"),
      BACKGROUND_CONTEXT,
    );

    assert(result.isError);
    const content = result.output[0];
    assert(content?.type === "text");
    expect(content.text).toContain(
      'Generated UI is invalid: Element "grid" has invalid props for Grid: columns: expected one of 1|2|3|4|"main-side". Element "metric" has invalid props for Metric: label: Invalid input: expected string, received number.',
    );
  });

  test("rejects form bindings to undeclared fields before the interface leaves the guest", async () => {
    const tool = await createCodemodeTool({});

    const result = await tool.execute(
      {
        code: `async () => {
          const form = ui.form("approval", { decision: "approve" });
          return { $ui: ui.render(ui.textArea({ label: "Reason", value: form.bind("reason") })) };
        }`,
      },
      toolApi("tool-call-unknown-field"),
      BACKGROUND_CONTEXT,
    );
    expect(result).toMatchObject({
      isError: true,
      details: {
        runId: expect.any(String),
        errorDetails: {
          message:
            'form.bind("reason") names no field of ui.form("approval"); declare it in the initial values.',
        },
      },
    });
  });

  test("surfaces workflow definitions from codemode", async () => {
    const tool = await createCodemodeTool({
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
      toolApi("tool-call-1"),
      BACKGROUND_CONTEXT,
    );

    expect(result.details).toMatchObject({
      workflowDefinition: { name: "pi-session-workflow", options: { name: "pi-session-workflow" } },
      result: { instanceId: "12zjsps1wxc2bo" },
    });
    const content = result.output[0];
    assert(content?.type === "text");
    if (content?.type !== "text") {
      throw new Error("Expected text content from codemode.");
    }
    expect(content.text).toContain("12zjsps1wxc2bo");
  });

  test("returns structured scheduling failures as failed tool results", async () => {
    const requiredPermission = BACKOFFICE_PERMISSION.workflow.executeCode;
    const tool = await createCodemodeTool({
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
      toolApi("tool-call-denied"),
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

  test("schedules and runs a workflow defined from codemode", async () => {
    const stateBackend = createTestStateBackend();
    const workflow = defineRemoteWorkflow({ name: "codemode-script" }, async (event, remote) => {
      const params = codemodeWorkflowParamsSchema.parse(event.payload);
      const result = await runBackofficeCodemodeWorkflow({
        program: params.program,
        dependencies: params.program.dependencies,
        event: {
          id: event.instanceId,
          payload: params.trigger.type === "manual" ? params.trigger.payload : {},
          instanceId: event.instanceId,
          timestamp: event.timestamp,
        },
        remote,
        codemode,
        allowedHooks: [],
        origin: { kind: "inline" } as const,
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

    const tool = await createCodemodeTool({
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
              content: "ran from codemode workflow",
            });
            return await state.readFile({ path: "/workspace/from-workflow.txt" });
          });
        });`,
      },
      toolApi("tool-call-1"),
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
      output: "ran from codemode workflow",
    });
    await expect(stateBackend.readFile("/workspace/from-workflow.txt")).resolves.toBe(
      "ran from codemode workflow",
    );
  });

  // cf-sandbox-bridge's compiler tests install and execute npm dependencies.
  test("schedules a workflow with its requested npm dependencies", async () => {
    const scheduledParams: unknown[] = [];
    const tool = await createCodemodeTool({
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
      toolApi("tool-call-1"),
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
    const tool = await createCodemodeTool({});

    await expect(
      tool.execute(
        {
          code: `async () => {
            return new Map([["key", "value"]]);
          }`,
        },
        toolApi("tool-call-1"),
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow("Value must contain strict JSON plain objects or arrays");
  });

  test("calls workflow domain tools through codemode when configured", async () => {
    const tool = await createCodemodeTool({
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
          waitingFor: [],
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
      toolApi("tool-call-1"),
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

  test("shows saved runs in its own scope as cards in the tool result", async () => {
    const tool = await createCodemodeTool({
      workflowRuntime: createPiWorkflowRuntime({
        getInstance: async ({ instanceId }) => {
          if (instanceId === "missing") {
            throw new Error("Workflow instance missing not found.");
          }
          return {
            id: instanceId,
            details: { status: "waiting" },
            meta: {
              name: "nightly-sync",
              path: "/workspace/automations/nightly-sync.workflow.js",
              createdAt: "2026-08-10T00:00:00.000Z",
              updatedAt: "2026-08-10T00:00:00.000Z",
              startedAt: null,
              completedAt: null,
            },
            waitingFor: [],
          };
        },
      }),
    });

    const result = await tool.execute(
      {
        code: `async () => {
          await workflow.showInstance({ instanceId: "nightly" });
          await workflow.showInstance({ instanceId: "mirror" });
          await workflow.showInstance({ instanceId: "nightly" });
          const missing = await workflow.showInstance({ instanceId: "missing" }).catch((error) => error.message);
          const status = await workflow.getInstance({ instanceId: "read-only" });
          return { missing, status: status.details.status };
        }`,
      },
      toolApi("tool-call-show"),
      BACKGROUND_CONTEXT,
    );

    expect(result.details).toMatchObject({
      result: { missing: expect.stringContaining("missing not found"), status: "waiting" },
      shownRuns: [{ instanceId: "nightly" }, { instanceId: "mirror" }],
    });
    expect(result.details).not.toHaveProperty("run");
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

    const tool = await createCodemodeTool({
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
      toolApi("tool-call-1"),
      BACKGROUND_CONTEXT,
    );

    expect(result.details).toMatchObject({
      result: { key: "telegram/chat-456", value: "user-55" },
      logs: [],
      calls: {
        items: [
          {
            subject: {
              kind: "call",
              name: "store.get",
              scope: null,
              input: '{"key":"telegram/chat-123"}',
            },
            status: "succeeded",
            durationMs: expect.any(Number),
          },
          {
            subject: {
              kind: "call",
              name: "store.set",
              scope: null,
              input: '{"key":"telegram/chat-456","value":"user-55"}',
            },
            status: "succeeded",
            durationMs: expect.any(Number),
          },
        ],
        omitted: 0,
      },
    });
    const content = result.output[0];
    assert(content?.type === "text");
    if (content?.type !== "text") {
      throw new Error("Expected text content from codemode.");
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

  test("retains domain tool validation diagnostics in a failed tool result", async () => {
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

    const tool = await createCodemodeTool({ automationsRuntime });
    const result = await tool.execute(
      {
        code: `async () => {
          return await store.set({ key: "", value: "" });
        }`,
      },
      toolApi("tool-call-1"),
      BACKGROUND_CONTEXT,
    );
    expect(result).toMatchObject({
      isError: true,
      details: {
        runId: expect.any(String),
        errorDetails: { name: "ZodError", message: expect.stringContaining("Too small") },
      },
    });

    expect(calls).toEqual([]);
  });
});

/** A decodable PNG of `width`×`height` RGB pixels: flat gray, or noise that does not compress. */
async function encodePng(width: number, height: number, fill: "gray" | "noise" = "gray") {
  const rowLength = 1 + width * 3;
  const scanlines = new Uint8Array(rowLength * height).fill(0x80);
  if (fill === "noise") {
    let seed = 1;
    for (let index = 0; index < scanlines.length; index++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      scanlines[index] = seed >>> 24;
    }
  }
  for (let row = 0; row < height; row++) {
    // Filter type none.
    scanlines[row * rowLength] = 0;
  }
  const pixels = new Uint8Array(
    await new Response(
      new Blob([scanlines]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  // 8-bit truecolor, default compression and filtering, no interlacing.
  header.set([8, 2, 0, 0, 0], 8);
  const chunks = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", pixels),
    pngChunk("IEND", new Uint8Array()),
  ];
  const png = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  chunks.reduce((offset, chunk) => (png.set(chunk, offset), offset + chunk.length), 0);
  return png;
}

function pngChunk(type: string, data: Uint8Array) {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  let crc = ~0;
  for (const byte of chunk.subarray(4, 8 + data.length)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  view.setUint32(8 + data.length, ~crc >>> 0);
  return chunk;
}

const createCodemodeTool = async ({
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
    instructions: "",
    codemode: codemodeRunnerFor(
      createCloudflareBackofficeObjectRegistry(env as CloudflareEnv).codemode.singleton().commands,
      createBackofficeSystemExecution({ kind: "system" }),
    ),
    authorize: async () => undefined,
    toolContext: () => runtimeToolContext,
  };
  const tool = createPiCodemodeTool({
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
        throw new Error("Expected codemode to return persisted output and details.");
      }
      return {
        output: result.output,
        details: result.details,
        isError: result.isError === true,
      };
    },
  };
};
