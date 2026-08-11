import { describe, expect, test, assert, vi } from "vitest";

import { createWorkflowsTestHarness } from "@fragno-dev/workflows/test";
import { defineRemoteWorkflow } from "@fragno-dev/workflows/workflow";
import { env } from "cloudflare:workers";

import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { AutomationRuntimeHostContext, AutomationRuntime } from "@/fragno/automation";
import { AUTOMATION_SYSTEM_INITIATOR } from "@/fragno/automation/actors";
import type { AutomationEvent } from "@/fragno/automation/contracts";
import { CODEMODE_CAPABILITY_ACTOR } from "@/fragno/automation/engine/codemode-invocation";
import {
  MemoryUploadObject,
  createTestStateBackend,
} from "@/fragno/codemode/state-backend.test-utils";
import { executeBashAutomation } from "@/fragno/runtime-tools/automation-host";
import { EMPTY_BASH_HOST_CONTEXT } from "@/fragno/runtime-tools/bash-host.test-utils";
import { createUnavailableAutomationRouterRuntime } from "@/fragno/runtime-tools/families/automations-routing";
import type { BackofficeCapabilitiesRuntime } from "@/fragno/runtime-tools/families/backoffice-capabilities";

import { executeCodemodeAutomation, executeWorkflowCodemodeAutomation } from "./codemode";
import { defineCodemodeWorkflow } from "./codemode-workflow";
import { createTestMasterFileSystem } from "./test-master-file-system.test-utils";

