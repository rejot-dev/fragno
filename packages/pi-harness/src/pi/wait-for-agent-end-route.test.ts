import { afterEach, beforeEach, describe, expect, it, assert } from "vitest";

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

import { buildHarness, createAssistantMessage, createEnv, mockModel } from "./pi-test-utils";
import type { PiFragmentConfig } from "./types";
import { createInteractiveChatWorkflow } from "./workflows/interactive-chat-workflow";

type TestHarness = Awaited<ReturnType<typeof buildHarness>>;

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

const createDeferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const sleep = (timeoutMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, timeoutMs));

const withTimeout = async <T>(promise: Promise<T>, message: string): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 2_000);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const assertJson = <T extends { type: string }>(response: T): Extract<T, { type: "json" }> => {
  assert(response.type === "json");
  return response as Extract<T, { type: "json" }>;
};

const assertError = <T extends { type: string }>(response: T): Extract<T, { type: "error" }> => {
  assert(response.type === "error");
  return response as Extract<T, { type: "error" }>;
};

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

const createPausedTextStreamFn = (text: string, waitBeforeEnd: Promise<unknown>): StreamFn => {
  return () => {
    const stream = createAssistantMessageEventStream();
    const message = createAssistantMessage(text);

    void (async () => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      await waitBeforeEnd;
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
      stream.push({ type: "done", reason: "stop", message });
    })();

    return stream;
  };
};

const createImmediateTextStreamFn = (text: string): StreamFn => {
  return () => {
    const stream = createAssistantMessageEventStream();
    const message = createAssistantMessage(text);

    void (async () => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
      stream.push({ type: "done", reason: "stop", message });
    })();

    return stream;
  };
};

describe("pi-harness wait-for-agent-end route", () => {
  let harness: TestHarness;
  let interactiveChatWorkflow: ReturnType<typeof createInteractiveChatWorkflow>;
  let releaseAssistant: Deferred;

  const setupHarness = async (streamFn: StreamFn) => {
    interactiveChatWorkflow = createInteractiveChatWorkflow({
      harnesses: {
        default: {
          env: createEnv(),
          systemPrompt: "You are helpful.",
          model: mockModel,
          streamFn,
        },
      },
    });
    const config: PiFragmentConfig = { workflows: [interactiveChatWorkflow] };
    harness = await buildHarness(config, { autoTickHooks: false });
  };

  beforeEach(async () => {
    releaseAssistant = createDeferred();
    await setupHarness(createPausedTextStreamFn("partial then final", releaseAssistant.promise));
  });

  afterEach(async () => {
    releaseAssistant.resolve();
    await harness.test.cleanup();
  });

  const createSessionAndStartWorkflow = async () => {
    const response = assertJson(
      await harness.fragments.pi.callRoute("POST", "/workflows/:workflowName/sessions", {
        pathParams: { workflowName: interactiveChatWorkflow.name },
        body: { name: "Pi Session", input: { harnessName: "default" } },
      }),
    );
    const sessionId = response.data.id as string;
    await harness.workflows.getStatus(interactiveChatWorkflow.name, sessionId);
    await harness.workflows.runUntilIdle(
      {
        workflowName: interactiveChatWorkflow.name,
        instanceId: sessionId,
        reason: "create",
      },
      { maxTicks: 1 },
    );
    return sessionId;
  };

  const sendPrompt = (sessionId: string, text: string) =>
    harness.fragments.pi.callRoute("POST", "/workflows/:workflowName/sessions/:sessionId/command", {
      pathParams: { workflowName: interactiveChatWorkflow.name, sessionId },
      body: { kind: "prompt", input: { text } },
    });

  const waitForAgentEnd = (sessionId: string, timeoutMs = 2_000) =>
    harness.fragments.pi.callRoute(
      "GET",
      "/workflows/:workflowName/sessions/:sessionId/wait-for-agent-end",
      {
        pathParams: { workflowName: interactiveChatWorkflow.name, sessionId },
        query: { timeoutMs: String(timeoutMs) },
      },
    );

  it("waits for a live agent_end and returns the canonical session detail", async () => {
    const sessionId = await createSessionAndStartWorkflow();
    let waitSettled = false;
    const wait = waitForAgentEnd(sessionId).then((response) => {
      waitSettled = true;
      return response;
    });

    await sendPrompt(sessionId, "hello");
    const run = harness.workflows.runUntilIdle(
      {
        workflowName: interactiveChatWorkflow.name,
        instanceId: sessionId,
        reason: "event",
      },
      { maxTicks: 1 },
    );

    await sleep(20);
    assert(!waitSettled);

    releaseAssistant.resolve();
    await run;

    const response = assertJson(await withTimeout(wait, "Timed out waiting for agent_end."));
    expect(textMessages(response.data.agent.state.messages, "user")).toEqual(["hello"]);
    expect(textMessages(response.data.agent.state.messages, "assistant")).toEqual([
      "partial then final",
    ]);
    expect(response.data.agent.completedStepKeys).toEqual(expect.any(Array));
    expect(response.data.agent).not.toHaveProperty("events");
  });

  it("uses GET query params and times out when no live agent_end is observed", async () => {
    const sessionId = await createSessionAndStartWorkflow();

    const response = assertError(await waitForAgentEnd(sessionId, 5));

    assert(response.status === 408);
    assert(response.error.code === "AGENT_END_TIMEOUT");
  });

  it("returns SESSION_NOT_FOUND for missing sessions", async () => {
    const response = assertError(await waitForAgentEnd("missing-session", 5));

    assert(response.status === 404);
    assert(response.error.code === "SESSION_NOT_FOUND");
  });

  it("catches fast agent_end emissions when waiting starts before the command", async () => {
    await harness.test.cleanup();
    await setupHarness(createImmediateTextStreamFn("fast final"));
    const sessionId = await createSessionAndStartWorkflow();

    const wait = waitForAgentEnd(sessionId);
    await sendPrompt(sessionId, "hello fast");
    await harness.workflows.runUntilIdle({
      workflowName: interactiveChatWorkflow.name,
      instanceId: sessionId,
      reason: "event",
    });

    const response = assertJson(await withTimeout(wait, "Timed out waiting for fast agent_end."));
    expect(textMessages(response.data.agent.state.messages, "user")).toEqual(["hello fast"]);
    expect(textMessages(response.data.agent.state.messages, "assistant")).toEqual(["fast final"]);
    expect(response.data.agent).not.toHaveProperty("events");
  });
});
