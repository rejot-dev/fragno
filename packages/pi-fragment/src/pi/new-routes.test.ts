import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { drainDurableHooks } from "@fragno-dev/test";
import { createWorkflowLiveStateStore } from "@fragno-dev/workflows";

import {
  buildHarness,
  createDelayedStreamFn,
  createFailingStreamFn,
  createStreamFn,
  findWorkflowSteps,
  mockModel,
} from "./test-utils";
import type { PiActiveSessionProtocolMessage, PiFragmentConfig, PiWorkflowsService } from "./types";
import {
  createInitialPiAgentLoopState,
  ensurePiActiveSessionState,
} from "./workflow/active-session";

const userTextsFrom = (messages: Array<{ role?: string; content?: unknown }>) =>
  messages.flatMap((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) {
      return [];
    }
    return message.content.flatMap((block) =>
      block &&
      typeof block === "object" &&
      "type" in block &&
      block.type === "text" &&
      "text" in block
        ? [String(block.text)]
        : [],
    );
  });

const assistantTextsFrom = (messages: Array<{ role?: string; content?: unknown }>) =>
  messages.flatMap((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return [];
    }
    return message.content.flatMap((block) =>
      block &&
      typeof block === "object" &&
      "type" in block &&
      block.type === "text" &&
      "text" in block
        ? [String(block.text)]
        : [],
    );
  });

