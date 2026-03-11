import { afterEach, describe, expect, it, vi } from "vitest";
import { drainDurableHooks } from "@fragno-dev/test";
import { createWorkflowLiveStateStore } from "@fragno-dev/workflows";
import type { AssistantMessage } from "@mariozechner/pi-ai";

import {
  buildHarness,
  createFailingStreamFn,
  createStreamFn,
  createStreamFnScript,
  mockModel,
} from "./test-utils";
import type { PiFragmentConfig, PiToolFactory, PiWorkflowsService } from "./types";
import { PI_WORKFLOW_NAME } from "./workflow";

type TestHarness = Awaited<ReturnType<typeof buildHarness>>;

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const jsonSchemaParameters = {
  type: "object",
  properties: {
    command: { type: "string" },
  },
  required: ["command"],
  additionalProperties: true,
} as const;

const buildAssistantMessage = (options: {
  content: AssistantMessage["content"];
  stopReason: AssistantMessage["stopReason"];
}): AssistantMessage => ({
  role: "assistant",
  content: options.content,
  api: "openai-responses",
  provider: "openai",
  model: "test-model",
  usage,
  stopReason: options.stopReason,
  timestamp: Date.now(),
});

const extractLastUserText = (messages: unknown[]): string => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || typeof message !== "object" || (message as { role?: string }).role !== "user") {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    const textBlock = content.find((block) => {
      if (!block || typeof block !== "object") {
        return false;
      }
      return (block as { type?: string }).type === "text";
    }) as { text?: string } | undefined;
    if (typeof textBlock?.text === "string") {
      return textBlock.text;
    }
  }
  return "";
};

const isToolResultMessage = (value: unknown) =>
  value && typeof value === "object" && (value as { role?: string }).role === "toolResult";

const createToolLoopStreamFn = (): PiFragmentConfig["agents"]["default"]["streamFn"] => {
  return (model, input, ctx) => {
    const lastMessage = input.messages[input.messages.length - 1];
    const userText = extractLastUserText(input.messages as unknown[]);

    if (isToolResultMessage(lastMessage)) {
      const response = buildAssistantMessage({
        content: [{ type: "text", text: `assistant:${userText}:done` }],
        stopReason: "stop",
      });
      return createStreamFnScript(
        [
          { type: "start", partial: response },
          { type: "done", reason: "stop", message: response },
        ],
        { result: response },
      )(model, input, ctx as never);
    }

    const response = buildAssistantMessage({
      content: [
        {
          type: "toolCall" as const,
          id: `call-${userText || "default"}`,
          name: "counter",
          arguments: { command: userText },
        },
      ],
      stopReason: "toolUse",
    });

    return createStreamFnScript(
      [
        { type: "start", partial: response },
        { type: "done", reason: "toolUse", message: response },
      ],
      { result: response },
    )(model, input, ctx as never);
  };
};

const createCounterTool = (): PiToolFactory => async () => ({
  name: "counter",
  label: "Counter",
  description: "Counts tool executions",
  parameters: jsonSchemaParameters as never,
  execute: async (_toolCallId, params) => {
    const command =
      params &&
      typeof params === "object" &&
      typeof (params as { command?: unknown }).command === "string"
        ? ((params as { command: string }).command ?? "")
        : "";
    return {
      content: [{ type: "text", text: `tool:${command}` }],
      details: { command },
    };
  },
});

const createConfig = (
  options: {
    streamFn?: PiFragmentConfig["agents"]["default"]["streamFn"];
    tools?: PiFragmentConfig["tools"];
    agentTools?: string[];
  } = {},
): PiFragmentConfig => ({
  agents: {
    default: {
      name: "default",
      systemPrompt: "You are helpful.",
      model: mockModel,
      streamFn: options.streamFn ?? createStreamFn("assistant:detail"),
      tools: options.agentTools,
    },
  },
  tools: options.tools ?? {},
});

const formatResponseError = (response: {
  type: string;
  error?: { code?: string; message?: string } | null;
}) => {
  const routeError = response.type === "error" ? response.error : undefined;
  return `Expected json response, got ${response.type}${
    routeError ? ` (${routeError.code ?? "UNKNOWN"}: ${routeError.message ?? "Unknown error"})` : ""
  }`;
};

