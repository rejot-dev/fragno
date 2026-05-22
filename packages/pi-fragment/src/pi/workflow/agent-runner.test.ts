import { describe, expect, expectTypeOf, test } from "vitest";

import { Type } from "typebox";

import { definePiTool } from "../dsl";
import { createAssistantStreamScript, mockModel } from "../pi-test-utils";
import type { PiAgentDefinition, PiToolRegistry } from "../types";
import { runAgentTurn } from "./agent-runner";
import { collectPiToolCallResults, createPiToolCallAccessor } from "./tool-call-results";

describe("runAgentTurn", () => {
  test("passes per-run afterToolCall hooks to the agent", async () => {
    const { streamFn } = createAssistantStreamScript()
      .toolCall("lookup", { id: "call-1", args: { query: "fragno" } })
      .text("done")
      .build();
    const agent: PiAgentDefinition = {
      name: "default",
      systemPrompt: "You are helpful.",
      model: mockModel,
      tools: ["lookup"],
      streamFn,
    };
    const lookupParameters = Type.Object({ query: Type.String() });
    const lookupTool = definePiTool({
      name: "lookup",
      description: "Lookup a query.",
      label: "Lookup",
      parameters: lookupParameters,
      async execute(_toolCallId, params) {
        expectTypeOf(params).toMatchObjectType<{ query: string }>();
        return {
          content: [{ type: "text", text: "original" }],
          details: { source: "tool" },
        };
      },
    });
    const tools: PiToolRegistry = { lookup: lookupTool };

    const result = await runAgentTurn(
      { mode: "prompt", promptInput: { text: "search" } },
      {
        agent,
        session: { sessionId: "session-1", agentName: "default", workflowName: "test" },
        turn: { tools, messages: [], turnId: "turn-1" },
      },
      {},
      {
        afterToolCall: async () => ({
          content: [{ type: "text", text: "overridden" }],
          details: { source: "hook" },
        }),
      },
    );

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_execution_end",
        toolCallId: "call-1",
        result: expect.objectContaining({
          content: [{ type: "text", text: "overridden" }],
          details: { source: "hook" },
        }),
      }),
    );
  });

  test("stops on matching decision tools and exposes the typed tool result", async () => {
    const { streamFn } = createAssistantStreamScript()
      .toolCall("classify", { id: "call-1", args: { request: "broken" } })
      .build();
    const agent: PiAgentDefinition = {
      name: "default",
      systemPrompt: "You are helpful.",
      model: mockModel,
      tools: ["classify"],
      streamFn,
    };
    const classifyTool = definePiTool({
      name: "classify",
      description: "Classify a request.",
      label: "Classify",
      parameters: Type.Object({ request: Type.String() }),
      async execute() {
        return {
          content: [{ type: "text", text: "classified" }],
          details: { kind: "bug" as const, confidence: 0.91 },
        };
      },
    });
    const tools: PiToolRegistry = { classify: classifyTool };

    const result = await runAgentTurn(
      { mode: "prompt", promptInput: { text: "classify this" } },
      {
        agent,
        session: { sessionId: "session-1", agentName: "default", workflowName: "test" },
        turn: { tools, messages: [], turnId: "turn-1" },
      },
      {},
      { stopOnTools: ["classify"] },
    );

    const toolCalls = collectPiToolCallResults(result.events);
    const toolCall = createPiToolCallAccessor(toolCalls, classifyTool).latest();
    const details = toolCall.details;
    if (!details) {
      throw new Error("Expected tool call details.");
    }
    const kind: "bug" = details.kind;
    expect(kind).toBe("bug");
    expect(toolCall).toMatchObject({
      toolName: "classify",
      args: { request: "broken" },
      details: { kind: "bug", confidence: 0.91 },
      result: { terminate: true },
    });
  });
});
