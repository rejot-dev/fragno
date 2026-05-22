import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { workflowsSchema } from "@fragno-dev/workflows";

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

import { type PiAgentRunner } from "./factory";
import { buildHarness, mockModel } from "./pi-test-utils";
import type { PiFragmentConfig } from "./types";
import { interactiveChatWorkflow } from "./workflows/interactive-chat-workflow";

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const userMessage = (text: string): Extract<AgentMessage, { role: "user" }> => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: Date.now(),
});

const assistantMessage = (text: string): Extract<AgentMessage, { role: "assistant" }> => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-responses",
  provider: "openai",
  model: "test-model",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

const createControlledRunner = () => {
  const enteredRun = createDeferred();
  const emitEvent = createDeferred();
  const finishRun = createDeferred();
  const liveEvent: AgentEvent = { type: "agent_start" };

  const runner: PiAgentRunner = async (operation, runtime, lifecycle) => {
    enteredRun.resolve();
    await emitEvent.promise;
    await lifecycle?.onEvent?.(liveEvent);
    await finishRun.promise;

    return {
      stopReason: "stop",
      messages: [
        ...runtime.turn.messages,
        ...(operation.promptInput ? [userMessage(operation.promptInput.text)] : []),
        assistantMessage("done"),
      ],
      events: [liveEvent],
      errorMessage: null,
    };
  };

  return { runner, enteredRun, emitEvent, finishRun, liveEvent };
};

const createConfig = (): PiFragmentConfig => ({
  agents: {
    default: {
      name: "default",
      systemPrompt: "You are helpful.",
      model: mockModel,
    },
  },
  tools: {},
  workflows: [interactiveChatWorkflow],
});

const withTimeout = async <T>(promise: Promise<T>, message: string, ms = 2_000): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);

function assertJsonStream<TResponse extends { type: string }>(
  response: TResponse,
): asserts response is Extract<TResponse, { type: "jsonStream" }> {
  expect(response.type).toBe("jsonStream");
  if (response.type !== "jsonStream") {
    throw new Error(`Expected jsonStream response, got ${response.type}.`);
  }
}

const readFrame = async <T>(
  stream: AsyncGenerator<T, unknown, unknown>,
  message = "Timed out waiting for stream frame.",
): Promise<T> => {
  const next = await withTimeout(stream.next(), message);
  if (next.done) {
    throw new Error("Stream ended before the next frame was written.");
  }
  return next.value;
};

const readUntilFrame = async <T, TMatch extends T>(
  stream: AsyncGenerator<T, unknown, unknown>,
  predicate: (frame: T) => frame is TMatch,
): Promise<TMatch> => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const frame = await readFrame(stream, "Timed out waiting for matching stream frame.");
    if (predicate(frame)) {
      return frame;
    }
  }
  throw new Error("Timed out waiting for matching stream frame.");
};

