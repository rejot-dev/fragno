import { NonRetryableError } from "@fragno-dev/workflows";

import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentState,
  type AgentTool,
} from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";

import { PiLogger } from "../../debug-log";
import type {
  PiAgentDefinition,
  PiPersistedToolCall,
  PiPersistedToolResult,
  PiPromptInput,
  PiSession,
  PiToolFactory,
  PiToolFactoryContext,
  PiToolReplayContext,
  PiToolRegistry,
} from "../types";
import {
  buildStableToolCallKey,
  buildToolErrorResult,
  clonePersistedToolCall,
  createPersistedToolCall,
  extractToolErrorMessage,
  takeNextReplaySequence,
} from "./tool-journal";

export type AgentLoopParams = {
  sessionId: string;
  agentName: string;
  systemPrompt?: string;
  initialMessages?: AgentMessage[];
};

export type PiAgentRunMode = "prompt" | "continue";

export type PiAgentRunResult = {
  mode: PiAgentRunMode;
  outcome: "completed" | "errored" | "aborted";
  messages: AgentMessage[];
  trace: AgentEvent[];
  assistant: AgentMessage | null;
  errorMessage: string | null;
  toolJournal: PiPersistedToolCall[];
};

// --- Stream wrapping ---

type AgentStreamFn = NonNullable<PiAgentDefinition["streamFn"]>;
type AgentStreamFnArgs = Parameters<AgentStreamFn>;

const isAssistantLikeMessage = (value: unknown): value is AssistantMessage =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (value as { role?: unknown }).role === "assistant" &&
  Array.isArray((value as { content?: unknown }).content) &&
  typeof (value as { stopReason?: unknown }).stopReason === "string";

const buildStreamErrorAssistantMessage = (
  model: AgentStreamFnArgs[0],
  error: unknown,
): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "" }],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "error",
  errorMessage: error instanceof Error ? error.message : String(error),
  timestamp: Date.now(),
});

const wrapStreamFn = (streamFn: PiAgentDefinition["streamFn"]) =>
  streamFn
    ? async (...args: AgentStreamFnArgs) => {
        const [model] = args;
        const stream = await streamFn(...args);
        if (typeof stream !== "object" || stream === null || Array.isArray(stream)) {
          return stream;
        }

        const response = stream as { result?: unknown };
        if (typeof response.result !== "function") {
          return stream;
        }

        const originalResult = response.result.bind(stream) as () => Promise<unknown>;
        let streamResultError: unknown | undefined;
        response.result = async () => {
          if (streamResultError) {
            throw streamResultError;
          }

          try {
            const result = await originalResult();
            if (isAssistantLikeMessage(result)) {
              return result;
            }

            streamResultError = new Error("Stream result is not a valid assistant message.");
          } catch (error) {
            streamResultError = error;
          }

          const errorMessage = buildStreamErrorAssistantMessage(model, streamResultError);
          if ("push" in stream && typeof stream.push === "function") {
            stream.push({ type: "error", reason: "error", error: errorMessage });
          }
          return errorMessage;
        };

        return stream;
      }
    : undefined;

// --- Tool resolution ---

const resolveTool = async (
  name: string,
  factory: PiToolFactory | undefined,
  context: PiToolFactoryContext,
): Promise<AgentTool> => {
  if (!factory) {
    throw new NonRetryableError(`Tool ${name} not found.`);
  }
  if (typeof factory === "function") {
    const tool = await factory(context);
    if (!tool) {
      throw new NonRetryableError(`Tool ${name} returned no definition.`);
    }
    return tool;
  }
  return factory;
};

