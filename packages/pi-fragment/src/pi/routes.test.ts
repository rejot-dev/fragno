import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { drainDurableHooks } from "@fragno-dev/test";

import { buildHarness, createStreamFn, mockModel } from "./pi-test-utils";
import type { PiFragmentConfig } from "./types";
import { PI_WORKFLOW_NAME } from "./workflow/workflow";

const textMessages = (messages: Array<{ role?: string; content?: unknown }>, role: string) =>
  messages.flatMap((message) => {
    if (message.role !== role || !Array.isArray(message.content)) {
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

const createConfig = (
  overrides: Partial<PiFragmentConfig["agents"][string]> = {},
): PiFragmentConfig => ({
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
});

describe("pi-fragment Pi-shaped routes", () => {
  type TestHarness = Awaited<ReturnType<typeof buildHarness>>;
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await buildHarness(createConfig(), { autoTickHooks: true });
  });

  afterEach(async () => {
    await harness.test.cleanup();
  });

  const createSession = async () => {
    const response = await harness.fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Pi Session" },
    });
    expect(response.type).toBe("json");
    if (response.type !== "json") {
      throw new Error("expected json response");
    }
    return response.data.id;
  };

  const runSessionUntilIdle = async (sessionId: string) => {
    await harness.workflows.getStatus(PI_WORKFLOW_NAME, sessionId);
    await harness.workflows.runUntilIdle({
      workflowName: PI_WORKFLOW_NAME,
      instanceId: sessionId,
      instanceRef: sessionId,
      reason: "event",
    });
  };

  it("creates a session with empty Pi state and no old public detail fields", async () => {
    const sessionId = await createSession();

    const detail = await harness.fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });
    expect(detail.type).toBe("json");
    if (detail.type !== "json") {
      throw new Error("expected json response");
    }

    expect(detail.data.agent.state.messages).toEqual([]);
    expect(detail.data.agent.events).toEqual([]);
    expect(detail.data).not.toHaveProperty("trace");
    expect(detail.data).not.toHaveProperty("turns");
    expect(detail.data).not.toHaveProperty("commandHistory");
    expect(detail.data).not.toHaveProperty("phase");
    expect(detail.data).not.toHaveProperty("turn");
    expect(detail.data).not.toHaveProperty("waitingFor");
  });

  it("accepts prompt commands without projecting in-flight events into session detail", async () => {
    const sessionId = await createSession();
    await runSessionUntilIdle(sessionId);

    const command = await harness.fragments.pi.callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId },
      body: { kind: "prompt", input: { text: "hello" } },
    });
    expect(command.type).toBe("json");
    if (command.type !== "json") {
      throw new Error("expected json response");
    }
    expect(command.data.accepted).toBe(true);

    await drainDurableHooks(harness.workflows.fragment);
    await runSessionUntilIdle(sessionId);

    let detail = await harness.fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });
    for (
      let attempt = 0;
      attempt < 20 && detail.type === "json" && detail.data.agent.state.messages.length === 0;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      detail = await harness.fragments.pi.callRoute("GET", "/sessions/:sessionId", {
        pathParams: { sessionId },
      });
    }
    expect(detail.type).toBe("json");
    if (detail.type !== "json") {
      throw new Error("expected json response");
    }

    expect(textMessages(detail.data.agent.state.messages, "user")).toEqual([]);
    expect(textMessages(detail.data.agent.state.messages, "assistant")).toEqual([]);
    expect(detail.data.agent.events).toEqual([]);
  });

  it("streams an initial snapshot from /events", async () => {
    const sessionId = await createSession();

    const stream = await harness.fragments.pi.callRoute("GET", "/sessions/:sessionId/events", {
      pathParams: { sessionId },
    });
    expect(stream.type).toBe("jsonStream");
    if (stream.type !== "jsonStream") {
      throw new Error("expected json stream response");
    }

    const frames: unknown[] = [];
    for await (const frame of stream.stream) {
      frames.push(frame);
      break;
    }

    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "snapshot",
        state: expect.objectContaining({ messages: [] }),
      }),
    );
  });
});
