import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainDurableHooks } from "@fragno-dev/test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";

import { buildHarness, createStreamFn, mockModel } from "./test-utils";
import type { PiFragmentConfig } from "./types";
import { PI_WORKFLOW_NAME } from "./workflow";
import { PiLogger } from "../debug-log";

type TestHarness = Awaited<ReturnType<typeof buildHarness>>;
const ASSISTANT_STEP_PREFIX = "assistant-";
const USER_STEP_PREFIX = "user-";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const buildAssistantMessage = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-responses",
  provider: "openai",
  model: "test-model",
  usage,
  stopReason: "stop",
  timestamp: 123,
});

const buildUserMessage = (text: string, timestamp: number): AgentMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
});

const formatResponseError = (response: {
  type: string;
  error?: { code?: string; message?: string } | null;
}) => {
  const error = response.type === "error" ? response.error : undefined;
  return `Expected json response, got ${response.type}${
    error ? ` (${error.code ?? "UNKNOWN"}: ${error.message ?? "Unknown error"})` : ""
  }`;
};

describe("pi-fragment session detail route", () => {
  const workflowName = PI_WORKFLOW_NAME;

  let fragments: TestHarness["fragments"];
  let test: TestHarness["test"];
  let workflows: TestHarness["workflows"];
  let streamFn: ReturnType<typeof createStreamFn>;

  beforeEach(async () => {
    streamFn = createStreamFn("assistant:detail");
    const config: PiFragmentConfig = {
      agents: {
        default: {
          name: "default",
          systemPrompt: "You are helpful.",
          model: mockModel,
          streamFn,
        },
      },
      tools: {},
    };

    const result = await buildHarness(config, { autoTickHooks: true });
    fragments = result.fragments;
    test = result.test;
    workflows = result.workflows;
  });

  afterEach(async () => {
    await test.cleanup();
  });

  it("returns SESSION_NOT_FOUND when session does not exist", async () => {
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

  it("derives messages, trace, and summaries from workflow history", async () => {
    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Detail history" },
    });

    if (createResponse.type !== "json") {
      throw new Error(formatResponseError(createResponse));
    }

    const sessionId = createResponse.data.id;
    const workflowInstanceId = createResponse.data.workflowInstanceId;
    if (!workflowInstanceId) {
      throw new Error("Expected workflow instance id");
    }

    await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId },
      body: { text: "ping", done: true },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });

    expect(detailResponse.type).toBe("json");
    if (detailResponse.type !== "json") {
      throw new Error(formatResponseError(detailResponse));
    }

    expect(detailResponse.data.messages.length).toBeGreaterThan(0);
    expect(detailResponse.data.events.length).toBeGreaterThan(0);
    expect(detailResponse.data.trace.length).toBeGreaterThan(0);
    expect(detailResponse.data.summaries.length).toBeGreaterThan(0);
    expect(detailResponse.data.summaries[0]?.summary ?? "").toContain("assistant");
  });

  it("prefers newer messages over older assistant snapshots", async () => {
    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Prefer newer messages" },
    });

    if (createResponse.type !== "json") {
      throw new Error(formatResponseError(createResponse));
    }

    const sessionId = createResponse.data.id;
    const workflowInstanceId = createResponse.data.workflowInstanceId;
    if (!workflowInstanceId) {
      throw new Error("Expected workflow instance id");
    }

    await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId },
      body: { text: "seed", done: true },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    const stepRows = await workflows.db.find("workflow_step");
    // Workflow message steps are named with `assistant-<turn>` and `user-<turn>` prefixes.
    const messageSteps = stepRows.filter((step) => {
      const result = (step as { result?: unknown }).result;
      if (!result || typeof result !== "object") {
        return false;
      }
      return Array.isArray((result as { messages?: unknown }).messages);
    });
    const assistantStep = messageSteps.find((step) =>
      String((step as { name?: unknown }).name ?? "").includes(ASSISTANT_STEP_PREFIX),
    );
    const userStep = messageSteps.find((step) => {
      const stepName = String((step as { name?: unknown }).name ?? "");
      if (stepName.includes(ASSISTANT_STEP_PREFIX)) {
        return false;
      }
      return stepName.includes(USER_STEP_PREFIX);
    });
    if (!assistantStep || !userStep) {
      const stepNames = stepRows
        .map((step) => String((step as { name?: unknown }).name ?? ""))
        .join(", ");
      throw new Error(`Expected assistant and non-assistant message steps (found: ${stepNames})`);
    }

    const oldUser = buildUserMessage("older-user", 1000);
    const oldAssistant = buildAssistantMessage("assistant:old");
    const newerUser = buildUserMessage("newer-user", 2000);
    const olderCreatedAt = new Date("2025-01-01T00:00:00.000Z");
    const newerCreatedAt = new Date("2025-01-01T00:00:01.000Z");

    await workflows.db.update("workflow_step", assistantStep.id, (b) =>
      b.set({
        result: {
          messages: [oldUser, oldAssistant],
          assistant: oldAssistant,
        },
        createdAt: olderCreatedAt,
        updatedAt: olderCreatedAt,
      }),
    );

    await workflows.db.update("workflow_step", userStep.id, (b) =>
      b.set({
        result: {
          messages: [oldUser, oldAssistant, newerUser],
        },
        createdAt: newerCreatedAt,
        updatedAt: newerCreatedAt,
      }),
    );

    const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });

    expect(detailResponse.type).toBe("json");
    if (detailResponse.type !== "json") {
      throw new Error(formatResponseError(detailResponse));
    }

    expect(detailResponse.data.messages).toEqual([oldUser, oldAssistant, newerUser]);
  });

  it("logs when falling back to non-assistant message snapshots", async () => {
    const debugSpy = vi.spyOn(PiLogger, "debug").mockImplementation(() => {});

    try {
      const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
        body: { agent: "default", name: "Fallback logging" },
      });

      if (createResponse.type !== "json") {
        throw new Error(formatResponseError(createResponse));
      }

      const sessionId = createResponse.data.id;
      const workflowInstanceId = createResponse.data.workflowInstanceId;
      if (!workflowInstanceId) {
        throw new Error("Expected workflow instance id");
      }

      await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
        pathParams: { sessionId },
        body: { text: "seed", done: true },
      });
      await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

      const stepRows = await workflows.db.find("workflow_step");
      const assistantStep = stepRows.find((step) =>
        String((step as { name?: unknown }).name ?? "").includes(ASSISTANT_STEP_PREFIX),
      );
      if (!assistantStep) {
        throw new Error("Expected assistant step");
      }

      const assistantOnly = buildAssistantMessage("assistant-only");
      await workflows.db.update("workflow_step", assistantStep.id, (b) =>
        b.set({
          result: {
            assistant: assistantOnly,
          },
        }),
      );

      const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
        pathParams: { sessionId },
      });

      expect(detailResponse.type).toBe("json");
      if (detailResponse.type !== "json") {
        throw new Error(formatResponseError(detailResponse));
      }

      const fallbackCall = debugSpy.mock.calls.find(
        ([message]) => message === "no assistant messages yet; using latest non-assistant messages",
      );
      expect(fallbackCall).toBeDefined();
      expect(fallbackCall?.[1]).toMatchObject({
        lastAssistantStepName: null,
        sortedSteps: expect.any(Number),
      });
    } finally {
      debugSpy.mockRestore();
    }
  });

  it("uses workflow output messages when history is empty", async () => {
    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Output fallback" },
    });

    if (createResponse.type !== "json") {
      throw new Error(formatResponseError(createResponse));
    }

    const sessionId = createResponse.data.id;
    const workflowInstanceId = createResponse.data.workflowInstanceId;
    if (!workflowInstanceId) {
      throw new Error("Expected workflow instance id");
    }

    const outputMessage = buildAssistantMessage("assistant:output");
    const instances = await workflows.db.find("workflow_instance");
    const instanceRow = instances.find(
      (row: unknown) =>
        String((row as { id?: unknown }).id) === workflowInstanceId &&
        (row as { workflowName?: string }).workflowName === workflowName,
    ) as { id?: string } | undefined;
    if (!instanceRow?.id) {
      throw new Error("Expected workflow instance to exist");
    }
    await workflows.db.update("workflow_instance", instanceRow.id, (b) =>
      b.set({ output: { messages: [outputMessage] } }),
    );

    const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });

    expect(detailResponse.type).toBe("json");
    if (detailResponse.type !== "json") {
      throw new Error(formatResponseError(detailResponse));
    }

    expect(detailResponse.data.messages).toEqual([outputMessage]);
  });

  it("aggregates workflow history across multiple turns", async () => {
    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Paged history" },
    });

    if (createResponse.type !== "json") {
      throw new Error(formatResponseError(createResponse));
    }

    const sessionId = createResponse.data.id;
    const workflowInstanceId = createResponse.data.workflowInstanceId;
    if (!workflowInstanceId) {
      throw new Error("Expected workflow instance id");
    }
    await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId },
      body: { text: "ping", done: false },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });
    await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId },
      body: { text: "pong", done: true },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });

    expect(detailResponse.type).toBe("json");
    if (detailResponse.type !== "json") {
      throw new Error(formatResponseError(detailResponse));
    }

    expect(detailResponse.data.summaries).toHaveLength(2);
    expect(detailResponse.data.summaries[0]?.turn).toBe(0);
    expect(detailResponse.data.summaries[1]?.turn).toBe(1);
    expect(detailResponse.data.messages.length).toBeGreaterThan(0);
    expect(detailResponse.data.events.length).toBeGreaterThan(0);
    expect(detailResponse.data.trace.length).toBeGreaterThan(0);
  });

  it("includes the latest user message when assistant response is still pending", async () => {
    const workflowInstanceId = "detail-pending-user";
    const sessionId = "detail-pending-user";
    const now = new Date();
    const firstStepAt = new Date(now.getTime() - 2_000);
    const secondStepAt = new Date(now.getTime() - 1_000);

    const userMessageFirst: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: "first-turn" }],
      timestamp: firstStepAt.getTime(),
    };
    const assistantMessageFirst = buildAssistantMessage("assistant:first-turn");
    const userMessageSecond: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: "second-turn" }],
      timestamp: secondStepAt.getTime(),
    };

    const instanceRef = await workflows.db.create("workflow_instance", {
      id: workflowInstanceId,
      workflowName,
      status: "active",
      params: {},
      runNumber: 0,
      startedAt: firstStepAt,
      completedAt: null,
      output: null,
      errorName: null,
      errorMessage: null,
      createdAt: firstStepAt,
      updatedAt: secondStepAt,
    });

    await fragments.pi.db.create("session", {
      id: sessionId,
      name: "Pending assistant session",
      agent: "default",
      status: "active",
      workflowInstanceId,
      steeringMode: "one-at-a-time",
      metadata: null,
      tags: null,
      createdAt: firstStepAt,
      updatedAt: secondStepAt,
    });

    await workflows.db.create("workflow_step", {
      instanceRef,
      runNumber: 0,
      stepKey: "do:assistant-0",
      name: "assistant-0",
      type: "do",
      status: "completed",
      attempts: 1,
      maxAttempts: 1,
      timeoutMs: null,
      nextRetryAt: null,
      wakeAt: null,
      waitEventType: null,
      result: {
        messages: [userMessageFirst, assistantMessageFirst],
        assistant: assistantMessageFirst,
      },
      errorName: null,
      errorMessage: null,
      createdAt: firstStepAt,
      updatedAt: firstStepAt,
    });

    await workflows.db.create("workflow_step", {
      instanceRef,
      runNumber: 0,
      stepKey: "do:user-1",
      name: "user-1",
      type: "do",
      status: "completed",
      attempts: 1,
      maxAttempts: 1,
      timeoutMs: null,
      nextRetryAt: null,
      wakeAt: null,
      waitEventType: null,
      result: {
        messages: [userMessageFirst, assistantMessageFirst, userMessageSecond],
        user: userMessageSecond,
      },
      errorName: null,
      errorMessage: null,
      createdAt: secondStepAt,
      updatedAt: secondStepAt,
    });

    const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });

    expect(detailResponse.type).toBe("json");
    if (detailResponse.type !== "json") {
      throw new Error(formatResponseError(detailResponse));
    }

    const latestMessage = detailResponse.data.messages[detailResponse.data.messages.length - 1];
    expect(latestMessage?.role).toBe("user");
    expect(latestMessage?.content).toEqual([{ type: "text", text: "second-turn" }]);
  });

  it("supports include flags for events/trace/summaries query params", async () => {
    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Selective detail" },
    });

    if (createResponse.type !== "json") {
      throw new Error(formatResponseError(createResponse));
    }

    const sessionId = createResponse.data.id;
    const workflowInstanceId = createResponse.data.workflowInstanceId;
    if (!workflowInstanceId) {
      throw new Error("Expected workflow instance id");
    }

    await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId },
      body: { text: "ping", done: true },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
      query: { events: "true", trace: "false", summaries: "false" },
    });

    expect(detailResponse.type).toBe("json");
    if (detailResponse.type !== "json") {
      throw new Error(formatResponseError(detailResponse));
    }

    expect(detailResponse.data.messages.length).toBeGreaterThan(0);
    expect(detailResponse.data.events.length).toBeGreaterThan(0);
    expect(detailResponse.data.trace).toEqual([]);
    expect(detailResponse.data.summaries).toEqual([]);
  });

  it("returns an error when workflow status is invalid", async () => {
    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Unknown status" },
    });

    if (createResponse.type !== "json") {
      throw new Error(formatResponseError(createResponse));
    }

    const sessionId = createResponse.data.id;
    const workflowInstanceId = createResponse.data.workflowInstanceId;
    if (!workflowInstanceId) {
      throw new Error("Expected workflow instance id");
    }

    const instances = await workflows.db.find("workflow_instance");
    const instanceRow = instances.find(
      (row: unknown) =>
        String((row as { id?: unknown }).id) === workflowInstanceId &&
        (row as { workflowName?: string }).workflowName === workflowName,
    ) as { id?: string } | undefined;
    if (!instanceRow?.id) {
      throw new Error("Expected workflow instance to exist");
    }
    await workflows.db.update("workflow_instance", instanceRow.id, (b) =>
      b.set({ status: "not-a-status" }),
    );

    const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });

    expect(detailResponse.type).toBe("error");
    if (detailResponse.type !== "error") {
      throw new Error(formatResponseError(detailResponse));
    }
    expect(detailResponse.error.code).toBe("WORKFLOW_INSTANCE_MISSING");
  });
});