const wrapToolWithReplay = (options: {
  toolName: string;
  tool: AgentTool;
  context: PiToolFactoryContext;
}): AgentTool => ({
  ...options.tool,
  execute: async (toolCallId, params, signal, onUpdate) => {
    const sessionId = options.context.session.id;
    const toolCallIdValue = String(toolCallId);
    const key = buildStableToolCallKey(sessionId, options.context.turnId, toolCallIdValue);
    const replayEntry = options.context.replay.cache.get(key);

    if (replayEntry) {
      options.context.replay.journal.push(
        clonePersistedToolCall({
          ...replayEntry,
          source: "replay",
          seq: takeNextReplaySequence(options.context.replay),
        }),
      );
      PiLogger.debug("tool replay hit", {
        sessionId,
        turnId: options.context.turnId,
        toolName: replayEntry.toolName,
        key,
      });
      if (replayEntry.isError) {
        throw new Error(extractToolErrorMessage(replayEntry.result));
      }
      return structuredClone(replayEntry.result);
    }

    const argsSnapshot = structuredClone(params) as Record<string, unknown>;
    const recordResult = (result: PiPersistedToolResult, isError: boolean) => {
      const entry = createPersistedToolCall({
        sessionId,
        turnId: options.context.turnId,
        toolCallId: toolCallIdValue,
        toolName: options.toolName,
        args: argsSnapshot,
        result,
        isError,
        source: "executed",
        seq: takeNextReplaySequence(options.context.replay),
      });
      options.context.replay.cache.set(entry.key, clonePersistedToolCall(entry));
      options.context.replay.journal.push(clonePersistedToolCall(entry));
      return entry;
    };

    try {
      const result = await options.tool.execute(toolCallId, params, signal, onUpdate);
      recordResult(structuredClone(result) as PiPersistedToolResult, false);
      return result;
    } catch (error) {
      recordResult(buildToolErrorResult(error), true);
      throw error;
    }
  },
});

const resolveTools = async (options: {
  agent: PiAgentDefinition;
  tools: PiToolRegistry;
  session: PiSession;
  turnId: string;
  messages: AgentMessage[];
  replay: PiToolReplayContext;
}): Promise<AgentTool[]> => {
  const toolNames = options.agent.tools ?? [];
  if (toolNames.length === 0) {
    return [];
  }

  const context: PiToolFactoryContext = {
    session: options.session,
    turnId: options.turnId,
    toolConfig: options.agent.toolConfig ?? null,
    messages: options.messages,
    replay: options.replay,
  };

  const resolved: AgentTool[] = [];
  for (const name of toolNames) {
    const tool = await resolveTool(name, options.tools[name], context);
    resolved.push(wrapToolWithReplay({ toolName: name, tool, context }));
  }

  return resolved;
};

// --- Agent lifecycle ---

const findLastAssistantMessage = (messages: AgentMessage[]): AgentMessage | null =>
  messages.findLast((m) => m.role === "assistant") ?? null;

const getAssistantErrorMessage = (assistant: AgentMessage | null): string | null => {
  if (!assistant || assistant.role !== "assistant") {
    return null;
  }
  return typeof assistant.errorMessage === "string" && assistant.errorMessage.length > 0
    ? assistant.errorMessage
    : null;
};

const getRunOutcome = (
  agent: Agent,
  assistant: AgentMessage | null,
): PiAgentRunResult["outcome"] => {
  if (assistant?.role === "assistant" && assistant.stopReason === "aborted") {
    return "aborted";
  }
  if (typeof agent.state.errorMessage === "string" && agent.state.errorMessage.length > 0) {
    return agent.signal?.aborted ||
      (assistant?.role === "assistant" && assistant.stopReason === "aborted")
      ? "aborted"
      : "errored";
  }
  if (assistant?.role === "assistant" && assistant.stopReason === "error") {
    return "errored";
  }
  return "completed";
};

