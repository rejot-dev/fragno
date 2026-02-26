import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildHarness, createStreamFn, drainWorkflowRunner, mockModel } from "./test-utils";
import type { PiFragmentConfig } from "./types";
import { PI_WORKFLOW_NAME } from "./workflow";

describe("pi-fragment new routes", () => {
  const workflowName = PI_WORKFLOW_NAME;
  type TestHarness = Awaited<ReturnType<typeof buildHarness>>;
  let cleanup: TestHarness["test"]["cleanup"];
  let callRoute: TestHarness["fragments"]["pi"]["callRoute"];
  let workflows: TestHarness["workflows"];

  beforeEach(async () => {
    const streamFn = createStreamFn("assistant:init");
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

    const harness = await buildHarness(config);
    callRoute = harness.fragments.pi.callRoute;
    cleanup = harness.test.cleanup;
    workflows = harness.workflows;
  });

  afterEach(async () => {
    await cleanup();
  });

  it("creates a session via POST /sessions", async () => {
    const response = await callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Initial Session" },
    });

    expect(response.type).toBe("json");
    if (response.type !== "json") {
      throw new Error(`Expected json response, got ${response.type}`);
    }

    expect(response.data.id).toBeTruthy();
    expect(response.data.workflowInstanceId).toBeTruthy();
    expect(response.data.status).toBe("active");
  });

  it("lists sessions after creation", async () => {
    const create = await callRoute("POST", "/sessions", {
      body: { agent: "default", name: "List Session" },
    });

    if (create.type !== "json") {
      throw new Error(`Expected json response, got ${create.type}`);
    }

    const list = await callRoute("GET", "/sessions", {});
    if (list.type !== "json") {
      throw new Error(`Expected json response, got ${list.type}`);
    }

    expect(list.data.length).toBeGreaterThan(0);
    expect(list.data[0].id).toBe(create.data.id);
    expect(list.data[0].workflowInstanceId).toBe(create.data.workflowInstanceId);
    expect(list.data[0].status).toBe("active");
  });

  it("accepts a user message via POST /sessions/:sessionId/messages", async () => {
    const create = await callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Message Session" },
    });

    if (create.type !== "json") {
      throw new Error(`Expected json response, got ${create.type}`);
    }

    const messageResponse = await callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId: create.data.id },
      body: { text: "hello" },
    });

    expect(messageResponse.type).toBe("json");
    if (messageResponse.type !== "json") {
      throw new Error(`Expected json response, got ${messageResponse.type}`);
    }

    expect(messageResponse.data.status).toBeTruthy();
    expect(messageResponse.data.status).toBe("active");
  });

  it("fetches session detail via GET /sessions/:sessionId", async () => {
    const create = await callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Detail Session" },
    });

    if (create.type !== "json") {
      throw new Error(`Expected json response, got ${create.type}`);
    }

    const detail = await callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId: create.data.id },
    });

    expect(detail.type).toBe("json");
    if (detail.type !== "json") {
      throw new Error(`Expected json response, got ${detail.type}`);
    }

    expect(detail.data.id).toBe(create.data.id);
    expect(detail.data.workflowInstanceId).toBe(create.data.workflowInstanceId);
    expect(detail.data.status).toBe("active");
  });

  it("runs the full happy path flow", async () => {
    const create = await callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Happy Path" },
    });

    if (create.type !== "json") {
      throw new Error(`Expected json response, got ${create.type}`);
    }

    const sessionId = create.data.id;
    const workflowInstanceId = create.data.workflowInstanceId;
    if (!workflowInstanceId) {
      throw new Error("Expected workflow instance id");
    }

    await callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId },
      body: { text: "hello flow", done: true },
    });

    await drainWorkflowRunner(workflows, workflowName, workflowInstanceId);

    const detail = await callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });

    expect(detail.type).toBe("json");
    if (detail.type !== "json") {
      throw new Error(`Expected json response, got ${detail.type}`);
    }

    expect(detail.data.status).toBe("complete");
    expect(detail.data.messages.length).toBeGreaterThan(0);
    expect(detail.data.trace.length).toBeGreaterThan(0);
    expect(detail.data.summaries.length).toBeGreaterThan(0);
    expect(
      detail.data.messages.some((message) => {
        if (message.role !== "user") {
          return false;
        }
        if (!Array.isArray(message.content)) {
          return false;
        }
        return message.content.some(
          (block) => block.type === "text" && block.text === "hello flow",
        );
      }),
    ).toBe(true);
  });

  it("handles a multi-turn conversation flow", async () => {
    const create = await callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Multi Turn" },
    });

    if (create.type !== "json") {
      throw new Error(`Expected json response, got ${create.type}`);
    }

    const sessionId = create.data.id;
    const workflowInstanceId = create.data.workflowInstanceId;
    if (!workflowInstanceId) {
      throw new Error("Expected workflow instance id");
    }

    await callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId },
      body: { text: "first turn", done: false },
    });
    await drainWorkflowRunner(workflows, workflowName, workflowInstanceId);

    await callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId },
      body: { text: "second turn", done: true },
    });
    await drainWorkflowRunner(workflows, workflowName, workflowInstanceId);

    const detail = await callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });

    expect(detail.type).toBe("json");
    if (detail.type !== "json") {
      throw new Error(`Expected json response, got ${detail.type}`);
    }

    const userTexts: string[] = [];
    for (const message of detail.data.messages) {
      if (message.role !== "user") {
        continue;
      }
      if (!Array.isArray(message.content)) {
        continue;
      }
      for (const block of message.content) {
        if (block.type === "text") {
          userTexts.push(block.text);
        }
      }
    }

    expect(userTexts).toContain("first turn");
    expect(userTexts).toContain("second turn");
    expect(detail.data.summaries.length).toBeGreaterThanOrEqual(2);
    expect(detail.data.trace.length).toBeGreaterThan(0);
    expect(detail.data.status).toBe("complete");
  });
});
