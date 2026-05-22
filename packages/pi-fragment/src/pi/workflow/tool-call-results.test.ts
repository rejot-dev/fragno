import { describe, expect, it } from "vitest";

import { Type } from "typebox";

import type { AgentEvent, AgentToolResult } from "@earendil-works/pi-agent-core";

import { definePiTool } from "../dsl";
import { collectPiToolCallResults, createPiToolCallAccessor } from "./tool-call-results";

const toolStart = (overrides: {
  toolCallId: string;
  toolName: string;
  args?: unknown;
}): AgentEvent => ({
  type: "tool_execution_start",
  args: overrides.args ?? {},
  ...overrides,
});

const toolEnd = <TDetails>(overrides: {
  toolCallId: string;
  toolName: string;
  result: AgentToolResult<TDetails>;
  isError?: boolean;
}): AgentEvent => ({
  type: "tool_execution_end",
  isError: false,
  ...overrides,
});

const resultWithDetails = <TDetails>(details: TDetails): AgentToolResult<TDetails> => ({
  content: [{ type: "text", text: "done" }],
  details,
});

describe("collectPiToolCallResults", () => {
  it("returns no results when there are no tool calls", () => {
    expect(collectPiToolCallResults([{ type: "agent_start" }])).toEqual([]);
  });

  it("captures a single tool call", () => {
    const results = collectPiToolCallResults([
      toolStart({ toolCallId: "call-1", toolName: "search", args: { query: "fragno" } }),
      toolEnd({
        toolCallId: "call-1",
        toolName: "search",
        result: resultWithDetails({ url: "https://fragno.dev" }),
      }),
    ]);

    expect(results).toEqual([
      {
        toolCallId: "call-1",
        toolName: "search",
        args: { query: "fragno" },
        result: resultWithDetails({ url: "https://fragno.dev" }),
        details: { url: "https://fragno.dev" },
        isError: false,
      },
    ]);
  });

  it("keeps multiple calls to the same tool in completion order", () => {
    const results = collectPiToolCallResults([
      toolStart({ toolCallId: "call-1", toolName: "search", args: { query: "one" } }),
      toolStart({ toolCallId: "call-2", toolName: "search", args: { query: "two" } }),
      toolEnd({ toolCallId: "call-2", toolName: "search", result: resultWithDetails({ rank: 2 }) }),
      toolEnd({ toolCallId: "call-1", toolName: "search", result: resultWithDetails({ rank: 1 }) }),
    ]);

    expect(results.map((result) => result.toolCallId)).toEqual(["call-2", "call-1"]);
    expect(createPiToolCallAccessor(results, "search").first().details).toEqual({ rank: 2 });
    expect(createPiToolCallAccessor(results, "search").latest().details).toEqual({ rank: 1 });
  });

  it("filters accessors by tool name", () => {
    const results = collectPiToolCallResults([
      toolStart({ toolCallId: "call-1", toolName: "search", args: { query: "fragno" } }),
      toolEnd({ toolCallId: "call-1", toolName: "search", result: resultWithDetails({ hits: 1 }) }),
      toolStart({ toolCallId: "call-2", toolName: "classify", args: { text: "bug" } }),
      toolEnd({
        toolCallId: "call-2",
        toolName: "classify",
        result: resultWithDetails({ kind: "bug" }),
      }),
    ]);

    expect(createPiToolCallAccessor(results, "search").all()).toHaveLength(1);
    expect(createPiToolCallAccessor(results, "classify").maybeLatest()?.details).toEqual({
      kind: "bug",
    });
  });

  it("captures errored calls", () => {
    const results = collectPiToolCallResults([
      toolStart({ toolCallId: "call-1", toolName: "search", args: { query: "fragno" } }),
      toolEnd({
        toolCallId: "call-1",
        toolName: "search",
        result: resultWithDetails({ message: "failed" }),
        isError: true,
      }),
    ]);

    expect(results[0]).toMatchObject({ isError: true, details: { message: "failed" } });
  });

  it("returns undefined maybe accessors and clear errors for missing calls", () => {
    const accessor = createPiToolCallAccessor([], "missing");

    expect(accessor.all()).toEqual([]);
    expect(accessor.maybeFirst()).toBeUndefined();
    expect(accessor.maybeLatest()).toBeUndefined();
    expect(() => accessor.first()).toThrow('No tool calls found for tool "missing".');
    expect(() => accessor.latest()).toThrow('No tool calls found for tool "missing".');
  });

  it("types accessors from typed Pi tool definitions", () => {
    const classifyTool = definePiTool({
      name: "classify",
      label: "Classify",
      description: "Classify requests",
      parameters: Type.Object({ request: Type.String() }),
      async execute() {
        return resultWithDetails({ kind: "bug" as const });
      },
    });

    const results = collectPiToolCallResults([
      toolStart({ toolCallId: "call-1", toolName: "classify", args: { request: "broken" } }),
      toolEnd({
        toolCallId: "call-1",
        toolName: "classify",
        result: resultWithDetails({ kind: "bug" as const }),
      }),
    ]);

    const details = createPiToolCallAccessor(results, classifyTool).latest().details;
    if (!details) {
      throw new Error("Expected tool call details.");
    }
    const typedDetails: { kind: "bug" } = details;
    expect(typedDetails).toEqual({ kind: "bug" });
  });
});
