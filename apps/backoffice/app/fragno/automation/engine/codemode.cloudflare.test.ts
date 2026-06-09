import { describe, expect, test } from "vitest";

import { env } from "cloudflare:workers";

import type { AutomationRuntimeHostContext, AutomationRuntime } from "@/fragno/automation";
import type { AutomationEvent } from "@/fragno/automation/contracts";
import { executeBashAutomation } from "@/fragno/runtime-tools/automation-host";

import { executeCodemodeAutomation } from "./codemode";
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
    };

    const result = await executeCodemodeAutomation({
      env,
      masterFs: createTestMasterFileSystem({}),
      context: createAutomationContext(event, runtime),
      script: `async () => {
        const event = JSON.parse(await state.readFile("/context/event.json"));
        return await identity.bindActor({
          source: event.source,
          key: event.payload.chatId,
          value: "user-55",
          description: "Linked from codemode",
        });
      }`,
    });

    expect(result).toMatchObject({
      runtime: "codemode",
      eventId: "event-codemode-bind-actor",
      exitCode: 0,
      stderr: "",
      result: {
        source: "telegram",
        key: "chat-123",
        value: "user-55",
        description: "Linked from codemode",
        status: "linked",
      },
      commandCalls: [],
      toolCalls: [
        {
          providerName: "identity",
          toolName: "bindActor",
          toolId: "identity.bind-actor",
          inputSummary:
            '{"source":"telegram","key":"chat-123","value":"user-55","description":"Linked from codemode"}',
          status: "success",
        },
      ],
    });
    expect(calls).toEqual([
      [
        "bindActor",
        {
          source: "telegram",
          key: "chat-123",
          value: "user-55",
          description: "Linked from codemode",
        },
      ],
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
    };
    const context = createAutomationContext(event, runtime);

    const bashResult = await executeBashAutomation({
      masterFs: createTestMasterFileSystem({}),
      context,
      script: "identity.bind-actor --source telegram --key bash-chat --value user-bash",
    });
    const codemodeResult = await executeCodemodeAutomation({
      env,
      masterFs: createTestMasterFileSystem({}),
      context,
      script: `async () => {
        return await identity.bindActor({
          source: "telegram",
          key: "codemode-chat",
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
      toolCalls: [{ toolId: "identity.bind-actor", status: "success" }],
    });
    expect(calls).toEqual([
      ["bindActor", { source: "telegram", key: "bash-chat", value: "user-bash" }],
      ["bindActor", { source: "telegram", key: "codemode-chat", value: "user-codemode" }],
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
    };

    const result = await executeCodemodeAutomation({
      env,
      masterFs: createTestMasterFileSystem({}),
      context: createAutomationContext(event, createRecordingAutomationRuntime(calls)),
      script: `async () => {
        return await identity.bindActor({ source: "telegram", key: "chat-123", value: "" });
      }`,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Too small");
    expect(result.toolCalls).toMatchObject([
      {
        providerName: "identity",
        toolName: "bindActor",
        toolId: "identity.bind-actor",
        status: "error",
      },
    ]);
    expect(calls).toEqual([]);
  });
});

type AutomationContextOptions = {
  runtime?: AutomationRuntime;
  otpRuntime?: AutomationRuntimeHostContext["otp"]["runtime"];
  piRuntime?: NonNullable<AutomationRuntimeHostContext["pi"]>["runtime"] | null;
  telegramRuntime?: AutomationRuntimeHostContext["telegram"]["runtime"];
  binding?: Partial<AutomationRuntimeHostContext["automation"]["binding"]>;
};

const createAutomationContext = (
  event: AutomationEvent,
  runtimeOrOptions: AutomationRuntime | AutomationContextOptions = createUnusedAutomationRuntime(),
): AutomationRuntimeHostContext => {
  const options =
    "lookupBinding" in runtimeOrOptions ? { runtime: runtimeOrOptions } : runtimeOrOptions;
  const runtime = options.runtime ?? createUnusedAutomationRuntime();

  return {
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
  lookupBinding: async () => {
    throw new Error("lookupBinding should not be called in this test.");
  },
  bindActor: async () => {
    throw new Error("bindActor should not be called in this test.");
  },
  createClaim: async () => {
    throw new Error("createClaim should not be called in this test.");
  },
  emitEvent: async () => {
    throw new Error("emitEvent should not be called in this test.");
  },
});

const createRecordingAutomationRuntime = (calls: unknown[]): AutomationRuntime => ({
  lookupBinding: async (input) => {
    calls.push(["lookupBinding", input]);
    return null;
  },
  bindActor: async (input) => {
    calls.push(["bindActor", input]);
    return {
      source: input.source,
      key: input.key,
      value: input.value,
      description: input.description,
      status: "linked",
    };
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
