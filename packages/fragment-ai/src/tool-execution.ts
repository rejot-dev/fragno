import type { ToolResultMessage } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
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
  tools: Array<AiToolDefinition | AgentTool<unknown, unknown>>;
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

type NormalizedToolResult = {
  output: unknown;
  isError: boolean;
  details: unknown;
  content?: ToolResultMessage["content"];
};

type ToolTextContent = ToolResultMessage["content"][number];

const isTextContent = (value: unknown): value is ToolTextContent =>
  !!value &&
  typeof value === "object" &&
  "type" in value &&
  (value as { type?: unknown }).type === "text" &&
  "text" in value &&
  typeof (value as { text?: unknown }).text === "string";

const isAgentToolDefinition = (
  tool: AiToolDefinition | AgentTool<unknown, unknown>,
): tool is AgentTool<unknown, unknown> => {
  if ("parameters" in tool) {
    return true;
  }
  return typeof tool.execute === "function" && tool.execute.length >= 2;
};

const normalizeToolResult = (value: unknown): NormalizedToolResult => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const maybeResult = value as {
      output?: unknown;
      isError?: unknown;
      details?: unknown;
      content?: unknown;
    };
    const content = Array.isArray(maybeResult.content)
      ? maybeResult.content.filter(isTextContent)
      : undefined;
    const hasResultFields =
      "output" in maybeResult || "isError" in maybeResult || "details" in maybeResult;

    if (hasResultFields || (content && content.length > 0)) {
      return {
        output:
          "output" in maybeResult
            ? maybeResult.output
            : "details" in maybeResult
              ? maybeResult.details
              : value,
        isError: Boolean(maybeResult.isError),
        details: "details" in maybeResult ? maybeResult.details : undefined,
        ...(content && content.length > 0 ? { content } : {}),
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
  content,
  details,
}: {
  toolCallId: string;
  toolName: string;
  output: unknown;
  isError: boolean;
  content?: ToolResultMessage["content"];
  details?: unknown;
}): ToolResultMessage => {
  const fallbackContent: ToolResultMessage["content"] = [
    { type: "text", text: formatToolResultText(output, isError) },
  ];
  const resolvedContent = content && content.length > 0 ? content : fallbackContent;
  const resolvedDetails = details ?? output;
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: resolvedContent,
    ...(resolvedDetails !== undefined ? { details: resolvedDetails } : {}),
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
    let details: unknown = undefined;
    let content: ToolResultMessage["content"] | undefined = undefined;

    if (tool) {
      try {
        const rawResult = isAgentToolDefinition(tool)
          ? await tool.execute(toolCall.id, toolCall.arguments ?? {})
          : await tool.execute({
              threadId,
              runId,
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              args: toolCall.arguments ?? {},
            });
        const normalized = normalizeToolResult(rawResult);
        output = normalized.output;
        isError = normalized.isError;
        details = normalized.details;
        content = normalized.content;
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
      buildToolResultMessage({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        output,
        isError,
        content,
        details,
      }),
    );
  }

  return { executedToolCalls, toolResultMessages };
};