const normalizeMessagesForContinue = (messages: AgentMessage[]): AgentMessage[] => {
  const finalMessage = messages.at(-1);
  if (
    finalMessage?.role === "assistant" &&
    (finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted") &&
    typeof finalMessage.errorMessage === "string" &&
    finalMessage.errorMessage.length > 0
  ) {
    return messages.slice(0, -1);
  }
  return messages;
};

const createAgent = async (options: {
  agent: PiAgentDefinition;
  tools: PiToolRegistry;
  params: AgentLoopParams;
  messages: AgentMessage[];
  steeringMode: "all" | "one-at-a-time";
  turnId: string;
  replay: PiToolReplayContext;
  onEvent?: (event: AgentEvent) => void;
}): Promise<{
  agent: Agent;
  trace: AgentEvent[];
  assistant: AgentMessage | null;
  toolJournal: PiPersistedToolCall[];
  unsubscribe: () => void;
}> => {
  const now = new Date();
  const session: PiSession = {
    id: options.params.sessionId,
    name: null,
    status: "active",
    agent: options.params.agentName,
    steeringMode: options.steeringMode,
    metadata: null,
    tags: [],
    createdAt: now,
    updatedAt: now,
  };

  const agentTools = await resolveTools({
    agent: options.agent,
    tools: options.tools,
    session,
    turnId: options.turnId,
    messages: options.messages,
    replay: options.replay,
  });

  const initialState: Partial<AgentState> = {
    systemPrompt: options.params.systemPrompt ?? options.agent.systemPrompt,
    model: options.agent.model,
    tools: agentTools,
    messages: options.messages,
  };

  if (options.agent.thinkingLevel) {
    initialState.thinkingLevel = options.agent.thinkingLevel;
  }

  const agent = new Agent({
    initialState,
    streamFn: wrapStreamFn(options.agent.streamFn),
    convertToLlm: options.agent.convertToLlm,
    transformContext: options.agent.transformContext,
    getApiKey: options.agent.getApiKey,
    thinkingBudgets: options.agent.thinkingBudgets,
    maxRetryDelayMs: options.agent.maxRetryDelayMs,
    sessionId: options.params.sessionId,
    toolExecution: "sequential",
  });

  agent.steeringMode = options.steeringMode;

  const trace: AgentEvent[] = [];
  const unsubscribe = agent.subscribe((event) => {
    trace.push(event);
    options.onEvent?.(event);
    if (!options.agent.onEvent) {
      return;
    }
    try {
      options.agent.onEvent(event, { sessionId: options.params.sessionId, turnId: options.turnId });
    } catch (error) {
      console.warn("Agent onEvent hook failed.", {
        error,
        sessionId: options.params.sessionId,
        turnId: options.turnId,
        agent: options.agent.name,
      });
    }
  });

  return {
    agent,
    trace,
    assistant: null,
    toolJournal: options.replay.journal.map(clonePersistedToolCall),
    unsubscribe,
  };
};

const runAgentOperation = async (
  result: Awaited<ReturnType<typeof createAgent>>,
  mode: PiAgentRunMode,
  promptInput: PiPromptInput | undefined,
) => {
  try {
    if (mode === "prompt") {
      if (!promptInput) {
        throw new NonRetryableError("Prompt mode requires prompt input.");
      }
      await result.agent.prompt(promptInput.text, promptInput.images);
    } else {
      await result.agent.continue();
    }
  } finally {
    // The caller owns no subscription handle; createAgent registers exactly one subscription and
    // the Agent API guarantees waitForIdle has settled when prompt/continue resolves.
  }
};

export const runAgentTurn = async (options: {
  mode: PiAgentRunMode;
  promptInput?: PiPromptInput;
  params: AgentLoopParams;
  agent: PiAgentDefinition;
  tools: PiToolRegistry;
  messages: AgentMessage[];
  steeringMode: "all" | "one-at-a-time";
  turnId: string;
  replay: PiToolReplayContext;
  onEvent?: (event: AgentEvent) => void;
  onController?: (controller: {
    abort(): void;
    steer(input: PiPromptInput): void;
    followUp(input: PiPromptInput): void;
  }) => void;
  onControllerClear?: () => void;
}): Promise<PiAgentRunResult> => {
  const messages =
    options.mode === "continue" ? normalizeMessagesForContinue(options.messages) : options.messages;
  const result = await createAgent({ ...options, messages });
  const unsubscribeController = () => options.onControllerClear?.();
  options.onController?.({
    abort: () => result.agent.abort(),
    steer: (input) =>
      result.agent.steer({
        role: "user",
        content: [{ type: "text", text: input.text }, ...(input.images ?? [])],
        timestamp: Date.now(),
      }),
    followUp: (input) =>
      result.agent.followUp({
        role: "user",
        content: [{ type: "text", text: input.text }, ...(input.images ?? [])],
        timestamp: Date.now(),
      }),
  });

  try {
    await runAgentOperation(result, options.mode, options.promptInput);
  } finally {
    unsubscribeController();
    result.unsubscribe();
  }

  const assistant = findLastAssistantMessage(result.agent.state.messages);
  const outcome = getRunOutcome(result.agent, assistant);
  const errorMessage = result.agent.state.errorMessage ?? getAssistantErrorMessage(assistant);

  return {
    mode: options.mode,
    outcome,
    messages: result.agent.state.messages,
    trace: result.trace,
    assistant: outcome === "completed" ? assistant : null,
    errorMessage: errorMessage ?? null,
    toolJournal: options.replay.journal.map(clonePersistedToolCall),
  };
};
