import { describe, expect, test } from "vitest";

import { env } from "cloudflare:workers";

import { STARTER_AUTOMATION_CONTENT, STARTER_AUTOMATION_SCRIPT_PATHS } from "@/files";
import type { AutomationRuntimeHostContext, AutomationRuntime } from "@/fragno/automation";
import type { AutomationEvent } from "@/fragno/automation/contracts";
import { executeBashAutomation } from "@/fragno/runtime-tools/automation-host";

import { executeCodemodeAutomation, renderCodemodeWorkflowToolGlobals } from "./codemode";
import { createTestMasterFileSystem } from "./test-master-file-system.test-utils";

describe("renderCodemodeWorkflowToolGlobals", () => {
  test("renders workflow globals grouped by namespace", () => {
    expect(
      renderCodemodeWorkflowToolGlobals([
        { namespace: "automations", name: "lookupBinding" },
        { namespace: "automations", name: "bindActor" },
        { namespace: "telegram", name: "sendMessage" },
      ] as never),
    ).toMatchInlineSnapshot(`
      "const automations = {
        "lookupBinding": (input) => callTool("automations", "lookupBinding", input),
        "bindActor": (input) => callTool("automations", "bindActor", input)
      };

      const telegram = {
        "sendMessage": (input) => callTool("telegram", "sendMessage", input)
      };"
    `);
  });

  test("quotes non-identifier namespace and tool names", () => {
    expect(
      renderCodemodeWorkflowToolGlobals([
        { namespace: "custom-tools", name: "send.message" },
      ] as never),
    ).toMatchInlineSnapshot(`
      "globalThis["custom-tools"] = {
        "send.message": (input) => callTool("custom-tools", "send.message", input)
      };"
    `);
  });
});

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

  test("captures console.log and console.error output", async () => {
    const event: AutomationEvent = {
      id: "event-codemode-console-output",
      orgId: "org-1",
      source: "test",
      eventType: "message.received",
      occurredAt: "2026-06-03T00:00:00.000Z",
      payload: {},
    };

    const result = await executeCodemodeAutomation({
      env,
      masterFs: createTestMasterFileSystem({}),
      context: createAutomationContext(event),
      script: `async () => {
        console.log("codemode console.log is visible");
        console.error("codemode console.error is visible");
        return { ok: true };
      }`,
    });

    expect(result).toMatchObject({
      runtime: "codemode",
      eventId: "event-codemode-console-output",
      exitCode: 0,
      stderr: "",
      logs: ["codemode console.log is visible", "[error] codemode console.error is visible"],
      result: { ok: true },
      stdout: JSON.stringify({ ok: true }),
    });
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
        return await automations.bindActor({
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
          providerName: "automations",
          toolName: "bindActor",
          toolId: "automations.identity.bind-actor",
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
      script: "automations.identity.bind-actor --source telegram --key bash-chat --value user-bash",
    });
    const codemodeResult = await executeCodemodeAutomation({
      env,
      masterFs: createTestMasterFileSystem({}),
      context,
      script: `async () => {
        return await automations.bindActor({
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
      toolCalls: [{ toolId: "automations.identity.bind-actor", status: "success" }],
    });
    expect(calls).toEqual([
      ["bindActor", { source: "telegram", key: "bash-chat", value: "user-bash" }],
      ["bindActor", { source: "telegram", key: "codemode-chat", value: "user-codemode" }],
    ]);
  });

  test("defines the starter Telegram claim linking start automation as a workflow", () => {
    const script = starterAutomationScript("telegramClaimLinkingStart");

    expect(script).toContain('defineWorkflow({ name: "telegram-claim-linking-start" }');
    expect(script).toContain('step.do("read event"');
    expect(script).toContain('step.do("lookup binding"');
    expect(script).toContain('step.do("create claim"');
    expect(script).toContain('step.do("send claim link"');
  });

  test("runs the starter Telegram claim linking completion automation", async () => {
    const calls: unknown[] = [];
    const runtime = createStarterAutomationRuntime(calls);
    const event: AutomationEvent = {
      id: "starter-telegram-claim-complete-1",
      orgId: "org-1",
      source: "otp",
      eventType: "identity.claim.completed",
      occurredAt: "2026-06-03T00:00:00.000Z",
      payload: { linkSource: "telegram", externalActorId: "chat-123" },
      subject: { userId: "user-55" },
    };

    const result = await executeCodemodeAutomation({
      env,
      masterFs: createTestMasterFileSystem({}),
      context: createAutomationContext(event, {
        runtime,
        telegramRuntime: createRecordingTelegramRuntime(calls),
        binding: {
          id: "telegram-claim-linking-complete",
          source: "otp",
          eventType: "identity.claim.completed",
          scriptId: "script:codemode@1:automations/scripts/telegram-claim-linking.complete.cm.js",
          scriptKey: "telegram-claim-linking.complete",
          scriptName: "Telegram claim linking completion",
          scriptPath: STARTER_AUTOMATION_SCRIPT_PATHS.telegramClaimLinkingComplete,
        },
      }),
      script: starterAutomationScript("telegramClaimLinkingComplete"),
    });

    expect(result).toMatchObject({
      runtime: "codemode",
      eventId: "starter-telegram-claim-complete-1",
      exitCode: 0,
      stderr: "",
    });
    expect(calls).toEqual([
      ["bindActor", { source: "telegram", key: "chat-123", value: "user-55" }],
      [
        "sendMessage",
        {
          chatId: "chat-123",
          text: "Your Telegram chat is now linked.",
          parseMode: "Markdown",
        },
      ],
    ]);
    expect(result.toolCalls).toMatchObject([
      { providerName: "automations", toolName: "bindActor", status: "success" },
      { providerName: "telegram", toolName: "sendMessage", status: "success" },
    ]);
  });

  test("runs the starter Telegram Pi session ensure automation", async () => {
    const calls: unknown[] = [];
    const runtime = createStarterAutomationRuntime(calls, {
      lookupBinding: async (input) => {
        calls.push(["lookupBinding", input]);

        if (input.source === "telegram") {
          return { source: input.source, key: input.key, value: "user-55", status: "linked" };
        }

        return null;
      },
    });
    const event: AutomationEvent = {
      id: "starter-telegram-pi-session-1",
      orgId: "org-1",
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-06-03T00:00:00.000Z",
      payload: { text: "Hello Pi", chatId: "chat-123" },
      actor: { type: "external", externalId: "chat-123" },
    };

    const result = await executeCodemodeAutomation({
      env,
      masterFs: createTestMasterFileSystem({}),
      context: createAutomationContext(event, {
        runtime,
        piRuntime: createRecordingPiRuntime(calls),
        telegramRuntime: createRecordingTelegramRuntime(calls),
        bashEnv: { PI_DEFAULT_AGENT: "default::openai::gpt-5-mini" },
        binding: {
          scriptId: "script:codemode@1:automations/scripts/telegram-pi-session.ensure.cm.js",
          scriptKey: "telegram-pi-session.ensure",
          scriptName: "Telegram Pi session ensure (linked chat)",
          scriptPath: STARTER_AUTOMATION_SCRIPT_PATHS.telegramPiSessionEnsure,
        },
      }),
      script: starterAutomationScript("telegramPiSessionEnsure"),
    });

    expect(result).toMatchObject({
      runtime: "codemode",
      eventId: "starter-telegram-pi-session-1",
      exitCode: 0,
      stderr: "",
    });
    expect(calls).toEqual([
      ["lookupBinding", { source: "telegram", key: "chat-123" }],
      ["lookupBinding", { source: "telegram-pi-session", key: "user-55" }],
      [
        "createSession",
        {
          agent: "default::openai::gpt-5-mini",
          name: "Telegram chat-123",
          tags: ["telegram", "auto-session"],
          systemMessage:
            "IMPORTANT:ALL non-tool call output will AUTOMATICALLY be forwarded to Telegram in Markdown parse mode.",
        },
      ],
      [
        "bindActor",
        {
          source: "telegram-pi-session",
          key: "user-55",
          value: "session-1",
          description: "Pi session for Telegram chat chat-123",
        },
      ],
      ["sendChatAction", { chatId: "chat-123", action: "typing" }],
      ["runTurn", { sessionId: "session-1", text: "Hello Pi" }],
      ["sendMessage", { chatId: "chat-123", text: "assistant: Hello Pi", parseMode: "Markdown" }],
    ]);
    expect(result.toolCalls).toMatchObject([
      { providerName: "automations", toolName: "lookupBinding", status: "success" },
      { providerName: "automations", toolName: "lookupBinding", status: "success" },
      { providerName: "pi", toolName: "createSession", status: "success" },
      { providerName: "automations", toolName: "bindActor", status: "success" },
      { providerName: "telegram", toolName: "sendChatAction", status: "success" },
      { providerName: "pi", toolName: "runTurn", status: "success" },
      { providerName: "telegram", toolName: "sendMessage", status: "success" },
    ]);
  });

  test("runs the starter Telegram Pi session ensure automation when Pi returns serialized dates", async () => {
    const calls: unknown[] = [];
    const runtime = createStarterAutomationRuntime(calls, {
      lookupBinding: async (input) => {
        calls.push(["lookupBinding", input]);

        if (input.source === "telegram") {
          return { source: input.source, key: input.key, value: "user-55", status: "linked" };
        }

        return null;
      },
    });
    const event: AutomationEvent = {
      id: "telegram:h1gl8e7bsqr41gl8e7bsqr41:504243567:129626722:309",
      orgId: "h1gl8e7bsqr41gl8e7bsqr41",
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-06-03T00:00:00.000Z",
      payload: { text: "/pi", chatId: "129626722" },
      actor: { type: "external", externalId: "129626722" },
    };

    const result = await executeCodemodeAutomation({
      env,
      masterFs: createTestMasterFileSystem({}),
      context: createAutomationContext(event, {
        runtime,
        piRuntime: createStringDatedPiRuntime(calls),
        telegramRuntime: createRecordingTelegramRuntime(calls),
        bashEnv: { PI_DEFAULT_AGENT: "default::openai::gpt-5-mini" },
        binding: {
          id: "telegram-pi-session-ensure",
          scriptId: "script:telegram-pi-session.ensure@1:scripts/telegram-pi-session.ensure.cm.js",
          scriptKey: "telegram-pi-session.ensure",
          scriptName: "Telegram Pi session ensure (linked chat)",
          scriptPath: STARTER_AUTOMATION_SCRIPT_PATHS.telegramPiSessionEnsure,
        },
      }),
      script: starterAutomationScript("telegramPiSessionEnsure"),
    });

    expect(result).toMatchObject({
      runtime: "codemode",
      eventId: "telegram:h1gl8e7bsqr41gl8e7bsqr41:504243567:129626722:309",
      exitCode: 0,
      stderr: "",
    });
    expect(calls).toEqual([
      ["lookupBinding", { source: "telegram", key: "129626722" }],
      ["lookupBinding", { source: "telegram-pi-session", key: "user-55" }],
      [
        "createSession",
        expect.objectContaining({
          agent: "default::openai::gpt-5-mini",
          name: "Telegram 129626722",
        }),
      ],
      [
        "bindActor",
        {
          source: "telegram-pi-session",
          key: "user-55",
          value: "session-with-string-dates",
          description: "Pi session for Telegram chat 129626722",
        },
      ],
      [
        "sendMessage",
        {
          chatId: "129626722",
          text: "Created Pi session: session-with-string-dates",
          parseMode: "Markdown",
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
    };

    const result = await executeCodemodeAutomation({
      env,
      masterFs: createTestMasterFileSystem({}),
      context: createAutomationContext(event, createRecordingAutomationRuntime(calls)),
      script: `async () => {
        return await automations.bindActor({ source: "telegram", key: "chat-123", value: "" });
      }`,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Too small");
    expect(result.toolCalls).toMatchObject([
      {
        providerName: "automations",
        toolName: "bindActor",
        toolId: "automations.identity.bind-actor",
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
  bashEnv?: AutomationRuntimeHostContext["automation"]["bashEnv"];
  binding?: Partial<AutomationRuntimeHostContext["automation"]["binding"]>;
};

const starterAutomationScript = (key: keyof typeof STARTER_AUTOMATION_SCRIPT_PATHS): string => {
  const content = (STARTER_AUTOMATION_CONTENT as Record<string, string | Uint8Array>)[
    STARTER_AUTOMATION_SCRIPT_PATHS[key]
  ];

  if (typeof content !== "string") {
    throw new Error(`Expected starter automation ${key} to be text content.`);
  }

  return content;
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
        scriptEnv: {},
        ...options.binding,
      },
      idempotencyKey: "idem-codemode",
      bashEnv: options.bashEnv ?? {},
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

const createStarterAutomationRuntime = (
  calls: unknown[],
  overrides: Partial<AutomationRuntime> = {},
): AutomationRuntime => ({
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
  emitEvent: async () => {
    throw new Error("emitEvent should not be called in this test.");
  },
  ...overrides,
});

const createRecordingTelegramRuntime = (
  calls: unknown[],
): AutomationRuntimeHostContext["telegram"]["runtime"] => ({
  getFile: async () => {
    throw new Error("getFile should not be called in this test.");
  },
  downloadFile: async () => {
    throw new Error("downloadFile should not be called in this test.");
  },
  sendMessage: async (input) => {
    calls.push(["sendMessage", input]);
    return { ok: true, queued: true };
  },
  sendChatAction: async (input) => {
    calls.push(["sendChatAction", input]);
    return { ok: true };
  },
  editMessage: async () => {
    throw new Error("editMessage should not be called in this test.");
  },
});

const createRecordingPiRuntime = (
  calls: unknown[],
): NonNullable<AutomationRuntimeHostContext["pi"]>["runtime"] => ({
  createSession: async (input) => {
    calls.push(["createSession", input]);
    return {
      id: "session-1",
      name: input.name ?? null,
      status: "waiting" as const,
      agent: input.agent,
      workflowName: "interactive-chat-workflow",
      metadata: input.metadata ?? null,
      tags: input.tags ?? [],
      steeringMode: input.steeringMode ?? "one-at-a-time",
      createdAt: new Date("2026-06-03T00:00:00.000Z"),
      updatedAt: new Date("2026-06-03T00:00:00.000Z"),
    };
  },
  getSession: async (input) => {
    calls.push(["getSession", input]);
    return createPiSessionDetail(input.sessionId, "");
  },
  listSessions: async () => {
    throw new Error("listSessions should not be called in this test.");
  },
  runTurn: async (input) => {
    calls.push(["runTurn", input]);
    return createPiSessionDetail(input.sessionId, `assistant: ${input.text}`);
  },
});

const createStringDatedPiRuntime = (
  calls: unknown[],
): NonNullable<AutomationRuntimeHostContext["pi"]>["runtime"] => ({
  ...createRecordingPiRuntime(calls),
  createSession: async (input) => {
    calls.push(["createSession", input]);
    return {
      id: "session-with-string-dates",
      name: input.name ?? null,
      status: "waiting",
      agent: input.agent,
      workflowName: "interactive-chat-workflow",
      metadata: input.metadata ?? null,
      tags: input.tags ?? [],
      steeringMode: input.steeringMode ?? "one-at-a-time",
      createdAt: "2026-06-03T00:00:00.000Z",
      updatedAt: "2026-06-03T00:00:00.000Z",
    } as never;
  },
});

const createPiSessionDetail = (sessionId: string, assistantText: string) => ({
  id: sessionId,
  name: "Telegram chat-123",
  status: "waiting" as const,
  agentName: "default::openai::gpt-5-mini",
  workflowName: "interactive-chat-workflow",
  workflow: { status: "waiting" as const },
  agent: { state: { messages: [] }, events: [] },
  metadata: null,
  tags: ["telegram", "auto-session"],
  steeringMode: "one-at-a-time" as const,
  createdAt: new Date("2026-06-03T00:00:00.000Z"),
  updatedAt: new Date("2026-06-03T00:00:00.000Z"),
  assistantText,
  messageStatus: "waiting" as const,
  stream: [],
  terminalState: { messages: [] },
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
