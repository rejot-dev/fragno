import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { completeWithPiAi, resolvePiAiToolCalls } from "./pi-ai";
import type { AiToolRegistry, ExecutedToolCall } from "./tool-execution";
import { buildUnsupportedToolCalls, executeToolCalls } from "./tool-execution";

const DEFAULT_MAX_TOOL_ITERATIONS = 3;

export type PiAiToolLoopResult = {
  message: AssistantMessage;
  toolCalls: ExecutedToolCall[];
  error: string | null;
};

export const runPiAiToolLoop = async ({
  model,
  context,
  options,
  toolRegistry,
  threadId,
  runId,
  initialMessage,
}: {
  model: Model<Api>;
  context: Context;
  options: SimpleStreamOptions;
  toolRegistry?: AiToolRegistry;
  threadId: string;
  runId: string;
  initialMessage?: AssistantMessage;
}): Promise<PiAiToolLoopResult> => {
  const executedToolCalls: ExecutedToolCall[] = [];
  let currentMessage =
    initialMessage ?? (await completeWithPiAi(model, context, options as SimpleStreamOptions));
  const maxIterations = toolRegistry?.maxIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  let iteration = 0;

  while (currentMessage.stopReason === "toolUse") {
    const toolCalls = resolvePiAiToolCalls(currentMessage);

    if (toolCalls.length === 0) {
      return {
        message: currentMessage,
        toolCalls: executedToolCalls,
        error: "TOOL_CALL_MISSING",
      };
    }

    if (!toolRegistry || toolRegistry.tools.length === 0) {
      return {
        message: currentMessage,
        toolCalls: buildUnsupportedToolCalls(toolCalls, "TOOL_CALL_UNSUPPORTED"),
        error: "TOOL_CALL_UNSUPPORTED",
      };
    }

    if (iteration >= maxIterations) {
      return {
        message: currentMessage,
        toolCalls: executedToolCalls,
        error: "TOOL_CALL_LOOP_LIMIT",
      };
    }

    context.messages.push(currentMessage);
    const execution = await executeToolCalls({
      toolCalls,
      registry: toolRegistry,
      threadId,
      runId,
    });
    executedToolCalls.push(...execution.executedToolCalls);
    context.messages.push(...execution.toolResultMessages);

    iteration += 1;
    currentMessage = await completeWithPiAi(model, context, options);
  }

  return { message: currentMessage, toolCalls: executedToolCalls, error: null };
};
