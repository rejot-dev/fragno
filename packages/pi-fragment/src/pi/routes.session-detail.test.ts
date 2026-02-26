import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantMessage } from "@mariozechner/pi-ai";

import { buildHarness, createStreamFn, drainWorkflowRunner, mockModel } from "./test-utils";
import type { PiFragmentConfig } from "./types";
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

    const result = await buildHarness(config);
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
    await drainWorkflowRunner(workflows, workflowName, workflowInstanceId);

    const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });

    expect(detailResponse.type).toBe("json");
    if (detailResponse.type !== "json") {
      throw new Error(formatResponseError(detailResponse));
    }

    expect(detailResponse.data.messages.length).toBeGreaterThan(0);
    expect(detailResponse.data.trace.length).toBeGreaterThan(0);
    expect(detailResponse.data.summaries.length).toBeGreaterThan(0);
    expect(detailResponse.data.summaries[0]?.summary ?? "").toContain("assistant");
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
    await drainWorkflowRunner(workflows, workflowName, workflowInstanceId);
    await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId },
      body: { text: "pong", done: true },
    });
    await drainWorkflowRunner(workflows, workflowName, workflowInstanceId);

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
    expect(detailResponse.data.trace.length).toBeGreaterThan(0);
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
