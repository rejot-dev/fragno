import type { ToolResultMessage } from "@mariozechner/pi-ai";
import type { AiToolCallStatus } from "./definition";

export type AiToolExecutionContext = {
  threadId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
};

export type AiToolExecutionResult = {
  output: unknown;
  isError?: boolean;
  details?: unknown;
};

export type AiToolDefinition = {
  name: string;
  execute: (
    context: AiToolExecutionContext,
  ) => AiToolExecutionResult | Promise<AiToolExecutionResult | unknown> | unknown;
};

export type AiToolRegistry = {
  tools: AiToolDefinition[];
  maxIterations?: number;
};

export type ExecutedToolCall = {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: AiToolCallStatus;
  output: unknown;
  isError: boolean;
};

type ToolCallInput = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

const normalizeToolResult = (value: unknown) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const maybeResult = value as {
      output?: unknown;
      isError?: unknown;
      details?: unknown;
    };
    if ("output" in maybeResult || "isError" in maybeResult || "details" in maybeResult) {
      return {
        output: "output" in maybeResult ? maybeResult.output : value,
        isError: Boolean(maybeResult.isError),
        details: "details" in maybeResult ? maybeResult.details : undefined,
      };
    }
  }

  return { output: value, isError: false, details: undefined };
};

const formatToolResultText = (output: unknown, isError: boolean) => {
  if (typeof output === "string") {
    return output;
  }

  const fallback = isError ? { error: "TOOL_EXECUTION_FAILED" } : {};
  try {
    return JSON.stringify(output ?? fallback);
  } catch {
    return "TOOL_RESULT_UNSERIALIZABLE";
  }
};

const buildToolResultMessage = ({
  toolCallId,
  toolName,
  output,
  isError,
}: {
  toolCallId: string;
  toolName: string;
  output: unknown;
  isError: boolean;
}): ToolResultMessage => {
  const text = formatToolResultText(output, isError);
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    ...(output !== undefined ? { details: output } : {}),
    isError,
    timestamp: Date.now(),
  };
};

export const buildUnsupportedToolCalls = (
  toolCalls: ToolCallInput[],
  error: string,
): ExecutedToolCall[] =>
  toolCalls.map((toolCall) => ({
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    args: toolCall.arguments ?? {},
    status: "failed",
    output: { error },
    isError: true,
  }));

export const executeToolCalls = async ({
  toolCalls,
  registry,
  threadId,
  runId,
}: {
  toolCalls: ToolCallInput[];
  registry: AiToolRegistry;
  threadId: string;
  runId: string;
}) => {
  const executedToolCalls: ExecutedToolCall[] = [];
  const toolResultMessages: ToolResultMessage[] = [];
  const toolByName = new Map(registry.tools.map((tool) => [tool.name, tool]));

  for (const toolCall of toolCalls) {
    const tool = toolByName.get(toolCall.name);
    let output: unknown = { error: "TOOL_NOT_FOUND" };
    let isError = true;

    if (tool) {
      try {
        const rawResult = await tool.execute({
          threadId,
          runId,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args: toolCall.arguments ?? {},
        });
        const normalized = normalizeToolResult(rawResult);
        output = normalized.output;
        isError = normalized.isError;
      } catch (err) {
        const message = err instanceof Error ? err.message : "TOOL_EXECUTION_FAILED";
        output = { error: message };
        isError = true;
      }
    }

    executedToolCalls.push({
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments ?? {},
      status: isError ? "failed" : "completed",
      output,
      isError,
    });
    toolResultMessages.push(
      buildToolResultMessage({ toolCallId: toolCall.id, toolName: toolCall.name, output, isError }),
    );
  }

  return { executedToolCalls, toolResultMessages };
};
