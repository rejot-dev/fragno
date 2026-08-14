import { describe, expect, it } from "vitest";

import { AgentHarness, type AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

import {
  createPiHarnessSessionState,
  restoreWorkflowBackedSession,
} from "../workflows/workflow-agent-harness";
import { createAssistantStreamScript } from "./assistant-stream-script";
import { createModelsForStreamFn } from "./test-models";

const model: Model<Api> = {
  id: "test-model",
  name: "Test model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 2048,
};

const runHarnessScript = async (script: ReturnType<typeof createAssistantStreamScript>) => {
  const compiled = script.compile();
  const models = createModelsForStreamFn(model, compiled.streamFn);
  const restored = restoreWorkflowBackedSession({
    operationId: "assistant-stream-script:prompt",
    state: createPiHarnessSessionState({
      metadata: { id: "assistant-stream-script", createdAt: "2026-08-13T00:00:00.000Z" },
    }),
    previousEmissions: [],
    models,
  });
  const harness = new AgentHarness({
    model,
    models,
    ...restored.options,
  });
  const events: AgentHarnessEvent[] = [];
  const unsubscribe = harness.subscribe((event) => {
    events.push(structuredClone(event));
  });
  try {
    await harness.prompt("run script");
  } finally {
    unsubscribe();
  }
  return { compiled, events };
};

describe("createAssistantStreamScript through AgentHarness", () => {
  it("produces subscribed message snapshots from the real agent loop", async () => {
    const { events } = await runHarnessScript(
      createAssistantStreamScript().text("hello", { chunks: ["hel", "lo"] }),
    );
    const updates = events.filter(
      (event): event is Extract<AgentHarnessEvent, { type: "message_update" }> =>
        event.type === "message_update",
    );

    expect(updates.map((event) => event.assistantMessageEvent.type)).toEqual([
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
    ]);
    expect(updates.map((event) => event.message)).toEqual(
      updates.map((event) =>
        "partial" in event.assistantMessageEvent ? event.assistantMessageEvent.partial : undefined,
      ),
    );
  });

  it("preserves a toolcall_start partial without a tool-call block", async () => {
    const { events } = await runHarnessScript(
      createAssistantStreamScript()
        .toolCall("read", {
          id: "call-1",
          arguments: { path: "/tmp/a" },
          startBlock: "empty",
          chunks: [],
          end: false,
        })
        .completes("stop", { content: [] }),
    );
    const start = events.find(
      (event): event is Extract<AgentHarnessEvent, { type: "message_update" }> =>
        event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_start",
    );

    expect(start).toMatchObject({
      message: { content: [] },
      assistantMessageEvent: { partial: { content: [] } },
    });
  });

  it("preserves text_end against a non-text partial block", async () => {
    const { events } = await runHarnessScript(
      createAssistantStreamScript()
        .startsWith([{ type: "thinking", thinking: "not text" }])
        .text("provider text", {
          contentIndex: 0,
          start: false,
          chunks: [],
          endContent: "provider text",
        })
        .completes("stop", { content: [{ type: "thinking", thinking: "not text" }] }),
    );
    const end = events.find(
      (event): event is Extract<AgentHarnessEvent, { type: "message_update" }> =>
        event.type === "message_update" && event.assistantMessageEvent.type === "text_end",
    );

    expect(end).toMatchObject({
      message: { content: [{ type: "thinking", thinking: "not text" }] },
      assistantMessageEvent: {
        type: "text_end",
        content: "provider text",
        partial: { content: [{ type: "thinking", thinking: "not text" }] },
      },
    });
  });

  it("uses the terminal message as message_end even when it corrects the final partial", async () => {
    const { events, compiled } = await runHarnessScript(
      createAssistantStreamScript()
        .text("partial")
        .completes("stop", { content: [{ type: "text", text: "corrected" }] }),
    );

    expect(events.findLast((event) => event.type === "message_end")).toEqual({
      type: "message_end",
      message: compiled.finalMessage,
    });
  });
});