describe("pi-fragment /events route", () => {
  type TestHarness = Awaited<ReturnType<typeof buildHarness>>;
  let harness: TestHarness;
  let runner: ReturnType<typeof createControlledRunner>;

  beforeEach(async () => {
    runner = createControlledRunner();
    harness = await buildHarness(createConfig(), {
      autoTickHooks: false,
      agentRunner: runner.runner,
    });
  });

  afterEach(async () => {
    await harness.test.cleanup();
  });

  const createSessionAndStartWorkflow = async () => {
    const response = await harness.fragments.pi.callRoute("POST", "/sessions", {
      body: {
        workflow: interactiveChatWorkflow.name,
        name: "Pi Session",
        input: { agentName: "default" },
      },
    });
    expect(response.type).toBe("json");
    if (response.type !== "json") {
      throw new Error("expected json response");
    }

    const sessionId = response.data.id;
    await harness.workflows.getStatus(interactiveChatWorkflow.name, sessionId);

    await harness.workflows.runUntilIdle(
      {
        workflowName: interactiveChatWorkflow.name,
        instanceId: sessionId,
        instanceRef: sessionId,
        reason: "create",
      },
      { maxTicks: 1 },
    );

    return { sessionId, instanceRef: sessionId };
  };

  it("streams every event through message_end across consecutive turns", async () => {
    const turnEvents: AgentEvent[][] = [];
    const runner: PiAgentRunner = async (operation, runtime, lifecycle) => {
      const text = operation.promptInput?.text ?? "continue";
      const events = [
        { type: "agent_start" },
        { type: "turn_start" },
        { type: "message_start", message: userMessage(text) },
        { type: "message_end", message: userMessage(text) },
        { type: "message_start", message: assistantMessage("") },
        { type: "message_update", message: assistantMessage(`${text} partial`) },
        { type: "message_end", message: assistantMessage(`${text} final`) },
        { type: "turn_end" },
        { type: "agent_end" },
      ] as AgentEvent[];
      turnEvents.push(events);
      for (const event of events) {
        await lifecycle?.onEvent?.(event);
      }
      return {
        stopReason: "stop",
        messages: [
          ...runtime.turn.messages,
          ...(operation.promptInput ? [userMessage(operation.promptInput.text)] : []),
          assistantMessage(`${text} final`),
        ],
        events,
        errorMessage: null,
      };
    };
    await harness.test.cleanup();
    harness = await buildHarness(createConfig(), {
      autoTickHooks: false,
      agentRunner: runner,
    });

    try {
      const response = await harness.fragments.pi.callRoute("POST", "/sessions", {
        body: {
          workflow: interactiveChatWorkflow.name,
          name: "Pi Session",
          input: { agentName: "default" },
        },
      });
      expect(response.type).toBe("json");
      if (response.type !== "json") {
        throw new Error("expected json response");
      }
      const sessionId = response.data.id;
      const runNextTick = async (reason: "create" | "event") => {
        await harness.workflows.getStatus(interactiveChatWorkflow.name, sessionId);
        await harness.workflows.runUntilIdle(
          {
            workflowName: interactiveChatWorkflow.name,
            instanceId: sessionId,
            instanceRef: sessionId,
            reason,
          },
          { maxTicks: 1 },
        );
      };

      await withTimeout(runNextTick("create"), "create tick did not complete");
      const streamResponse = await harness.fragments.pi.callRoute(
        "GET",
        "/sessions/:sessionId/events",
        {
          pathParams: { sessionId },
        },
      );
      assertJsonStream(streamResponse);
      const stream = streamResponse.stream;

      try {
        await expect(readFrame(stream)).resolves.toMatchObject({ type: "snapshot" });

        await withTimeout(
          harness.fragments.pi.callRoute("POST", "/sessions/:sessionId/command", {
            pathParams: { sessionId },
            body: { kind: "prompt", input: { text: "first" } },
          }),
          "first command route did not complete",
        );
        const firstTick = withTimeout(runNextTick("event"), "first event tick did not complete");
        await expect(
          readUntilFrame(
            stream,
            (frame): frame is Extract<AgentEvent, { type: "message_end" }> =>
              "type" in frame &&
              frame.type === "message_end" &&
              JSON.stringify(frame.message).includes("first final"),
          ),
        ).resolves.toMatchObject({ type: "message_end" });
        await firstTick;

        await withTimeout(
          harness.fragments.pi.callRoute("POST", "/sessions/:sessionId/command", {
            pathParams: { sessionId },
            body: { kind: "prompt", input: { text: "second" } },
          }),
          "second command route did not complete",
        );
        const secondTick = withTimeout(runNextTick("event"), "second event tick did not complete");
        await expect(
          readUntilFrame(
            stream,
            (frame): frame is Extract<AgentEvent, { type: "message_end" }> =>
              "type" in frame &&
              frame.type === "message_end" &&
              JSON.stringify(frame.message).includes("second final"),
          ),
        ).resolves.toMatchObject({ type: "message_end" });
        await secondTick;
      } finally {
        await stream.return(undefined);
      }
    } finally {
      await harness.test.cleanup();
    }
  }, 10_000);

  it("replays waiting-step emissions after the completed-state snapshot", async () => {
    const { sessionId } = await createSessionAndStartWorkflow();
    await harness.workflows.getStatus(interactiveChatWorkflow.name, sessionId);

    const stepKey = "do:command-0-prompt";
    const inFlightEvent = {
      type: "message_update",
      message: assistantMessage("partial while waiting"),
    } as AgentEvent;

    const uow = harness.workflows.db
      .createUnitOfWork("seed-waiting-step-emission")
      .forSchema(workflowsSchema);
    uow.create("workflow_step", {
      instanceRef: sessionId,
      stepKey,
      parentStepKey: null,
      depth: 0,
      name: "command-0-prompt",
      type: "do",
      status: "waiting",
      attempts: 1,
      maxAttempts: 1,
      timeoutMs: null,
      nextRetryAt: null,
      wakeAt: null,
      waitEventType: null,
      result: null,
      errorName: null,
      errorMessage: null,
    });
    uow.create("workflow_step_emission", {
      instanceRef: sessionId,
      stepKey,
      epoch: "epoch-waiting-step",
      sequence: 0,
      actor: "user",
      payload: inFlightEvent,
    });
    const { success } = await uow.executeMutations();
    if (!success) {
      throw new Error("Failed to seed waiting step emission.");
    }

    const response = await harness.fragments.pi.callRoute("GET", "/sessions/:sessionId/events", {
      pathParams: { sessionId },
      query: { once: "true" },
    });
    assertJsonStream(response);

    expect(await Array.fromAsync(response.stream)).toEqual([
      expect.objectContaining({
        type: "snapshot",
        state: { messages: [] },
      }),
      expect.objectContaining(inFlightEvent),
    ]);
  }, 10_000);

  it("streams in-flight ephemeral events after the completed-state snapshot", async () => {
    const enteredRun = createDeferred();
    const releaseRunner = createDeferred();
    const assistantPartial = assistantMessage("partial poem");
    const customRunner: PiAgentRunner = async (operation, runtime, lifecycle) => {
      const promptMessage = userMessage(operation.promptInput?.text ?? "");
      enteredRun.resolve();
      await lifecycle?.onEvent?.({ type: "message_start", message: promptMessage } as AgentEvent);
      await lifecycle?.onEvent?.({ type: "message_end", message: promptMessage } as AgentEvent);
      await lifecycle?.onEvent?.({
        type: "message_update",
        message: assistantPartial,
      } as AgentEvent);
      await releaseRunner.promise;
      return {
        stopReason: "stop",
        messages: [
          ...runtime.turn.messages,
          ...(operation.promptInput ? [userMessage(operation.promptInput.text)] : []),
          assistantMessage("done"),
        ],
        events: [{ type: "message_update", message: assistantPartial } as AgentEvent],
        errorMessage: null,
      };
    };

    await harness.test.cleanup();
    harness = await buildHarness(createConfig(), {
      autoTickHooks: false,
      agentRunner: customRunner,
    });

    const sessionResponse = await harness.fragments.pi.callRoute("POST", "/sessions", {
      body: { workflow: interactiveChatWorkflow.name, name: "Pi", input: { agentName: "default" } },
    });
    expect(sessionResponse.type).toBe("json");
    if (sessionResponse.type !== "json") {
      throw new Error("expected json response");
    }
    const sessionId = sessionResponse.data.id;
    await harness.workflows.getStatus(interactiveChatWorkflow.name, sessionId);
    const instanceRef = sessionId;

    await harness.workflows.runUntilIdle(
      {
        workflowName: interactiveChatWorkflow.name,
        instanceId: sessionId,
        instanceRef,
        reason: "create",
      },
      { maxTicks: 1 },
    );
    await harness.fragments.pi.callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId },
      body: { kind: "prompt", input: { text: "write me a poem" } },
    });

    const runPromise = harness.workflows.runUntilIdle(
      {
        workflowName: interactiveChatWorkflow.name,
        instanceId: sessionId,
        instanceRef,
        reason: "event",
      },
      { maxTicks: 1 },
    );
    await enteredRun.promise;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));

    const response = await harness.fragments.pi.callRoute("GET", "/sessions/:sessionId/events", {
      pathParams: { sessionId },
      query: { once: "true" },
    });
    assertJsonStream(response);

    expect(await Array.fromAsync(response.stream)).toEqual([
      expect.objectContaining({
        type: "snapshot",
        state: { messages: [] },
      }),
      expect.objectContaining({
        type: "message_start",
        message: expect.objectContaining({
          role: "user",
          content: [{ type: "text", text: "write me a poem" }],
        }),
      }),
      expect.objectContaining({
        type: "message_end",
        message: expect.objectContaining({
          role: "user",
          content: [{ type: "text", text: "write me a poem" }],
        }),
      }),
      expect.objectContaining({
        type: "message_update",
        message: assistantPartial,
      }),
    ]);

    releaseRunner.resolve();
    await runPromise;
  }, 10_000);

  it("streams in-flight tool emissions after the completed-state snapshot", async () => {
    const enteredRun = createDeferred();
    const releaseRunner = createDeferred();
    const finishRunner = createDeferred();
    const earlyEvent = {
      type: "tool_execution_start",
      toolCallId: "tool-1",
    } as AgentEvent;
    const lateEvent = {
      type: "tool_execution_end",
      toolCallId: "tool-1",
    } as AgentEvent;

    const customRunner: PiAgentRunner = async (operation, runtime, lifecycle) => {
      enteredRun.resolve();
      await lifecycle?.onEvent?.(earlyEvent);
      await releaseRunner.promise;
      await lifecycle?.onEvent?.(lateEvent);
      await finishRunner.promise;
      return {
        stopReason: "stop",
        messages: [
          ...runtime.turn.messages,
          ...(operation.promptInput ? [userMessage(operation.promptInput.text)] : []),
          assistantMessage("done"),
        ],
        events: [earlyEvent, lateEvent],
        errorMessage: null,
      };
    };

    await harness.test.cleanup();
    harness = await buildHarness(createConfig(), {
      autoTickHooks: false,
      agentRunner: customRunner,
    });

    const sessionResponse = await harness.fragments.pi.callRoute("POST", "/sessions", {
      body: { workflow: interactiveChatWorkflow.name, name: "Pi", input: { agentName: "default" } },
    });
    expect(sessionResponse.type).toBe("json");
    if (sessionResponse.type !== "json") {
      throw new Error("expected json response");
    }
    const sessionId = sessionResponse.data.id;
    await harness.workflows.getStatus(interactiveChatWorkflow.name, sessionId);
    const instanceRef = sessionId;

    await harness.workflows.runUntilIdle(
      {
        workflowName: interactiveChatWorkflow.name,
        instanceId: sessionId,
        instanceRef,
        reason: "create",
      },
      { maxTicks: 1 },
    );

    await harness.fragments.pi.callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId },
      body: { kind: "prompt", input: { text: "hello" } },
    });

    const runPromise = harness.workflows.runUntilIdle(
      {
        workflowName: interactiveChatWorkflow.name,
        instanceId: sessionId,
        instanceRef,
        reason: "event",
      },
      { maxTicks: 1 },
    );

    await enteredRun.promise;
    // Give the bus's poll loop time to persist the early event.
    await new Promise<void>((resolve) => setTimeout(resolve, 250));

    const response = await harness.fragments.pi.callRoute("GET", "/sessions/:sessionId/events", {
      pathParams: { sessionId },
    });
    assertJsonStream(response);
    const stream = response.stream;

    try {
      const snapshotFrame = await readFrame(stream);
      expect(snapshotFrame).toMatchObject({
        type: "snapshot",
        state: { messages: [] },
      });

      await expect(readFrame(stream)).resolves.toMatchObject({
        type: "tool_execution_start",
        toolCallId: "tool-1",
      });

      releaseRunner.resolve();

      const next = await readFrame(stream);
      expect(next).toMatchObject({ type: "tool_execution_end", toolCallId: "tool-1" });

      finishRunner.resolve();
      await runPromise;
    } finally {
      await stream.return(undefined);
    }
  }, 10_000);

  it("streams outbound step-emission events", async () => {
    const { sessionId, instanceRef } = await createSessionAndStartWorkflow();
    const response = await harness.fragments.pi.callRoute("GET", "/sessions/:sessionId/events", {
      pathParams: { sessionId },
    });
    assertJsonStream(response);
    const stream = response.stream;

    try {
      await expect(readFrame(stream)).resolves.toMatchObject({
        type: "snapshot",
        state: { messages: [] },
      });

      await harness.fragments.pi.callRoute("POST", "/sessions/:sessionId/command", {
        pathParams: { sessionId },
        body: { kind: "prompt", input: { text: "hello" } },
      });
      const run = harness.workflows.runUntilIdle(
        {
          workflowName: interactiveChatWorkflow.name,
          instanceId: sessionId,
          instanceRef,
          reason: "event",
        },
        { maxTicks: 1 },
      );

      await runner.enteredRun.promise;
      runner.emitEvent.resolve();
      await expect(readFrame(stream)).resolves.toEqual(runner.liveEvent);
      runner.finishRun.resolve();
      await run;
    } finally {
      await stream.return(undefined);
    }
  }, 10_000);
});
