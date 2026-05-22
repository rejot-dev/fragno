import type { AgentEvent, AgentToolResult } from "@earendil-works/pi-agent-core";

import type { PiToolDefinition } from "../types";

export type PiToolCallResult<TDetails = unknown> = {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: AgentToolResult<TDetails>;
  details: TDetails | undefined;
  isError: boolean;
};

export type PiToolCallAccessor<TDetails = unknown> = {
  all(): PiToolCallResult<TDetails>[];
  first(): PiToolCallResult<TDetails>;
  latest(): PiToolCallResult<TDetails>;
  maybeFirst(): PiToolCallResult<TDetails> | undefined;
  maybeLatest(): PiToolCallResult<TDetails> | undefined;
};

type ToolExecutionStartEvent = Extract<AgentEvent, { type: "tool_execution_start" }>;

type PendingToolCall = Pick<ToolExecutionStartEvent, "toolCallId" | "toolName" | "args">;

export function collectPiToolCallResults(events: readonly AgentEvent[]): PiToolCallResult[] {
  const pendingCalls = new Map<string, PendingToolCall>();
  const results: PiToolCallResult[] = [];

  for (const event of events) {
    if (event.type === "tool_execution_start") {
      pendingCalls.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      });
      continue;
    }

    if (event.type === "tool_execution_end") {
      const startedCall = pendingCalls.get(event.toolCallId);
      results.push({
        toolCallId: event.toolCallId,
        toolName: startedCall?.toolName ?? event.toolName,
        args: startedCall?.args,
        result: event.result,
        details: "details" in event.result ? event.result.details : undefined,
        isError: event.isError,
      });
    }
  }

  return results;
}

export function createPiToolCallAccessor(
  toolCalls: readonly PiToolCallResult[],
  tool: string,
): PiToolCallAccessor<unknown>;
export function createPiToolCallAccessor<TTool extends { name: string }>(
  toolCalls: readonly PiToolCallResult[],
  tool: TTool,
): PiToolCallAccessor<
  TTool extends PiToolDefinition<infer _TParameters, infer TDetails> ? TDetails : unknown
>;
export function createPiToolCallAccessor<TDetails = unknown>(
  toolCalls: readonly PiToolCallResult[],
  tool: string | { name: string },
): PiToolCallAccessor<TDetails> {
  const toolName = typeof tool === "string" ? tool : tool.name;
  const matchingCalls = toolCalls.filter(
    (toolCall): toolCall is PiToolCallResult<TDetails> => toolCall.toolName === toolName,
  );

  return {
    all: () => [...matchingCalls],
    first: () => {
      const firstCall = matchingCalls[0];
      if (!firstCall) {
        throw new Error(`No tool calls found for tool "${toolName}".`);
      }
      return firstCall;
    },
    latest: () => {
      const latestCall = matchingCalls.at(-1);
      if (!latestCall) {
        throw new Error(`No tool calls found for tool "${toolName}".`);
      }
      return latestCall;
    },
    maybeFirst: () => matchingCalls[0],
    maybeLatest: () => matchingCalls.at(-1),
  };
}