describe("executeCodemodeAutomation", () => {
  test("runs a .cm.js automation with state.* against Upload", async () => {
    const event: AutomationEvent = {
      id: "event-codemode-1",
      scope: { kind: "org", orgId: "org-1" },
      source: "test",
      eventType: "message.received",
      occurredAt: "2026-06-03T00:00:00.000Z",
      payload: { text: "hello" },
      actors: {
        initiator: AUTOMATION_SYSTEM_INITIATOR,
        principal: null,
        delegation: [],
      },
    };

    const stateBackend = createTestStateBackend({
      upload: new MemoryUploadObject({ "event.json": JSON.stringify(event) }),
    });
    const context = createAutomationContext(event);
    context.stateBackend = stateBackend;
    const result = await executeCodemodeAutomation({
      env,
      context,
      script: `async () => {
        const event = JSON.parse(await state.readFile({ path: "/workspace/event.json" }));
        await state.writeFile({
          path: "/workspace/output.json",
          content: JSON.stringify({
            id: event.id,
            text: event.payload.text,
          }),
        });
        console.log("codemode automation wrote output");
        return { ok: true, eventId: event.id };
      }`,
    });

    expect(result).toMatchObject({
      runtime: "codemode",
      eventId: "event-codemode-1",
      scriptId: "script:codemode@1:scripts/context-writer.cm.js",
      exitCode: 0,
      stderr: "",
      logs: ["codemode automation wrote output"],
      result: { ok: true, eventId: "event-codemode-1" },
      stdout: JSON.stringify({ ok: true, eventId: "event-codemode-1" }),
      toolCalls: [
        expect.objectContaining({ toolId: "state.readFile", status: "success" }),
        expect.objectContaining({ toolId: "state.writeFile", status: "success" }),
      ],
    });
    await expect(stateBackend.readFile("/workspace/output.json")).resolves.toBe(
      JSON.stringify({ id: "event-codemode-1", text: "hello" }),
    );
  });

  test("exposes domain-only automation store tools to codemode automations", async () => {
    const calls: unknown[] = [];
    const runtime = createRecordingAutomationRuntime(calls);
    const event: AutomationEvent = {
      id: "event-codemode-bind-actor",
      scope: { kind: "org", orgId: "org-1" },
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-06-03T00:00:00.000Z",
      payload: { chatId: "chat-123" },
      actors: {
        initiator: AUTOMATION_SYSTEM_INITIATOR,
        principal: null,
        delegation: [],
      },
    };

    const result = await executeCodemodeAutomation({
      env,
      context: createAutomationContext(event, runtime),
      script: `async () => await store.set({
        key: "telegram/chat-123",
        value: "user-55",
      })`,
    });

    expect(result).toMatchObject({
      runtime: "codemode",
      eventId: "event-codemode-bind-actor",
      exitCode: 0,
      stderr: "",
      result: {
        key: "telegram/chat-123",
        value: "user-55",
        category: [],
      },
      commandCalls: [],
      toolCalls: [
        {
          providerName: "store",
          toolName: "set",
          toolId: "store.set",
          inputSummary: '{"key":"telegram/chat-123","value":"user-55"}',
          status: "success",
        },
      ],
    });
    expect(calls).toEqual([
      [
        "set",
        {
          key: "telegram/chat-123",
          value: "user-55",
        },
      ],
    ]);
  });

  test("exposes connection configuration tools to codemode automations", async () => {
    const calls: unknown[] = [];
    const event: AutomationEvent = {
      id: "event-codemode-configure-upload",
      scope: { kind: "org", orgId: "org-1" },
      source: "auth",
      eventType: "organization.created",
      occurredAt: "2026-06-12T00:00:00.000Z",
      payload: { id: "org-1", name: "Org 1", slug: "org-1" },
      actors: {
        initiator: AUTOMATION_SYSTEM_INITIATOR,
        principal: null,
        delegation: [],
      },
    };

    const result = await executeCodemodeAutomation({
      env,
      context: createAutomationContext(event, {
        backofficeRuntime: createRecordingBackofficeRuntime(calls),
      }),
      script: `async () => {
        return await connections.configure({
          id: "upload",
          payload: { provider: "database" },
        });
      }`,
    });

    expect(result).toMatchObject({
      runtime: "codemode",
      eventId: "event-codemode-configure-upload",
      exitCode: 0,
      stderr: "",
      result: {
        id: "upload",
        configured: true,
        config: { provider: "database" },
      },
      toolCalls: [
        {
          providerName: "connections",
          toolName: "configure",
          toolId: "connections.configure",
          status: "success",
        },
      ],
    });
    expect(calls).toEqual([
      ["configureConnection", { id: "upload", payload: { provider: "database" } }],
    ]);
  });

  test("exposes connection configuration tools to workflow codemode automations", async () => {
    const calls: unknown[] = [];
    const event: AutomationEvent = {
      id: "event-workflow-configure-upload",
      scope: { kind: "org", orgId: "org-1" },
      source: "auth",
      eventType: "organization.created",
      occurredAt: "2026-06-12T00:00:00.000Z",
      payload: { id: "org-1", name: "Org 1", slug: "org-1" },
      actors: {
        initiator: AUTOMATION_SYSTEM_INITIATOR,
        principal: null,
        delegation: [],
      },
    };
    const Workflow = defineRemoteWorkflow(
      { name: "codemode-workflow-connections-test" },
      async (workflowEvent, remote) =>
        await executeWorkflowCodemodeAutomation({
          env,
          workflowEvent,
          remote,
          context: createAutomationContext(event, {
            backofficeRuntime: createRecordingBackofficeRuntime(calls),
          }),
          script: `defineWorkflow(
            { name: "configure-upload-connection" },
            async (event, step) => {
              return await step.do("configure upload database connection", async () => ({
                ...(await connections.configure({
                  id: "upload",
                  payload: { provider: "database" },
                })),
                eventId: event.id,
              }));
            },
          );`,
        }),
    );
    const harness = await createWorkflowsTestHarness({
      workflows: { WORKFLOW: Workflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    const instanceId = await harness.createInstance("WORKFLOW", {
      id: "codemode-workflow-connections-test-1",
      remoteWorkflowName: "configure-upload-connection",
      params: { automationEvent: event },
    });
    await harness.runUntilIdle({
      workflowName: "codemode-workflow-connections-test",
      instanceId,
      reason: "create",
    });

    await expect(harness.getStatus("WORKFLOW", instanceId)).resolves.toMatchObject({
      status: "complete",
      output: expect.objectContaining({
        exitCode: 0,
        result: expect.objectContaining({
          id: "upload",
          configured: true,
          config: { provider: "database" },
          eventId: "event-workflow-configure-upload",
        }),
      }),
    });
    expect(calls).toEqual([
      ["configureConnection", { id: "upload", payload: { provider: "database" } }],
    ]);
  });

  test("rejects persisted capability grants outside the execution actor chain", async () => {
    const execution = createBackofficeSystemExecution({ kind: "org", orgId: "org-1" });
    const Workflow = defineCodemodeWorkflow({
      env: env as Parameters<typeof defineCodemodeWorkflow>[0]["env"],
      runtime: {} as BackofficeRuntimeServices,
    });
    const harness = await createWorkflowsTestHarness({
      workflows: { WORKFLOW: Workflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });
    const instanceId = await harness.createInstance("WORKFLOW", {
      id: "invalid-capability-grant-1",
      remoteWorkflowName: "invalid-capability-grant",
      params: {
        program: {
          code: `defineWorkflow({ name: "invalid-capability-grant" }, async () => undefined);`,
          dependencies: {},
          workflowName: "invalid-capability-grant",
          filename: "/workspace/automations/invalid-capability-grant.workflow.js",
        },
        trigger: { type: "manual", payload: {} },
        execution: {
          scope: execution.scope,
          actors: execution.actors,
          capabilityGrants: [
            {
              actor: CODEMODE_CAPABILITY_ACTOR,
              permissions: [BACKOFFICE_PERMISSION.router.modify],
            },
          ],
        },
      },
    });

    await harness.runUntilIdle({
      workflowName: "codemode-script",
      instanceId,
      reason: "create",
    });

    await expect(harness.getStatus("WORKFLOW", instanceId)).resolves.toMatchObject({
      status: "errored",
      error: {
        message: expect.stringContaining("is not part of the execution delegation chain"),
      },
    });
  });

  test("seals workflow codemode egress even when the host has an outbound binding", async () => {
    const outboundFetch = vi.fn(async () => new Response("unexpected outbound response"));
    const event: AutomationEvent = {
      id: "event-workflow-egress",
      scope: { kind: "org", orgId: "org-1" },
      source: "test",
      eventType: "workflow.egress",
      occurredAt: "2026-08-11T00:00:00.000Z",
      payload: {},
      actors: {
        initiator: AUTOMATION_SYSTEM_INITIATOR,
        principal: null,
        delegation: [],
      },
    };
    const Workflow = defineRemoteWorkflow(
      { name: "codemode-workflow-egress-test" },
      async (workflowEvent, remote) =>
        await executeWorkflowCodemodeAutomation({
          env: { ...env, OUTBOUND: { fetch: outboundFetch } as unknown as Fetcher },
          workflowEvent,
          remote,
          context: createAutomationContext(event),
          script: `defineWorkflow(
            { name: "blocked-workflow-egress" },
            async (_event, step) => {
              return await step.do("blocked fetch", async () => {
                const response = await fetch("https://example.com/private");
                return await response.text();
              });
            },
          );`,
        }),
    );
    const harness = await createWorkflowsTestHarness({
      workflows: { WORKFLOW: Workflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });
    const instanceId = await harness.createInstance("WORKFLOW", {
      id: "codemode-workflow-egress-test-1",
      remoteWorkflowName: "blocked-workflow-egress",
    });

    await harness.runUntilIdle({
      workflowName: "codemode-workflow-egress-test",
      instanceId,
      reason: "create",
    });

    await expect(harness.getStatus("WORKFLOW", instanceId)).resolves.toMatchObject({
      status: "complete",
      output: expect.objectContaining({
        exitCode: 1,
        stderr: expect.stringContaining("not permitted to access the internet"),
      }),
    });
    expect(outboundFetch).not.toHaveBeenCalled();
  });

  test("exposes event tools to codemode automations", async () => {
    const calls: unknown[] = [];
    const runtime = createRecordingAutomationRuntime(calls);
    const eventFixture: AutomationEvent = {
      id: "event-codemode-emit-event",
      scope: { kind: "org", orgId: "org-1" },
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-06-03T00:00:00.000Z",
      payload: { plan: "basic" },
      actors: {
        initiator: AUTOMATION_SYSTEM_INITIATOR,
        principal: null,
        delegation: [],
      },
    };

    const result = await executeCodemodeAutomation({
      env,
      context: createAutomationContext(eventFixture, runtime),
      script: `async () => await events.fire({
        eventType: "identity.bound",
        source: "telegram",
        payload: { plan: "basic" },
      })`,
    });

    expect(result).toMatchObject({
      runtime: "codemode",
      eventId: "event-codemode-emit-event",
      exitCode: 0,
      stderr: "",
      result: {
        accepted: true,
        eventId: "emitted-1",
        source: "telegram",
        eventType: "identity.bound",
      },
      toolCalls: [
        {
          providerName: "events",
          toolName: "fire",
          toolId: "events.fire",
          status: "success",
        },
      ],
    });
    expect(calls).toEqual([
      [
        "emitEvent",
        { eventType: "identity.bound", source: "telegram", payload: { plan: "basic" } },
      ],
    ]);
  });

  test("uses the same automation identity tool definition through bash and codemode", async () => {
    const calls: unknown[] = [];
    const runtime = createRecordingAutomationRuntime(calls);
    const event: AutomationEvent = {
      id: "event-shared-tool-definition",
      scope: { kind: "org", orgId: "org-1" },
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-06-03T00:00:00.000Z",
      payload: {},
      actors: {
        initiator: AUTOMATION_SYSTEM_INITIATOR,
        principal: null,
        delegation: [],
      },
    };
    const context = createAutomationContext(event, runtime);

    const bashResult = await executeBashAutomation({
      context,
      masterFs: createTestMasterFileSystem({}),
      script: "store.set --key telegram/bash-chat --value user-bash",
    });
    const codemodeResult = await executeCodemodeAutomation({
      env,
      context,
      script: `async () => {
        return await store.set({
          key: "telegram/codemode-chat",
          value: "user-codemode",
        });
      }`,
    });

    expect(bashResult).toMatchObject({
      runtime: "bash",
      exitCode: 0,
      logs: [],
      toolCalls: [],
    });
    expect(codemodeResult).toMatchObject({
      runtime: "codemode",
      exitCode: 0,
      commandCalls: [],
      toolCalls: [{ toolId: "store.set", status: "success" }],
    });
    expect(calls).toEqual([
      [
        "set",
        {
          key: "telegram/bash-chat",
          value: "user-bash",
        },
      ],
      [
        "set",
        {
          key: "telegram/codemode-chat",
          value: "user-codemode",
        },
      ],
    ]);
  });

  test("returns a useful failed result when a codemode automation domain call is invalid", async () => {
    const calls: unknown[] = [];
    const event: AutomationEvent = {
      id: "event-codemode-invalid-tool-call",
      scope: { kind: "org", orgId: "org-1" },
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-06-03T00:00:00.000Z",
      payload: {},
      actors: {
        initiator: AUTOMATION_SYSTEM_INITIATOR,
        principal: null,
        delegation: [],
      },
    };

    const result = await executeCodemodeAutomation({
      env,
      context: createAutomationContext(event, createRecordingAutomationRuntime(calls)),
      script: `async () => {
        return await store.set({ key: "", value: "" });
      }`,
    });

    assert(result.exitCode === 1);
    expect(result.stderr).toContain("Too small");
    expect(result.toolCalls).toMatchObject([
      {
        providerName: "store",
        toolName: "set",
        toolId: "store.set",
        status: "error",
      },
    ]);
    expect(calls).toEqual([]);
  });
});

type AutomationContextOptions = {
  runtime?: AutomationRuntime;
  backofficeRuntime?: BackofficeCapabilitiesRuntime;
  otpRuntime?: AutomationRuntimeHostContext["otp"]["runtime"];
  piRuntime?: NonNullable<AutomationRuntimeHostContext["pi"]>["runtime"] | null;
  telegramRuntime?: NonNullable<AutomationRuntimeHostContext["telegram"]>["runtime"];
  binding?: Partial<AutomationRuntimeHostContext["automation"]["binding"]>;
};

const createAutomationContext = (
  event: AutomationEvent,
  runtimeOrOptions: AutomationRuntime | AutomationContextOptions = createUnusedAutomationRuntime(),
): AutomationRuntimeHostContext => {
  const options = "get" in runtimeOrOptions ? { runtime: runtimeOrOptions } : runtimeOrOptions;
  const runtime = options.runtime ?? createUnusedAutomationRuntime();

  return {
    ...EMPTY_BASH_HOST_CONTEXT,
    stateBackend: createTestStateBackend(),
    backoffice: options.backofficeRuntime ? { runtime: options.backofficeRuntime } : null,
    automation: {
      event,
      orgId: event.scope.kind === "org" ? event.scope.orgId : undefined,
      binding: {
        id: "codemode-binding",
        source: event.source,
        eventType: event.eventType,
        scriptId: "script:codemode@1:scripts/context-writer.cm.js",
        scriptKey: "codemode",
        scriptName: "Codemode",
        scriptPath: "scripts/context-writer.cm.js",
        scriptVersion: 1,
        ...options.binding,
      },
      idempotencyKey: "idem-codemode",
      runtime,
    },
    automations: { runtime },
    otp: { runtime: options.otpRuntime ?? runtime },
    pi: options.piRuntime ? { runtime: options.piRuntime } : null,
    reson8: { runtime: createUnavailableRuntime("reson8") },
    resend: { runtime: createUnavailableRuntime("resend") },
    telegram: { runtime: options.telegramRuntime ?? createUnavailableRuntime("telegram") },
  };
};

const createUnusedAutomationRuntime = (): AutomationRuntime => ({
  ...createUnavailableAutomationRouterRuntime(),
  get: async () => {
    throw new Error("get should not be called in this test.");
  },
  set: async () => {
    throw new Error("set should not be called in this test.");
  },
  delete: async () => {
    throw new Error("delete should not be called in this test.");
  },
  list: async () => {
    throw new Error("list should not be called in this test.");
  },
  createClaim: async () => {
    throw new Error("createClaim should not be called in this test.");
  },
  emitEvent: async () => {
    throw new Error("emitEvent should not be called in this test.");
  },
});

const createRecordingBackofficeRuntime = (calls: unknown[]): BackofficeCapabilitiesRuntime =>
  new Proxy(
    {
      configureConnection: async (input: { id: string; payload: unknown; origin?: string }) => {
        calls.push(["configureConnection", input]);
        return {
          id: input.id,
          label: input.id,
          kind: "connection" as const,
          configured: true,
          config: input.payload as Record<string, unknown>,
        };
      },
    },
    {
      get(target, property: string) {
        if (property in target) {
          return target[property as keyof typeof target];
        }
        return async () => {
          throw new Error(property + " should not be called in this test.");
        };
      },
    },
  ) as BackofficeCapabilitiesRuntime;

const createRecordingAutomationRuntime = (calls: unknown[]): AutomationRuntime => ({
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
    return [];
  },
  createClaim: async () => {
    throw new Error("createClaim should not be called in this test.");
  },
  emitEvent: async (input) => {
    calls.push(["emitEvent", input]);
    return {
      accepted: true,
      eventId: "emitted-1",
      scope: input.targetScope ?? { kind: "org", orgId: "org-1" },
      source: input.source ?? "telegram",
      eventType: input.eventType,
    };
  },
});

const createUnavailableRuntime = (name: string) =>
  new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new Error(`${name} runtime should not be called in this test.`);
        };
      },
    },
  ) as never;
