import { describe, expect, test, assert } from "vitest";

import { createWorkflowsTestHarness } from "@fragno-dev/workflows/test";
import { defineRemoteWorkflow } from "@fragno-dev/workflows/workflow";
import { env } from "cloudflare:workers";

import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import type { AutomationRuntimeHostContext, AutomationRuntime } from "@/fragno/automation";
import { AUTOMATION_SYSTEM_ACTOR, type AutomationEvent } from "@/fragno/automation/contracts";
import { executeBashAutomation } from "@/fragno/runtime-tools/automation-host";
import { EMPTY_BASH_HOST_CONTEXT } from "@/fragno/runtime-tools/bash-host.test-utils";
import type { BackofficeCapabilitiesRuntime } from "@/fragno/runtime-tools/families/backoffice-capabilities";

import { executeCodemodeAutomation, executeWorkflowCodemodeAutomation } from "./codemode";
import { createTestMasterFileSystem } from "./test-master-file-system.test-utils";

describe("executeCodemodeAutomation", () => {
  test("runs a .cm.js automation with state.* and /context/event.json", async () => {
    const masterFs = createTestMasterFileSystem({});
    const event: AutomationEvent = {
      id: "event-codemode-1",
      orgId: "org-1",
      source: "test",
      eventType: "message.received",
      occurredAt: "2026-06-03T00:00:00.000Z",
      payload: { text: "hello" },
      actor: AUTOMATION_SYSTEM_ACTOR,
      actors: [AUTOMATION_SYSTEM_ACTOR],
    };

    const result = await executeCodemodeAutomation({
      env,
      masterFs,
      context: createAutomationContext(event),
      script: `async () => {
        const event = JSON.parse(await state.readFile("/context/event.json"));
        await state.writeFile("/workspace/output.json", JSON.stringify({
          id: event.id,
          text: event.payload.text,
        }));
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
      toolCalls: [],
    });
    await expect(masterFs.readFile("/workspace/output.json")).resolves.toBe(
      JSON.stringify({ id: "event-codemode-1", text: "hello" }),
    );
  });

  test("exposes automation identity tools to codemode automations", async () => {
    const calls: unknown[] = [];
    const runtime = createRecordingAutomationRuntime(calls);
    const event: AutomationEvent = {
      id: "event-codemode-bind-actor",
      orgId: "org-1",
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-06-03T00:00:00.000Z",
      payload: { chatId: "chat-123" },
      actor: AUTOMATION_SYSTEM_ACTOR,
      actors: [AUTOMATION_SYSTEM_ACTOR],
    };

    const result = await executeCodemodeAutomation({
      env,
      masterFs: createTestMasterFileSystem({}),
      context: createAutomationContext(event, runtime),
      script: `async () => {
        const event = JSON.parse(await state.readFile("/context/event.json"));
        return await store.set({
          key: event.source + "/" + event.payload.chatId,
          value: "user-55",
          actor: { scope: "external", source: "telegram", type: "chat", id: "chat-123" },
        });
      }`,
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
        actor: { scope: "external", source: "telegram", type: "chat", id: "chat-123" },
      },
      commandCalls: [],
      toolCalls: [
        {
          providerName: "store",
          toolName: "set",
          toolId: "store.set",
          inputSummary:
            '{"key":"telegram/chat-123","value":"user-55","actor":{"scope":"external","source":"telegram","type":"chat","id":"chat-123"}}',
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
          actor: { scope: "external", source: "telegram", type: "chat", id: "chat-123" },
        },
      ],
    ]);
  });

  test("exposes connection configuration tools to codemode automations", async () => {
    const calls: unknown[] = [];
    const event: AutomationEvent = {
      id: "event-codemode-configure-upload",
      orgId: "org-1",
      source: "auth",
      eventType: "organization.created",
      occurredAt: "2026-06-12T00:00:00.000Z",
      payload: { id: "org-1", name: "Org 1", slug: "org-1" },
      actor: AUTOMATION_SYSTEM_ACTOR,
      actors: [AUTOMATION_SYSTEM_ACTOR],
    };

    const result = await executeCodemodeAutomation({
      env,
      masterFs: createTestMasterFileSystem({}),
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
      orgId: "org-1",
      source: "auth",
      eventType: "organization.created",
      occurredAt: "2026-06-12T00:00:00.000Z",
      payload: { id: "org-1", name: "Org 1", slug: "org-1" },
      actor: AUTOMATION_SYSTEM_ACTOR,
      actors: [AUTOMATION_SYSTEM_ACTOR],
    };
    const Workflow = defineRemoteWorkflow(
      { name: "codemode-workflow-connections-test" },
      async (workflowEvent, remote) =>
        await executeWorkflowCodemodeAutomation({
          env,
          workflowEvent,
          remote,
          masterFs: createTestMasterFileSystem({}),
          context: createAutomationContext(event, {
            backofficeRuntime: createRecordingBackofficeRuntime(calls),
          }),
          script: `defineWorkflow(
            { name: "configure-upload-connection" },
            async (_event, step) => {
              return await step.do("configure upload database connection", async () => {
                return await connections.configure({
                  id: "upload",
                  payload: { provider: "database" },
                });
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
        }),
      }),
    });
    expect(calls).toEqual([
      ["configureConnection", { id: "upload", payload: { provider: "database" } }],
    ]);
  });

  test("exposes event tools to codemode automations", async () => {
    const calls: unknown[] = [];
    const runtime = createRecordingAutomationRuntime(calls);
    const eventFixture: AutomationEvent = {
      id: "event-codemode-emit-event",
      orgId: "org-1",
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-06-03T00:00:00.000Z",
      payload: { plan: "basic" },
      actor: AUTOMATION_SYSTEM_ACTOR,
      actors: [AUTOMATION_SYSTEM_ACTOR],
    };

    const result = await executeCodemodeAutomation({
      env,
      masterFs: createTestMasterFileSystem({}),
      context: createAutomationContext(eventFixture, runtime),
      script: `async () => {
        const eventFixture = JSON.parse(await state.readFile("/context/event.json"));
        return await event.emit({
          eventType: "identity.bound",
          source: eventFixture.source,
          payload: eventFixture.payload,
        });
      }`,
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
          providerName: "event",
          toolName: "emit",
          toolId: "event.emit",
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
      orgId: "org-1",
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-06-03T00:00:00.000Z",
      payload: {},
      actor: AUTOMATION_SYSTEM_ACTOR,
      actors: [AUTOMATION_SYSTEM_ACTOR],
    };
    const context = createAutomationContext(event, runtime);

    const bashResult = await executeBashAutomation({
      masterFs: createTestMasterFileSystem({}),
      context,
      script:
        'store.set --key telegram/bash-chat --value user-bash --actor \'{"scope":"external","source":"telegram","type":"chat","id":"chat-123"}\'',
    });
    const codemodeResult = await executeCodemodeAutomation({
      env,
      masterFs: createTestMasterFileSystem({}),
      context,
      script: `async () => {
        return await store.set({
          key: "telegram/codemode-chat",
          value: "user-codemode",
          actor: { scope: "external", source: "telegram", type: "chat", id: "chat-123" },
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
          actor: { scope: "external", source: "telegram", type: "chat", id: "chat-123" },
        },
      ],
      [
        "set",
        {
          key: "telegram/codemode-chat",
          value: "user-codemode",
          actor: { scope: "external", source: "telegram", type: "chat", id: "chat-123" },
        },
      ],
    ]);
  });

  test("returns a useful failed result when a codemode automation domain call is invalid", async () => {
    const calls: unknown[] = [];
    const event: AutomationEvent = {
      id: "event-codemode-invalid-tool-call",
      orgId: "org-1",
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-06-03T00:00:00.000Z",
      payload: {},
      actor: AUTOMATION_SYSTEM_ACTOR,
      actors: [AUTOMATION_SYSTEM_ACTOR],
    };

    const result = await executeCodemodeAutomation({
      env,
      masterFs: createTestMasterFileSystem({}),
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
    backoffice: options.backofficeRuntime ? { runtime: options.backofficeRuntime } : null,
    automation: {
      event,
      orgId: event.orgId,
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
