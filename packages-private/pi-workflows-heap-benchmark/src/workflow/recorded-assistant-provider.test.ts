import { assert, describe, expect, it, vi } from "vitest";

import { getEventListeners } from "node:events";

import {
  createAssistantMessageEventStream,
  createProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type ProviderStreams,
} from "@earendil-works/pi-ai";

import {
  createAssistantTraceCaptureProvider,
  createRecordedAssistantProvider,
  parseRecordedAssistantTrace,
  type RecordedAssistantTrace,
} from "./recorded-assistant-provider";

const model: Model<Api> = {
  id: "source-model",
  name: "Source model",
  api: "test-api",
  provider: "source-provider",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 4_096,
};

const usage: AssistantMessage["usage"] = {
  input: 10,
  output: 3,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 13,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function message(text: string, stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason,
    timestamp: 1,
  };
}

function sourceEvents(): AssistantMessageEvent[] {
  return [
    { type: "start", partial: { ...message("", "pending"), content: [] } },
    { type: "text_start", contentIndex: 0, partial: message("", "pending") },
    { type: "text_delta", contentIndex: 0, delta: "hel", partial: message("hel", "pending") },
    { type: "text_delta", contentIndex: 0, delta: "lo", partial: message("hello", "pending") },
    { type: "text_end", contentIndex: 0, content: "hello", partial: message("hello", "pending") },
    { type: "done", reason: "stop", message: message("hello", "stop") },
  ];
}

function replayTrace(afterMs: number): RecordedAssistantTrace {
  return {
    schemaVersion: 1,
    capturedAt: "2026-09-24T00:00:00.000Z",
    prompt: "write a poem",
    sourceModel: model,
    events: [
      {
        afterMs,
        type: "start",
        message: { ...message("", "pending"), content: [] },
      },
      { afterMs, type: "done", reason: "stop", message: message("", "stop") },
    ],
  };
}

function providerApi(events: readonly AssistantMessageEvent[]): ProviderStreams {
  function stream() {
    const output = createAssistantMessageEventStream();
    for (const event of events) {
      output.push(structuredClone(event));
    }
    return output;
  }
  return { stream, streamSimple: stream };
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("recorded assistant provider", () => {
  it("captures a compact trace and replays the same assistant events", async () => {
    const events = sourceEvents();
    const sourceProvider = createProvider({
      id: model.provider,
      auth: {
        apiKey: {
          name: "test",
          resolve: async () => ({ auth: {}, source: "test" }),
        },
      },
      models: [model],
      api: providerApi(events),
    });
    let captured: RecordedAssistantTrace | undefined;
    const captureProvider = createAssistantTraceCaptureProvider(sourceProvider, {
      prompt: "write a poem",
      writeTrace: async (trace) => {
        captured = trace;
      },
    });

    await collect(captureProvider.streamSimple(model, { messages: [] }));
    assert(captured);
    const trace = parseRecordedAssistantTrace(JSON.parse(JSON.stringify(captured)));
    expect(trace.events.map((event) => event.type)).toEqual(events.map((event) => event.type));
    const recordedDelta = trace.events.find((event) => event.type === "text_delta");
    assert(recordedDelta?.type === "text_delta");
    assert(recordedDelta.delta === "hel");
    assert(!("content" in recordedDelta.message));

    const recorded = createRecordedAssistantProvider(trace, 1_000);
    const replayed = await collect(
      recorded.provider.streamSimple(recorded.model, { messages: [] }),
    );

    expect(replayed).toEqual(events);
  });

  it("removes abort listeners after replay delays complete", async () => {
    const controller = new AbortController();
    const recorded = createRecordedAssistantProvider(replayTrace(1), 1);

    await collect(
      recorded.provider.streamSimple(
        recorded.model,
        { messages: [] },
        {
          signal: controller.signal,
        },
      ),
    );

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("removes the active abort listener when replay is aborted", async () => {
    const controller = new AbortController();
    const recorded = createRecordedAssistantProvider(replayTrace(60_000), 1);
    const replay = collect(
      recorded.provider.streamSimple(
        recorded.model,
        { messages: [] },
        {
          signal: controller.signal,
        },
      ),
    );

    await vi.waitFor(() => {
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    });
    controller.abort(new Error("Stop recorded assistant replay."));

    const events = await replay;
    assert(events.at(-1)?.type === "error");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("rejects malformed traces and invalid replay speeds", () => {
    expect(() => parseRecordedAssistantTrace({ schemaVersion: 1, events: [] })).toThrow(
      "Recorded assistant trace is invalid.",
    );
    const trace = parseRecordedAssistantTrace({
      schemaVersion: 1,
      capturedAt: "2026-09-24T00:00:00.000Z",
      prompt: "write a poem",
      sourceModel: model,
      events: [
        {
          afterMs: 0,
          type: "start",
          message: { ...message("", "pending"), content: [] },
        },
        { afterMs: 0, type: "done", reason: "stop", message: message("", "stop") },
      ],
    });
    expect(() => createRecordedAssistantProvider(trace, 0)).toThrow(
      "Recorded assistant replay speed must be greater than zero.",
    );
  });
});
