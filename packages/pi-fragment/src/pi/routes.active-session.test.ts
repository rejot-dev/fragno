import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkflowLiveStateStore } from "@fragno-dev/workflows";
import { createAssistantMessageEventStream, type AssistantMessage } from "@mariozechner/pi-ai";
import { drainDurableHooks } from "@fragno-dev/test";

import { buildHarness, createDelayedStreamFn, createStreamFn, mockModel } from "./test-utils";
import type {
  PiActiveSessionProtocolMessage,
  PiActiveSessionState,
  PiFragmentConfig,
} from "./types";
import {
  createInitialPiAgentLoopState,
  ensurePiActiveSessionState,
  PI_WORKFLOW_NAME,
} from "./workflow/workflow";

type TestHarness = Awaited<ReturnType<typeof buildHarness>>;

const readNdjsonResponse = async <T>(response: Response): Promise<T[]> => {
  expect(response.headers.get("content-type")).toContain("application/x-ndjson");
  if (!response.body) {
    throw new Error("Expected active session stream response body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim()) {
          items.push(JSON.parse(line) as T);
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      items.push(JSON.parse(buffer) as T);
    }
  } finally {
    reader.releaseLock();
  }

  return items;
};

const createConfig = (streamFn: NonNullable<PiFragmentConfig["agents"]["default"]["streamFn"]>) =>
  ({
    agents: {
      default: {
        name: "default",
        systemPrompt: "You are helpful.",
        model: mockModel,
        streamFn,
      },
    },
    tools: {},
  }) satisfies PiFragmentConfig;