type BuildHarnessOptions = NonNullable<Parameters<typeof buildHarness>[1]>;
type WorkflowsServiceWrapper = NonNullable<BuildHarnessOptions["wrapWorkflowsService"]>;

const wrapWorkflowsServiceWithSpies = (
  restoreInstanceStateSpy: ReturnType<typeof vi.fn>,
  getInstanceStatusSpy?: ReturnType<typeof vi.fn>,
): WorkflowsServiceWrapper => {
  const wrapper: WorkflowsServiceWrapper = (service) =>
    new Proxy(service, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        const bound = typeof value === "function" ? value.bind(target) : value;
        if (prop === "restoreInstanceState" && typeof bound === "function") {
          return (...args: Parameters<PiWorkflowsService["restoreInstanceState"]>) => {
            restoreInstanceStateSpy(...args);
            return bound(...args);
          };
        }
        if (prop === "getInstanceStatus" && typeof bound === "function") {
          return (...args: Parameters<PiWorkflowsService["getInstanceStatus"]>) => {
            getInstanceStatusSpy?.(...args);
            return bound(...args);
          };
        }
        return bound;
      },
    }) as PiWorkflowsService;

  return wrapper;
};

describe("pi-fragment session detail route", () => {
  const cleanups: Array<() => Promise<void>> = [];

  const createHarness = async (
    config: PiFragmentConfig,
    options: Parameters<typeof buildHarness>[1] = {},
  ): Promise<TestHarness> => {
    const harness = await buildHarness(config, { autoTickHooks: true, ...options });
    cleanups.push(harness.test.cleanup);
    return harness;
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) {
        await cleanup();
      }
    }
  });

  it("returns SESSION_NOT_FOUND when session does not exist", async () => {
    const { fragments } = await createHarness(createConfig());

    const response = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId: "missing-session" },
    });

    expect(response.type).toBe("error");
    if (response.type !== "error") {
      throw new Error(`Expected error response, got ${response.type}`);
    }
    expect(response.error.code).toBe("SESSION_NOT_FOUND");
  });

  it("returns SESSION_NOT_FOUND when workflow instance is null", async () => {
    const { fragments } = await createHarness(createConfig());

    const sessionId = await fragments.pi.db.create("session", {
      name: "Missing workflow",
      agent: "default",
      status: "active",
      workflowInstanceId: null,
      steeringMode: "one-at-a-time",
      metadata: null,
      tags: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId: sessionId.valueOf() },
    });

    expect(response.type).toBe("error");
    if (response.type !== "error") {
      throw new Error(`Expected error response, got ${response.type}`);
    }
    expect(response.error.code).toBe("SESSION_NOT_FOUND");
  });

  it("restores the initial current-run waiting state without history calls", async () => {
    const listHistorySpy = vi.fn();
    const getInstanceRunNumberSpy = vi.fn();
    const { fragments } = await createHarness(createConfig(), {
      wrapWorkflowsService: (service) =>
        new Proxy(service, {
          get(target, prop, receiver) {
            if (prop === "listHistory") {
              return listHistorySpy;
            }
            if (prop === "getInstanceRunNumber") {
              return getInstanceRunNumberSpy;
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as unknown as PiWorkflowsService,
    });

    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Restored waiting state" },
    });

    if (createResponse.type !== "json") {
      throw new Error(formatResponseError(createResponse));
    }

    const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId: createResponse.data.id },
    });

    expect(detailResponse.type).toBe("json");
    if (detailResponse.type !== "json") {
      throw new Error(formatResponseError(detailResponse));
    }

    expect(detailResponse.data.messages).toEqual([]);
    expect(detailResponse.data.events).toEqual([]);
    expect(detailResponse.data.trace).toEqual([]);
    expect(detailResponse.data.summaries).toEqual([]);
    expect(detailResponse.data.turn).toBe(0);
    expect(detailResponse.data.phase).toBe("waiting-for-user");
    expect(detailResponse.data.waitingFor).toMatchObject({
      type: "user_message",
      turn: 0,
      stepKey: "waitForEvent:wait-user-0",
      timeoutMs: 3_600_000,
    });
    expect(listHistorySpy).not.toHaveBeenCalled();
    expect(getInstanceRunNumberSpy).not.toHaveBeenCalled();
  });

  it("returns current-run detail from restored workflow state", async () => {
    const { fragments, workflows } = await createHarness(createConfig());

    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Restored detail" },
    });

    if (createResponse.type !== "json") {
      throw new Error(formatResponseError(createResponse));
    }

    await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId: createResponse.data.id },
      body: { text: "ping", done: true },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId: createResponse.data.id },
    });

    expect(detailResponse.type).toBe("json");
    if (detailResponse.type !== "json") {
      throw new Error(formatResponseError(detailResponse));
    }

    expect(detailResponse.data.status).toBe("complete");
    expect(detailResponse.data.messages.length).toBeGreaterThan(0);
    expect(detailResponse.data.events).toHaveLength(1);
    expect(detailResponse.data.trace.length).toBeGreaterThan(0);
    expect(detailResponse.data.summaries).toHaveLength(1);
    expect(detailResponse.data.summaries[0]?.summary ?? "").toContain("assistant");
    expect(detailResponse.data.phase).toBe("complete");
    expect(detailResponse.data.waitingFor).toBeNull();
  });

  it("prefers live session snapshots over workflow restore on cache hits", async () => {
    const liveStateStore = createWorkflowLiveStateStore();
    const restoreInstanceStateSpy = vi.fn();
    const getInstanceStatusSpy = vi.fn();
    const { fragments, workflows } = await createHarness(createConfig(), {
      liveStateStore,
      wrapWorkflowsService: wrapWorkflowsServiceWithSpies(
        restoreInstanceStateSpy,
        getInstanceStatusSpy,
      ),
    });

    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Live detail" },
    });

    if (createResponse.type !== "json") {
      throw new Error(formatResponseError(createResponse));
    }

    await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId: createResponse.data.id },
      body: { text: "ping", done: true },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    expect(
      await liveStateStore.get(createResponse.data.id, {
        workflowName: PI_WORKFLOW_NAME,
      }),
    ).not.toBeNull();

    restoreInstanceStateSpy.mockClear();
    getInstanceStatusSpy.mockClear();

    const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId: createResponse.data.id },
    });

    expect(detailResponse.type).toBe("json");
    if (detailResponse.type !== "json") {
      throw new Error(formatResponseError(detailResponse));
    }

    expect(restoreInstanceStateSpy).not.toHaveBeenCalled();
    expect(getInstanceStatusSpy).toHaveBeenCalledTimes(1);
    expect(detailResponse.data.status).toBe("complete");
    expect(detailResponse.data.phase).toBe("complete");
    expect(detailResponse.data.waitingFor).toBeNull();
  });

  it("falls back to restore when the live session snapshot cache is cleared", async () => {
    const liveStateStore = createWorkflowLiveStateStore();
    const restoreInstanceStateSpy = vi.fn();
    const { fragments, workflows } = await createHarness(createConfig(), {
      liveStateStore,
      wrapWorkflowsService: wrapWorkflowsServiceWithSpies(restoreInstanceStateSpy),
    });

    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Cleared live detail" },
    });

    if (createResponse.type !== "json") {
      throw new Error(formatResponseError(createResponse));
    }

    await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId: createResponse.data.id },
      body: { text: "ping", done: true },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });
    liveStateStore.clear();

    restoreInstanceStateSpy.mockClear();

    const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId: createResponse.data.id },
    });

    expect(detailResponse.type).toBe("json");
    if (detailResponse.type !== "json") {
      throw new Error(formatResponseError(detailResponse));
    }

    expect(restoreInstanceStateSpy).toHaveBeenCalledTimes(1);
    expect(detailResponse.data.phase).toBe("complete");
  });

  it("falls back to restore when the live session snapshot is stale", async () => {
    const liveStateStore = createWorkflowLiveStateStore();
    const restoreInstanceStateSpy = vi.fn();
    const { fragments, workflows } = await createHarness(createConfig(), {
      liveStateStore,
      wrapWorkflowsService: wrapWorkflowsServiceWithSpies(restoreInstanceStateSpy),
    });

    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Stale live detail" },
    });

    if (createResponse.type !== "json") {
      throw new Error(formatResponseError(createResponse));
    }

    await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId: createResponse.data.id },
      body: { text: "ping", done: true },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    const liveSnapshot = await liveStateStore.get(createResponse.data.id, {
      workflowName: PI_WORKFLOW_NAME,
    });
    if (!liveSnapshot) {
      throw new Error("Expected a live session snapshot");
    }

    liveStateStore.set({
      ...liveSnapshot,
      workflowName: "stale-workflow",
    });

    restoreInstanceStateSpy.mockClear();

    const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId: createResponse.data.id },
    });

    expect(detailResponse.type).toBe("json");
    if (detailResponse.type !== "json") {
      throw new Error(formatResponseError(detailResponse));
    }

    expect(restoreInstanceStateSpy).toHaveBeenCalledTimes(1);
    expect(
      await liveStateStore.get(createResponse.data.id, {
        workflowName: PI_WORKFLOW_NAME,
      }),
    ).not.toBeNull();
  });

  it("keeps the latest user message when the assistant is waiting to retry", async () => {
    const { fragments, workflows } = await createHarness(
      createConfig({
        streamFn: createFailingStreamFn({ failOnceForText: "retry-me" }),
      }),
    );

    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Retry waiting state" },
    });

    if (createResponse.type !== "json") {
      throw new Error(formatResponseError(createResponse));
    }

    await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId: createResponse.data.id },
      body: { text: "retry-me", done: true },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId: createResponse.data.id },
    });

    expect(detailResponse.type).toBe("json");
    if (detailResponse.type !== "json") {
      throw new Error(formatResponseError(detailResponse));
    }

    expect(detailResponse.data.status).toBe("waiting");
    expect(detailResponse.data.phase).toBe("running-agent");
    expect(detailResponse.data.waitingFor).toMatchObject({
      type: "assistant",
      turn: 0,
      stepKey: "do:assistant-0",
    });
    expect(detailResponse.data.events).toHaveLength(1);
    expect(detailResponse.data.trace).toEqual([]);
    expect(detailResponse.data.summaries).toEqual([]);

    const latestMessage = detailResponse.data.messages[detailResponse.data.messages.length - 1];
    expect(latestMessage?.role).toBe("user");
    expect(latestMessage?.content).toEqual([{ type: "text", text: "retry-me" }]);
  });

  it("restores multi-turn summaries from current-run state", async () => {
    const { fragments, workflows } = await createHarness(createConfig());

    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Multi turn restored" },
    });

    if (createResponse.type !== "json") {
      throw new Error(formatResponseError(createResponse));
    }

    await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId: createResponse.data.id },
      body: { text: "first turn", done: false },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId: createResponse.data.id },
      body: { text: "second turn", done: true },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId: createResponse.data.id },
    });

    expect(detailResponse.type).toBe("json");
    if (detailResponse.type !== "json") {
      throw new Error(formatResponseError(detailResponse));
    }

    const userTexts = detailResponse.data.messages.flatMap((message) => {
      if (!message || typeof message !== "object" || message.role !== "user") {
        return [];
      }
      const content = "content" in message ? message.content : null;
      if (!Array.isArray(content)) {
        return [];
      }
      return content.flatMap((block) => {
        if (!block || typeof block !== "object" || block.type !== "text") {
          return [];
        }
        return typeof block.text === "string" ? [block.text] : [];
      });
    });

    expect(userTexts).toContain("first turn");
    expect(userTexts).toContain("second turn");
    expect(detailResponse.data.events).toHaveLength(2);
    expect(detailResponse.data.summaries).toHaveLength(2);
    expect(detailResponse.data.summaries[0]?.turn).toBe(0);
    expect(detailResponse.data.summaries[1]?.turn).toBe(1);
    expect(detailResponse.data.turn).toBe(1);
    expect(detailResponse.data.phase).toBe("complete");
    expect(detailResponse.data.waitingFor).toBeNull();
  });

  it("restores tool-use sessions from current-run state", async () => {
    const { fragments, workflows } = await createHarness(
      createConfig({
        streamFn: createToolLoopStreamFn(),
        tools: { counter: createCounterTool() },
        agentTools: ["counter"],
      }),
    );

    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Tool use restored" },
    });

    if (createResponse.type !== "json") {
      throw new Error(formatResponseError(createResponse));
    }

    await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId: createResponse.data.id },
      body: { text: "alpha", done: true },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId: createResponse.data.id },
    });

    expect(detailResponse.type).toBe("json");
    if (detailResponse.type !== "json") {
      throw new Error(formatResponseError(detailResponse));
    }

    expect(
      detailResponse.data.messages.some(
        (message) => message && typeof message === "object" && message.role === "toolResult",
      ),
    ).toBe(true);
    expect(detailResponse.data.trace.length).toBeGreaterThan(0);
    expect(detailResponse.data.summaries[0]?.summary).toContain("assistant:alpha:done");
  });

  it("supports include flags for events, trace, and summaries", async () => {
    const { fragments, workflows } = await createHarness(createConfig());

    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Selective detail" },
    });

    if (createResponse.type !== "json") {
      throw new Error(formatResponseError(createResponse));
    }

    await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId: createResponse.data.id },
      body: { text: "ping", done: true },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId: createResponse.data.id },
      query: { events: "false", trace: "false", summaries: "false" },
    });

    expect(detailResponse.type).toBe("json");
    if (detailResponse.type !== "json") {
      throw new Error(formatResponseError(detailResponse));
    }

    expect(detailResponse.data.messages.length).toBeGreaterThan(0);
    expect(detailResponse.data.events).toEqual([]);
    expect(detailResponse.data.trace).toEqual([]);
    expect(detailResponse.data.summaries).toEqual([]);
    expect(detailResponse.data.phase).toBe("complete");
  });

  it("does not mutate session timestamps when reading detail", async () => {
    const { fragments, workflows } = await createHarness(createConfig());

    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Timestamp stability" },
    });

    if (createResponse.type !== "json") {
      throw new Error(formatResponseError(createResponse));
    }

    await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId: createResponse.data.id },
      body: { text: "ping", done: true },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    const beforeRows = await fragments.pi.db.find("session");
    const beforeRow = beforeRows.find(
      (row: unknown) => String((row as { id?: unknown }).id ?? "") === createResponse.data.id,
    ) as { updatedAt: Date } | undefined;
    if (!beforeRow) {
      throw new Error("Expected session row before detail read");
    }

    const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId: createResponse.data.id },
    });

    expect(detailResponse.type).toBe("json");
    if (detailResponse.type !== "json") {
      throw new Error(formatResponseError(detailResponse));
    }

    const afterRows = await fragments.pi.db.find("session");
    const afterRow = afterRows.find(
      (row: unknown) => String((row as { id?: unknown }).id ?? "") === createResponse.data.id,
    ) as { updatedAt: Date } | undefined;
    if (!afterRow) {
      throw new Error("Expected session row after detail read");
    }

    expect(afterRow.updatedAt.getTime()).toBe(beforeRow.updatedAt.getTime());
  });

  it("returns an error when workflow status is invalid", async () => {
    const { fragments, workflows } = await createHarness(createConfig());

    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Unknown status" },
    });

    if (createResponse.type !== "json") {
      throw new Error(formatResponseError(createResponse));
    }

    const workflowInstanceId = createResponse.data.workflowInstanceId;
    if (!workflowInstanceId) {
      throw new Error("Expected workflow instance id");
    }

    const instances = await workflows.db.find("workflow_instance");
    const instanceRow = instances.find(
      (row: unknown) =>
        String((row as { id?: unknown }).id) === workflowInstanceId &&
        (row as { workflowName?: string }).workflowName === "agent-loop-workflow",
    ) as { id?: string } | undefined;
    if (!instanceRow?.id) {
      throw new Error("Expected workflow instance to exist");
    }

    await workflows.db.update("workflow_instance", instanceRow.id, (b) =>
      b.set({ status: "not-a-status" }),
    );

    const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId: createResponse.data.id },
    });

    expect(detailResponse.type).toBe("error");
    if (detailResponse.type !== "error") {
      throw new Error(formatResponseError(detailResponse));
    }
    expect(detailResponse.error.code).toBe("WORKFLOW_INSTANCE_MISSING");
  });
});