describe("pi-fragment command routes", () => {
  type TestHarness = Awaited<ReturnType<typeof buildHarness>>;
  let cleanup: TestHarness["test"]["cleanup"];
  let callRoute: TestHarness["fragments"]["pi"]["callRoute"];
  let workflows: TestHarness["workflows"];

  const startHarness = async (
    overrides: Partial<PiFragmentConfig["agents"][string]> = {},
    options: Parameters<typeof buildHarness>[1] = {},
  ) => {
    const config: PiFragmentConfig = {
      agents: {
        default: {
          name: "default",
          systemPrompt: "You are helpful.",
          model: mockModel,
          streamFn: createStreamFn("assistant:init"),
          ...overrides,
        },
      },
      tools: {},
    };

    const harness = await buildHarness(config, {
      ...options,
      autoTickHooks: options.autoTickHooks ?? true,
    });
    callRoute = harness.fragments.pi.callRoute;
    cleanup = harness.test.cleanup;
    workflows = harness.workflows;
  };

  beforeEach(async () => {
    await startHarness();
  });

  afterEach(async () => {
    await cleanup();
  });

  const createSession = async () => {
    const response = await callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Command Session" },
    });
    expect(response.type).toBe("json");
    if (response.type !== "json") {
      throw new Error(`Expected json response, got ${response.type}`);
    }
    return response.data.id;
  };

  it("creates, lists, and returns initial command-waiting detail", async () => {
    const sessionId = await createSession();

    const list = await callRoute("GET", "/sessions", {});
    expect(list.type).toBe("json");
    if (list.type !== "json") {
      throw new Error(`Expected json response, got ${list.type}`);
    }
    expect(list.data.map((session) => session.id)).toContain(sessionId);

    const detail = await callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });
    expect(detail.type).toBe("json");
    if (detail.type !== "json") {
      throw new Error(`Expected json response, got ${detail.type}`);
    }
    expect(detail.data.phase).toBe("waiting-for-command");
    expect(detail.data.waitingFor).toMatchObject({
      type: "command",
      allowedCommands: ["prompt", "followUp", "complete"],
    });
    expect(detail.data.commandHistory).toEqual([]);
    expect(detail.data.turns).toEqual([]);
  });

  it("projects accepted but not yet consumed commands in session detail", async () => {
    await cleanup();
    await startHarness({}, { autoTickHooks: false });
    const sessionId = await createSession();

    const prompt = await callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId },
      body: { kind: "prompt", input: { text: "pending command" } },
    });
    expect(prompt.type).toBe("json");
    if (prompt.type !== "json") {
      throw new Error(`Expected json response, got ${prompt.type}`);
    }

    const detail = await callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });
    expect(detail.type).toBe("json");
    if (detail.type !== "json") {
      throw new Error(`Expected json response, got ${detail.type}`);
    }
    expect(detail.data.commandHistory).toContainEqual(
      expect.objectContaining({
        commandId: prompt.data.commandId,
        kind: "prompt",
        commandStatus: "accepted",
        consumedAt: null,
      }),
    );
  });

  it("accepts prompt commands and persists messages, trace, turns, and command history", async () => {
    const sessionId = await createSession();

    const prompt = await callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId },
      body: { kind: "prompt", input: { text: "hello command" } },
    });
    expect(prompt.type).toBe("json");
    if (prompt.type !== "json") {
      throw new Error(`Expected json response, got ${prompt.type}`);
    }
    expect(prompt.status).toBe(202);
    expect(prompt.data.accepted).toBe(true);
    expect(prompt.data.commandId).toBeTruthy();

    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    const detail = await callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });
    expect(detail.type).toBe("json");
    if (detail.type !== "json") {
      throw new Error(`Expected json response, got ${detail.type}`);
    }
    expect(detail.data.status).toBe("waiting");
    expect(detail.data.phase).toBe("waiting-for-command");
    expect(detail.data.turn).toBe(1);
    expect(userTextsFrom(detail.data.messages)).toContain("hello command");
    expect(assistantTextsFrom(detail.data.messages)).toContain("assistant:init");
    expect(detail.data.trace.length).toBeGreaterThan(0);
    expect(detail.data.turns).toHaveLength(1);
    expect(detail.data.turns[0]).toMatchObject({ status: "completed", turn: 0 });
    expect(detail.data.turns[0]?.operations[0]).toMatchObject({
      kind: "prompt",
      outcome: "completed",
      stepKey: "do:prompt-turn-0-op-0",
    });
    expect(detail.data.commandHistory).toHaveLength(1);
    expect(detail.data.commandHistory[0]).toMatchObject({
      commandId: prompt.data.commandId,
      kind: "prompt",
      commandStatus: "applied",
    });
  });

  it("keeps sessions open until an explicit complete command", async () => {
    const sessionId = await createSession();

    await callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId },
      body: { kind: "prompt", input: { text: "first turn" } },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    await callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId },
      body: { kind: "prompt", input: { text: "second turn" } },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    const complete = await callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId },
      body: { kind: "complete", reason: "done" },
    });
    expect(complete.type).toBe("json");
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    const detail = await callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });
    expect(detail.type).toBe("json");
    if (detail.type !== "json") {
      throw new Error(`Expected json response, got ${detail.type}`);
    }
    expect(detail.data.status).toBe("complete");
    expect(detail.data.phase).toBe("complete");
    expect(detail.data.waitingFor).toBeNull();
    expect(userTextsFrom(detail.data.messages)).toEqual(["first turn", "second turn"]);
    expect(detail.data.turns).toHaveLength(2);
    expect(detail.data.commandHistory.map((command) => command.kind)).toEqual([
      "prompt",
      "prompt",
      "complete",
    ]);
  });

  it("rejects commands that are not valid for the current durable turn state", async () => {
    const sessionId = await createSession();

    const invalidContinue = await callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId },
      body: { kind: "continue" },
    });
    expect(invalidContinue.type).toBe("json");
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    const detail = await callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });
    expect(detail.type).toBe("json");
    if (detail.type !== "json") {
      throw new Error(`Expected json response, got ${detail.type}`);
    }
    expect(detail.data.commandHistory).toHaveLength(1);
    expect(detail.data.commandHistory[0]).toMatchObject({
      kind: "continue",
      commandStatus: "rejected",
      rejectionReason: "Continue only applies after a recoverable agent error.",
    });
    expect(detail.data.messages).toEqual([]);
    expect(detail.data.turns).toHaveLength(1);
    expect(detail.data.turns[0]).toMatchObject({ status: "idle", operations: [] });
  });

  it("persists stable human-readable workflow step names for command operations", async () => {
    await cleanup();
    await startHarness({ streamFn: createFailingStreamFn({ failOnceForText: "retry me" }) });
    const sessionId = await createSession();

    await callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId },
      body: { kind: "prompt", input: { text: "retry me" } },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });
    await callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId },
      body: { kind: "continue" },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });
    await callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId },
      body: { kind: "complete", reason: "done" },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    const steps = await findWorkflowSteps(workflows.test.adapter);
    const stepNames = steps.map((step) => step.name);
    const stepKeys = steps.map((step) => step.stepKey);

    expect(stepNames).toEqual(
      expect.arrayContaining([
        "wait-command-turn-0-command-0",
        "prompt-turn-0-op-0",
        "wait-command-turn-0-command-1",
        "continue-turn-0-op-1",
        "wait-command-turn-1-command-2",
        "complete-session-command-2",
      ]),
    );
    expect(stepKeys).toEqual(
      expect.arrayContaining([
        "waitForEvent:wait-command-turn-0-command-0",
        "do:prompt-turn-0-op-0",
        "waitForEvent:wait-command-turn-0-command-1",
        "do:continue-turn-0-op-1",
        "waitForEvent:wait-command-turn-1-command-2",
        "do:complete-session-command-2",
      ]),
    );
  });

  it("continues a turn after a recoverable agent error", async () => {
    await cleanup();
    await startHarness({ streamFn: createFailingStreamFn({ failOnceForText: "retry me" }) });
    const sessionId = await createSession();

    await callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId },
      body: { kind: "prompt", input: { text: "retry me" } },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    let detail = await callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });
    expect(detail.type).toBe("json");
    if (detail.type !== "json") {
      throw new Error(`Expected json response, got ${detail.type}`);
    }
    expect(detail.data.phase).toBe("waiting-for-command");
    expect(detail.data.waitingFor).toMatchObject({
      type: "command",
      allowedCommands: ["continue", "abort"],
    });
    expect(detail.data.turns[0]).toMatchObject({ status: "waiting-to-continue" });

    await callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId },
      body: { kind: "continue" },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    detail = await callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });
    expect(detail.type).toBe("json");
    if (detail.type !== "json") {
      throw new Error(`Expected json response, got ${detail.type}`);
    }
    expect(detail.data.turn).toBe(1);
    expect(detail.data.turns[0]).toMatchObject({ status: "completed" });
    expect(detail.data.turns[0]?.operations.map((operation) => operation.kind)).toEqual([
      "prompt",
      "continue",
    ]);
    expect(assistantTextsFrom(detail.data.messages)).toContain("assistant:retry me");
  });

  it("aborts a retryable turn and advances to a new command turn", async () => {
    await cleanup();
    await startHarness({ streamFn: createFailingStreamFn({ failOnceForText: "abort me" }) });
    const sessionId = await createSession();

    await callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId },
      body: { kind: "prompt", input: { text: "abort me" } },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    await callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId },
      body: { kind: "abort", reason: "user stopped" },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    const detail = await callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });
    expect(detail.type).toBe("json");
    if (detail.type !== "json") {
      throw new Error(`Expected json response, got ${detail.type}`);
    }
    expect(detail.data.turn).toBe(1);
    expect(detail.data.turns[0]).toMatchObject({ status: "aborted" });
    expect(detail.data.turns[0]?.operations.at(-1)).toMatchObject({
      kind: "abort",
      outcome: "aborted",
      errorMessage: "user stopped",
    });
  });

  it("injects live-control command routes into the active in-memory controller", async () => {
    await cleanup();
    const liveState = createInitialPiAgentLoopState();
    const activeSession = ensurePiActiveSessionState(liveState);
    const injected: string[] = [];
    activeSession.registerLiveController({
      turn: 0,
      operation: "prompt",
      stepKey: "do:prompt-turn-0-op-0",
      abort: () => injected.push("abort"),
      steer: (input) => injected.push(`steer:${input.text}`),
      followUp: (input) => injected.push(`followUp:${input.text}`),
    });
    await startHarness(
      {},
      {
        autoTickHooks: false,
        wrapWorkflowsService: (service) => ({
          ...service,
          getLiveInstanceState: (() => ({
            workflowName: "agent-loop-workflow",
            instanceId: "session-live",
            runNumber: 0,
            status: "active",
            state: liveState,
            capturedAt: new Date(),
          })) as PiWorkflowsService["getLiveInstanceState"],
        }),
      },
    );
    const sessionId = await createSession();

    const abort = await callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId },
      body: { kind: "abort", reason: "stop" },
    });
    const steer = await callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId },
      body: { kind: "steer", input: { text: "nudge" } },
    });
    const followUp = await callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId },
      body: { kind: "followUp", input: { text: "next" } },
    });

    expect(abort.type).toBe("json");
    expect(steer.type).toBe("json");
    expect(followUp.type).toBe("json");
    expect(injected).toEqual(["abort", "steer:nudge", "followUp:next"]);
  });

  it("records unsupported live-only commands as rejected when no operation is running", async () => {
    const sessionId = await createSession();

    await callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId },
      body: { kind: "steer", input: { text: "nudge" } },
    });
    await callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId },
      body: { kind: "followUp", input: { text: "extra" } },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    const detail = await callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });
    expect(detail.type).toBe("json");
    if (detail.type !== "json") {
      throw new Error(`Expected json response, got ${detail.type}`);
    }
    expect(
      detail.data.commandHistory.map((command) => [command.kind, command.commandStatus]),
    ).toEqual(
      expect.arrayContaining([
        ["steer", "rejected"],
        ["followUp", "applied"],
      ]),
    );
    expect(userTextsFrom(detail.data.messages)).toContain("extra");
  });

  it("streams active-session snapshot, replayed agent events, and settled frames", async () => {
    const liveStateStore = createWorkflowLiveStateStore();
    await cleanup();
    const config: PiFragmentConfig = {
      agents: {
        default: {
          name: "default",
          systemPrompt: "You are helpful.",
          model: mockModel,
          streamFn: createDelayedStreamFn(10),
        },
      },
      tools: {},
    };
    const harness = await buildHarness(config, { autoTickHooks: true, liveStateStore });
    callRoute = harness.fragments.pi.callRoute;
    cleanup = harness.test.cleanup;
    workflows = harness.workflows;
    const sessionId = await createSession();

    const streamResponsePromise = callRoute("GET", "/sessions/:sessionId/active", {
      pathParams: { sessionId },
    });
    await callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId },
      body: { kind: "prompt", input: { text: "stream me" } },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    const streamResponse = await streamResponsePromise;
    expect(streamResponse.type).toBe("jsonStream");
    if (streamResponse.type !== "jsonStream") {
      throw new Error(`Expected jsonStream response, got ${streamResponse.type}`);
    }
    const streamMessages: PiActiveSessionProtocolMessage[] = [];
    for await (const message of streamResponse.stream) {
      streamMessages.push(message);
    }
    expect(streamMessages[0]).toMatchObject({ layer: "system", type: "snapshot" });
    expect(
      streamMessages.some((message) => message.layer === "pi" && message.type === "event"),
    ).toBe(true);
    expect(
      streamMessages.some((message) => message.layer === "system" && message.type === "settled"),
    ).toBe(true);
  });

  it("returns route errors for missing sessions and validates command input", async () => {
    const missing = await callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId: "missing" },
      body: { kind: "prompt", input: { text: "hello" } },
    });
    expect(missing.type).toBe("error");
    if (missing.type !== "error") {
      throw new Error(`Expected error response, got ${missing.type}`);
    }
    expect(missing.error.code).toBe("SESSION_NOT_FOUND");

    const sessionId = await createSession();
    const invalid = await callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId },
      body: {} as never,
    });
    expect(invalid.type).toBe("error");
  });

  it("does not expose the removed legacy messages route", async () => {
    const sessionId = await createSession();
    type LegacyRouteResponse =
      | { type: "error"; error: { code: string } }
      | { type: "json" | "jsonStream" | "html" | "redirect" };
    type LegacyRouteCaller = (
      method: "POST",
      route: "/sessions/:sessionId/messages",
      request: { pathParams: { sessionId: string }; body: { text: string } },
    ) => Promise<LegacyRouteResponse>;

    const callLegacyRoute = callRoute as unknown as LegacyRouteCaller;
    const response = await callLegacyRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId },
      body: { text: "legacy" },
    });
    expect(response.type).toBe("error");
    if (response.type !== "error") {
      throw new Error(`Expected error response, got ${response.type}`);
    }
    expect(response.error.code).toBe("ROUTE_NOT_FOUND");
  });
});
