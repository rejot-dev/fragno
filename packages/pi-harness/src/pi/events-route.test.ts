import { afterEach, beforeEach, describe, expect, it, assert } from "vitest";

import type { AgentEvent, StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

import { buildHarness, createAssistantMessage, createEnv, mockModel } from "./pi-test-utils";
import type { PiFragmentConfig, PiSessionEventStreamItem } from "./types";
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

const assertJsonStream = <T extends { type: string }>(
  response: T,
): Extract<T, { type: "jsonStream" }> => {
  assert(response.type === "jsonStream");
  return response as Extract<T, { type: "jsonStream" }>;
};

const readFrame = async <T>(stream: AsyncIterable<T>, message = "Timed out waiting for frame.") => {
  const iterator = stream[Symbol.asyncIterator]();
  const result = await withTimeout(iterator.next(), message);
  if (result.done) {
    throw new Error("Stream ended before next frame.");
  }
  return result.value;
};

const readUntilFrame = async <T>(
  stream: AsyncIterable<T>,
  predicate: (frame: T) => boolean,
  message = "Timed out waiting for matching frame.",
): Promise<T> => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const frame = await readFrame(stream, message);
    if (predicate(frame)) {
      return frame;
    }
  }
  throw new Error(message);
};

const isHarnessEventFrame = (
  frame: PiSessionEventStreamItem,
): frame is Extract<PiSessionEventStreamItem, { kind: "step-emission" }> & {
  payload: { kind: "harness-event"; event: AgentEvent };
} =>
  "kind" in frame &&
  frame.kind === "step-emission" &&
  typeof frame.payload === "object" &&
  frame.payload !== null &&
  "kind" in frame.payload &&
  frame.payload.kind === "harness-event" &&
  "event" in frame.payload;

const harnessEvent = (frame: PiSessionEventStreamItem): AgentEvent | null =>
  isHarnessEventFrame(frame) ? frame.payload.event : null;

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

describe("pi-harness /events route", () => {
  let harness: TestHarness;
  let interactiveChatWorkflow: ReturnType<typeof createInteractiveChatWorkflow>;
  let releaseAssistant: Deferred;

  beforeEach(async () => {
    releaseAssistant = createDeferred();
    interactiveChatWorkflow = createInteractiveChatWorkflow({
      harnesses: {
        default: {
          env: createEnv(),
          systemPrompt: "You are helpful.",
          model: mockModel,
          streamFn: createPausedTextStreamFn("partial then final", releaseAssistant.promise),
        },
      },
    });
    const config: PiFragmentConfig = { workflows: [interactiveChatWorkflow] };
    harness = await buildHarness(config, { autoTickHooks: false });
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

  it("streams an initial snapshot before live harness emissions", async () => {
    const sessionId = await createSessionAndStartWorkflow();
    const response = assertJsonStream(
      await harness.fragments.pi.callRoute(
        "GET",
        "/workflows/:workflowName/sessions/:sessionId/events",
        {
          pathParams: { workflowName: interactiveChatWorkflow.name, sessionId },
        },
      ),
    );

    try {
      await expect(readFrame(response.stream)).resolves.toMatchObject({
        type: "snapshot",
        state: { messages: [] },
      });

      await harness.fragments.pi.callRoute(
        "POST",
        "/workflows/:workflowName/sessions/:sessionId/command",
        {
          pathParams: { workflowName: interactiveChatWorkflow.name, sessionId },
          body: { kind: "prompt", input: { text: "hello" } },
        },
      );
      const run = harness.workflows.runUntilIdle(
        {
          workflowName: interactiveChatWorkflow.name,
          instanceId: sessionId,
          reason: "event",
        },
        { maxTicks: 1 },
      );

      const frame = await readUntilFrame(response.stream, (candidate) => {
        const event = harnessEvent(candidate);
        return event?.type === "message_update" && event.message.role === "assistant";
      });
      expect(harnessEvent(frame)).toMatchObject({
        type: "message_update",
        message: expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "partial then final" }],
        }),
      });

      releaseAssistant.resolve();
      await run;
    } finally {
      await response.stream.return(undefined);
    }
  });

  it("replays in-flight harness emissions after the completed-state snapshot", async () => {
    const sessionId = await createSessionAndStartWorkflow();
    await harness.fragments.pi.callRoute(
      "POST",
      "/workflows/:workflowName/sessions/:sessionId/command",
      {
        pathParams: { workflowName: interactiveChatWorkflow.name, sessionId },
        body: { kind: "prompt", input: { text: "hello" } },
      },
    );
    const run = harness.workflows.runUntilIdle(
      {
        workflowName: interactiveChatWorkflow.name,
        instanceId: sessionId,
        reason: "event",
      },
      { maxTicks: 1 },
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 250));

    const frame = await withTimeout(
      (async () => {
        const response = assertJsonStream(
          await harness.fragments.pi.callRoute(
            "GET",
            "/workflows/:workflowName/sessions/:sessionId/events",
            {
              pathParams: { workflowName: interactiveChatWorkflow.name, sessionId },
              query: { once: "true" },
            },
          ),
        );
        return await Array.fromAsync(response.stream);
      })(),
      "Timed out waiting for one-shot events.",
    );

    expect(frame[0]).toMatchObject({ type: "snapshot", state: { messages: [] } });
    assert(frame.some((item) => harnessEvent(item)?.type === "message_update"));

    releaseAssistant.resolve();
    await run;
  });
});