const buildAssistantMessage = (text: string): AssistantMessage => ({
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

const createReplayableStreamFn = (delayMs = 60) => {
  return () => {
    const stream = createAssistantMessageEventStream();
    const message = buildAssistantMessage("assistant:replay");

    setTimeout(() => {
      stream.push({ type: "start", partial: message });
    }, 0);
    setTimeout(() => {
      stream.push({ type: "done", reason: "stop", message });
    }, delayMs);

    return Object.assign(stream, {
      result: async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return message;
      },
    });
  };
};

describe("pi-fragment active session route", () => {
  const cleanups: Array<() => Promise<void>> = [];

  const createHarness = async (
    config: PiFragmentConfig,
    options: Parameters<typeof buildHarness>[1] = {},
  ): Promise<TestHarness> => {
    const harness = await buildHarness(config, {
      autoTickHooks: true,
      ...options,
    });
    cleanups.push(harness.test.cleanup);
    return harness;
  };

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) {
        await cleanup();
      }
    }
  });

  it("streams protocol frames in order and clears listeners on completion", async () => {
    const liveStateStore = createWorkflowLiveStateStore();
    const { fragments, workflows } = await createHarness(
      createConfig(createStreamFn("assistant:active")),
      {
        liveStateStore,
      },
    );

    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Active stream session" },
    });

    expect(createResponse.type).toBe("json");
    if (createResponse.type !== "json") {
      throw new Error(`Expected json response, got ${createResponse.type}`);
    }

    const sessionId = createResponse.data.id;
    const activeResponse = await fragments.pi.callRouteRaw("GET", "/sessions/:sessionId/active", {
      pathParams: { sessionId },
    });
    await vi.waitFor(() => {
      const liveSnapshot = liveStateStore.get(sessionId, {
        workflowName: PI_WORKFLOW_NAME,
      });
      const activeSession = liveSnapshot?.state["activeSession"] as
        | PiActiveSessionState
        | undefined;
      expect(activeSession?.listenerCount()).toBe(1);
    });
    const sendResponse = await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId },
      body: { text: "hello active stream", done: true },
    });
    expect(sendResponse.type).toBe("json");
    if (sendResponse.type !== "json") {
      throw new Error(`Expected json response, got ${sendResponse.type}`);
    }
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });
    const frames = await readNdjsonResponse<PiActiveSessionProtocolMessage>(activeResponse);

    expect(frames[0]).toMatchObject({ layer: "system", type: "snapshot", turn: 0 });
    expect(frames.some((frame) => frame.layer === "pi" && frame.type === "event")).toBe(true);
    expect(frames.at(-1)).toMatchObject({ layer: "system", type: "settled", turn: 0 });

    const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });

    expect(detailResponse.type).toBe("json");
    if (detailResponse.type !== "json") {
      throw new Error(`Expected json response, got ${detailResponse.type}`);
    }

    const streamedEvents = frames
      .filter(
        (frame): frame is Extract<PiActiveSessionProtocolMessage, { layer: "pi" }> =>
          frame.layer === "pi",
      )
      .map((frame) => frame.event);

    expect(detailResponse.data.trace).toEqual(streamedEvents);

    const liveSnapshot = liveStateStore.get(sessionId, {
      workflowName: PI_WORKFLOW_NAME,
    });
    const activeSession = liveSnapshot?.state["activeSession"] as PiActiveSessionState | undefined;
    expect(activeSession?.listenerCount()).toBe(0);
  }, 15_000);

  it("closes immediately with an inactive system frame for completed sessions", async () => {
    const liveStateStore = createWorkflowLiveStateStore();
    const { fragments, workflows } = await createHarness(createConfig(createDelayedStreamFn(20)), {
      liveStateStore,
    });

    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Completed session" },
    });

    expect(createResponse.type).toBe("json");
    if (createResponse.type !== "json") {
      throw new Error(`Expected json response, got ${createResponse.type}`);
    }

    const sessionId = createResponse.data.id;
    await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId },
      body: { text: "complete", done: true },
    });
    await drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    const activeResponse = await fragments.pi.callRouteRaw("GET", "/sessions/:sessionId/active", {
      pathParams: { sessionId },
    });
    const frames = await readNdjsonResponse<PiActiveSessionProtocolMessage>(activeResponse);

    expect(frames).toEqual([
      {
        layer: "system",
        type: "snapshot",
        turn: 0,
        phase: "complete",
        waitingFor: null,
        replayCount: 0,
      },
      {
        layer: "system",
        type: "inactive",
        reason: "session-complete",
        turn: 0,
        phase: "complete",
        waitingFor: null,
      },
    ]);

    const liveSnapshot = liveStateStore.get(sessionId, {
      workflowName: PI_WORKFLOW_NAME,
    });
    const activeSession = liveSnapshot?.state["activeSession"] as PiActiveSessionState | undefined;
    expect(activeSession?.listenerCount() ?? 0).toBe(0);
  });

  it("replays already-emitted in-memory events to late subscribers", async () => {
    const liveStateStore = createWorkflowLiveStateStore();
    const { fragments, workflows } = await createHarness(
      createConfig(createReplayableStreamFn(80)),
      {
        liveStateStore,
      },
    );

    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Replay session" },
    });

    expect(createResponse.type).toBe("json");
    if (createResponse.type !== "json") {
      throw new Error(`Expected json response, got ${createResponse.type}`);
    }

    const sessionId = createResponse.data.id;
    await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId },
      body: { text: "replay please" },
    });

    const drainPromise = drainDurableHooks(workflows.fragment, { mode: "singlePass" });

    await vi.waitFor(() => {
      const liveSnapshot = liveStateStore.get(sessionId, {
        workflowName: PI_WORKFLOW_NAME,
      });
      const activeSession = liveSnapshot?.state["activeSession"] as
        | PiActiveSessionState
        | undefined;
      expect(activeSession?.replayTurn(0).length ?? 0).toBeGreaterThan(0);
    });

    const activeResponse = await fragments.pi.callRouteRaw("GET", "/sessions/:sessionId/active", {
      pathParams: { sessionId },
    });
    const frames = await readNdjsonResponse<PiActiveSessionProtocolMessage>(activeResponse);
    await drainPromise;

    expect(frames[0]).toMatchObject({ layer: "system", type: "snapshot", turn: 0 });
    expect(
      frames.some(
        (frame) =>
          frame.layer === "pi" &&
          frame.type === "event" &&
          frame.source === "replay" &&
          frame.event.type === "message_start",
      ),
    ).toBe(true);
  }, 15_000);

  it("replays restored history before streaming new live events after a cache miss", async () => {
    const liveStateStore = createWorkflowLiveStateStore();
    const replayEvent = {
      type: "message_start",
      message: buildAssistantMessage("assistant:restored-replay"),
    };
    const liveEvent = {
      type: "text_delta",
      contentIndex: 0,
      delta: "assistant:live-after-restore",
      partial: buildAssistantMessage("assistant:live-after-restore"),
    };

    // This snapshot intentionally looks like state that came back from restore:
    // it has serializable workflow data plus persisted replayable updates, but it does not have
    // the ephemeral in-memory `activeSession` object that normally accumulates those updates.
    const restoredLikeState = Object.assign(createInitialPiAgentLoopState(), {
      phase: "running-agent" as const,
      waitingFor: {
        type: "assistant" as const,
        turn: 0,
        stepKey: "do:assistant-0",
      },
      trace: [replayEvent as never],
      activeSessionUpdatesByTurn: [
        {
          turn: 0,
          updates: [{ type: "event", turn: 0, event: replayEvent }],
        },
      ],
    });

    const { fragments } = await createHarness(createConfig(createStreamFn("assistant:unused")), {
      liveStateStore,
    });

    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Restored active replay session" },
    });

    expect(createResponse.type).toBe("json");
    if (createResponse.type !== "json") {
      throw new Error(`Expected json response, got ${createResponse.type}`);
    }

    // We store the restore-like snapshot directly in the live-state cache to emulate what the
    // route sees immediately after `restoreInstanceState()` has repopulated the cache.
    liveStateStore.set({
      workflowName: PI_WORKFLOW_NAME,
      instanceId: createResponse.data.id,
      runNumber: 0,
      status: "active",
      capturedAt: new Date(),
      state: restoredLikeState as never,
    });

    const activeResponse = await fragments.pi.callRouteRaw("GET", "/sessions/:sessionId/active", {
      pathParams: { sessionId: createResponse.data.id },
    });

    // Once the stream is open, publish a fresh live event and settle the turn.
    // The bug is that the route rebuilds a brand new `activeSession` from this restore-like state,
    // but it never hydrates the historical updates first, so only this live event comes through.
    const restoredActiveSession = ensurePiActiveSessionState(restoredLikeState);
    restoredActiveSession.publishEvent(0, liveEvent as never);
    restoredActiveSession.settleTurn(0, "waiting-for-user");

    const frames = await Promise.race([
      readNdjsonResponse<PiActiveSessionProtocolMessage>(activeResponse),
      new Promise<PiActiveSessionProtocolMessage[]>((_, reject) => {
        setTimeout(() => reject(new Error("Timed out waiting for restored replay stream.")), 1000);
      }),
    ]);

    // Desired behavior:
    //   1. the restored historical event is replayed first
    //   2. only brand new updates are streamed as `source: "live"`
    // Today this assertion fails because the route ignores the persisted replay buffer and creates
    // an empty transient active session instead.
    expect(frames).toEqual([
      {
        layer: "system",
        type: "snapshot",
        turn: 0,
        phase: "running-agent",
        waitingFor: {
          type: "assistant",
          turn: 0,
          stepKey: "do:assistant-0",
        },
        replayCount: 1,
      },
      {
        layer: "pi",
        type: "event",
        turn: 0,
        source: "replay",
        event: replayEvent,
      },
      {
        layer: "pi",
        type: "event",
        turn: 0,
        source: "live",
        event: liveEvent,
      },
      {
        layer: "system",
        type: "settled",
        turn: 0,
        status: "waiting-for-user",
      },
    ]);
  });

  it("closes cleanly when replay already contains settlement for the target turn", async () => {
    const liveStateStore = createWorkflowLiveStateStore();
    const { fragments } = await createHarness(createConfig(createStreamFn("assistant:unused")), {
      liveStateStore,
    });

    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Settled replay session" },
    });

    expect(createResponse.type).toBe("json");
    if (createResponse.type !== "json") {
      throw new Error(`Expected json response, got ${createResponse.type}`);
    }

    const state = createInitialPiAgentLoopState();
    state.phase = "running-agent";
    state.waitingFor = {
      type: "assistant",
      turn: 0,
      stepKey: "do:assistant-0",
    };
    const activeSession = ensurePiActiveSessionState(state);
    activeSession.settleTurn(0, "errored");

    liveStateStore.set({
      workflowName: PI_WORKFLOW_NAME,
      instanceId: createResponse.data.id,
      runNumber: 0,
      status: "errored",
      capturedAt: new Date(),
      state,
    });

    expect(activeSession.listenerCount()).toBe(0);

    const activeResponse = await fragments.pi.callRouteRaw("GET", "/sessions/:sessionId/active", {
      pathParams: { sessionId: createResponse.data.id },
    });
    const frames = await Promise.race([
      readNdjsonResponse<PiActiveSessionProtocolMessage>(activeResponse),
      new Promise<PiActiveSessionProtocolMessage[]>((_, reject) => {
        setTimeout(() => reject(new Error("Timed out waiting for settled replay stream.")), 1000);
      }),
    ]);

    expect(frames).toEqual([
      {
        layer: "system",
        type: "snapshot",
        turn: 0,
        phase: "running-agent",
        waitingFor: {
          type: "assistant",
          turn: 0,
          stepKey: "do:assistant-0",
        },
        replayCount: 0,
      },
      {
        layer: "system",
        type: "settled",
        turn: 0,
        status: "errored",
      },
    ]);
    expect(activeSession.listenerCount()).toBe(0);
  });
});
