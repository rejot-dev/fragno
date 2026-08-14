import { assert, describe, expect, it } from "vitest";

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";

import { createAssistantStreamScript } from "./assistant-stream-script";

const eventTypes = (events: readonly AssistantMessageEvent[]) => events.map((event) => event.type);

const partialContent = (
  event: AssistantMessageEvent | undefined,
): AssistantMessage["content"] | undefined =>
  event && "partial" in event ? event.partial.content : undefined;

const collectStream = async (streamFn: StreamFn) => {
  const stream = await streamFn({} as never, { messages: [] }, {});
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return { events, result: await stream.result() };
};

describe("createAssistantStreamScript", () => {
  it("compiles chunked text into start, deltas, end, and done", () => {
    const compiled = createAssistantStreamScript()
      .text("hello", { chunks: ["he", "ll", "o"] })
      .compile();

    expect(eventTypes(compiled.events)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(partialContent(compiled.events[1])).toEqual([{ type: "text", text: "" }]);
    expect(partialContent(compiled.events[2])).toEqual([{ type: "text", text: "he" }]);
    expect(partialContent(compiled.events[4])).toEqual([{ type: "text", text: "hello" }]);
    expect(compiled.finalMessage.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("compiles thinking and text blocks with stable content indexes", () => {
    const compiled = createAssistantStreamScript()
      .thinking("plan", { chunks: ["pl", "an"] })
      .text("answer", { chunks: ["ans", "wer"] })
      .compile();

    expect(compiled.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "thinking_start", contentIndex: 0 }),
        expect.objectContaining({ type: "thinking_delta", contentIndex: 0, delta: "pl" }),
        expect.objectContaining({ type: "text_start", contentIndex: 1 }),
        expect.objectContaining({ type: "text_delta", contentIndex: 1, delta: "wer" }),
      ]),
    );
    expect(compiled.finalMessage.content).toEqual([
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "answer" },
    ]);
  });

  it("streams incremental tool-call JSON and parses partial arguments", () => {
    const compiled = createAssistantStreamScript()
      .toolCall("read", {
        id: "call-1",
        arguments: { path: "/tmp/a" },
        chunks: ['{"path":', '"/tmp/a"}'],
      })
      .completes("toolUse")
      .compile();

    const firstDelta = compiled.events.find(
      (event): event is Extract<AssistantMessageEvent, { type: "toolcall_delta" }> =>
        event.type === "toolcall_delta",
    );
    const end = compiled.events.find(
      (event): event is Extract<AssistantMessageEvent, { type: "toolcall_end" }> =>
        event.type === "toolcall_end",
    );

    expect(firstDelta?.partial.content[0]).toMatchObject({
      type: "toolCall",
      id: "call-1",
      name: "read",
      arguments: {},
      partialJson: '{"path":',
    });
    expect(end?.toolCall).toEqual({
      type: "toolCall",
      id: "call-1",
      name: "read",
      arguments: { path: "/tmp/a" },
    });
    assert(compiled.finalMessage.stopReason === "toolUse");
  });

  it("can omit toolcall_start's tool-call block", () => {
    const compiled = createAssistantStreamScript()
      .toolCall("read", {
        id: "call-1",
        arguments: { path: "/tmp/a" },
        startBlock: "empty",
        chunks: [],
        end: false,
      })
      .compile();
    const start = compiled.events.find(
      (event): event is Extract<AssistantMessageEvent, { type: "toolcall_start" }> =>
        event.type === "toolcall_start",
    );

    expect(start?.partial.content).toEqual([]);
  });

  it("can target text_end at an index without a text block", () => {
    const compiled = createAssistantStreamScript()
      .startsWith([{ type: "thinking", thinking: "not text" }])
      .text("provider text", {
        contentIndex: 0,
        start: false,
        chunks: [],
        endContent: "provider text",
      })
      .compile();
    const end = compiled.events.find(
      (event): event is Extract<AssistantMessageEvent, { type: "text_end" }> =>
        event.type === "text_end",
    );

    expect(end).toMatchObject({ type: "text_end", contentIndex: 0, content: "provider text" });
    expect(end?.partial.content).toEqual([{ type: "thinking", thinking: "not text" }]);
  });

  it("supports sparse and overwritten content indexes", () => {
    const compiled = createAssistantStreamScript()
      .text("third", { contentIndex: 2 })
      .thinking("replacement", { contentIndex: 2 })
      .compile();

    expect(compiled.finalMessage.content).toEqual([
      undefined,
      undefined,
      { type: "thinking", thinking: "replacement" },
    ]);
  });

  it("allows exact per-event snapshots that diverge from accumulated content", () => {
    const snapshots: AssistantMessage["content"][] = [
      [],
      [{ type: "thinking", thinking: "provider correction" }],
      [],
    ];
    const compiled = createAssistantStreamScript()
      .text("hello", { chunks: ["hello"], snapshots })
      .compile();

    expect(partialContent(compiled.events[1])).toEqual([]);
    expect(partialContent(compiled.events[2])).toEqual([
      { type: "thinking", thinking: "provider correction" },
    ]);
    expect(partialContent(compiled.events[3])).toEqual([]);
    expect(compiled.finalMessage.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("supports omitted start and end events", () => {
    const compiled = createAssistantStreamScript()
      .startsWith([{ type: "text", text: "before" }])
      .text(" after", { start: false, end: false, chunks: [" after"], contentIndex: 0 })
      .compile();

    expect(eventTypes(compiled.events)).toEqual(["start", "text_delta", "done"]);
    expect(compiled.finalMessage.content).toEqual([{ type: "text", text: "before after" }]);
  });

  it("supports a terminal message that differs from the final partial", () => {
    const compiled = createAssistantStreamScript()
      .text("partial")
      .completes("stop", {
        content: [{ type: "text", text: "provider corrected final" }],
        message: { responseId: "response-1", timestamp: 2 },
      })
      .compile();

    expect(compiled.finalMessage).toMatchObject({
      content: [{ type: "text", text: "provider corrected final" }],
      responseId: "response-1",
      timestamp: 2,
    });
  });

  it("compiles terminal provider errors", () => {
    const compiled = createAssistantStreamScript()
      .text("partial", { end: false })
      .fails("provider disconnected")
      .compile();
    const terminal = compiled.events.at(-1);

    expect(terminal).toMatchObject({
      type: "error",
      reason: "error",
      error: { stopReason: "error", errorMessage: "provider disconnected" },
    });
    assert(compiled.finalMessage.stopReason === "error");
  });

  it("returns independent compiled values across repeated compile calls", () => {
    const script = createAssistantStreamScript().text("hello");
    const first = script.compile();
    const second = script.compile();
    const firstText = partialContent(first.events[2])?.[0];
    if (firstText?.type === "text") {
      firstText.text = "mutated";
    }

    expect(partialContent(second.events[2])).toEqual([{ type: "text", text: "hello" }]);
  });

  it("produces a StreamFn whose async events and result match the compiled script", async () => {
    const compiled = createAssistantStreamScript()
      .thinking("plan")
      .text("answer")
      .completes("stop")
      .compile();

    const streamed = await collectStream(compiled.streamFn);

    expect(streamed.events).toEqual(compiled.events);
    expect(streamed.result).toEqual(compiled.finalMessage);
  });

  it("clones each StreamFn invocation so consumers cannot mutate later invocations", async () => {
    const compiled = createAssistantStreamScript().text("hello").compile();
    const first = await collectStream(compiled.streamFn);
    const firstDelta = first.events.find(
      (event): event is Extract<AssistantMessageEvent, { type: "text_delta" }> =>
        event.type === "text_delta",
    );
    if (firstDelta?.partial.content[0]?.type === "text") {
      firstDelta.partial.content[0].text = "mutated";
    }

    expect((await collectStream(compiled.streamFn)).events).toEqual(compiled.events);
  });

  it("derives harness message events from provider stream events", () => {
    const events = createAssistantStreamScript()
      .text("hello", { chunks: ["hel", "lo"] })
      .harnessEvents();

    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "message_update",
      "message_update",
      "message_update",
      "message_update",
      "message_end",
    ]);
    expect(events[2]).toMatchObject({
      type: "message_update",
      message: { content: [{ type: "text", text: "hel" }] },
      assistantMessageEvent: { type: "text_delta", delta: "hel" },
    });
  });

  it("can override top-level harness message snapshots independently from provider partials", () => {
    const topLevelMessage = createAssistantStreamScript().text("top-level").compile().finalMessage;
    const events = createAssistantStreamScript()
      .toolCall("read", {
        id: "call-1",
        arguments: {},
        startBlock: "empty",
        chunks: [],
        end: false,
      })
      .harnessEvents({ messageSnapshots: [topLevelMessage] });

    expect(events[1]).toMatchObject({
      type: "message_update",
      message: { content: [{ type: "text", text: "top-level" }] },
      assistantMessageEvent: { type: "toolcall_start", partial: { content: [] } },
    });
  });

  it("supports final tool-call overrides independent of streamed partial JSON", () => {
    const finalToolCall: ToolCall = {
      type: "toolCall",
      id: "call-1",
      name: "read",
      arguments: { path: "/provider-corrected" },
    };
    const compiled = createAssistantStreamScript()
      .toolCall("read", {
        id: "call-1",
        arguments: { path: "/tmp/a" },
        chunks: ['{"path":"/tmp/a"}'],
      })
      .completes("toolUse", { content: [finalToolCall] })
      .compile();

    expect(compiled.finalMessage.content).toEqual([finalToolCall]);
    expect(
      compiled.events.find(
        (event): event is Extract<AssistantMessageEvent, { type: "toolcall_end" }> =>
          event.type === "toolcall_end",
      )?.toolCall.arguments,
    ).toEqual({ path: "/tmp/a" });
  });
});
