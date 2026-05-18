import { NonRetryableError } from "@fragno-dev/workflows/workflow";

import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentState,
  type AgentTool,
} from "@mariozechner/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent } from "@mariozechner/pi-ai";

import type {
  PiAgentDefinition,
  PiPromptInput,
  PiSession,
  PiToolFactory,
  PiToolFactoryContext,
  PiToolRegistry,
} from "../types";

export type AgentLoopParams = {
  sessionId: string;
  agentName: string;
  systemPrompt?: string;
  initialMessages?: AgentMessage[];
};

export type PiAgentRunMode = "prompt" | "continue";

export type PiAgentRunResult = {
  outcome: "completed" | "errored" | "aborted";
  messages: AgentMessage[];
  events: AgentEvent[];
  errorMessage: string | null;
};

// --- Stream wrapping ---

type AgentStreamFn = NonNullable<PiAgentDefinition["streamFn"]>;
type AgentStreamFnArgs = Parameters<AgentStreamFn>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAssistantLikeMessage = (value: unknown): value is AssistantMessage =>
  isRecord(value) &&
  value["role"] === "assistant" &&
  Array.isArray(value["content"]) &&
  typeof value["stopReason"] === "string";

type AssistantResultStream = AsyncIterable<AssistantMessageEvent> & {
  result: () => Promise<AssistantMessage>;
  push?: (event: AssistantMessageEvent) => void;
};

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

        if (!("result" in stream) || typeof stream.result !== "function") {
          return stream;
        }

        const response: AssistantResultStream = stream;
        const originalResult = response.result.bind(stream);
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
          response.push?.({ type: "error", reason: "error", error: errorMessage });
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

const resolveTools = async (options: {
  agent: PiAgentDefinition;
  tools: PiToolRegistry;
  session: PiSession;
  turnId: string;
  messages: AgentMessage[];
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
  };

  const resolved: AgentTool[] = [];
  for (const name of toolNames) {
    resolved.push(await resolveTool(name, options.tools[name], context));
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
  turnId: string;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}): Promise<{
  agent: Agent;
  events: AgentEvent[];
  unsubscribe: () => void;
  pendingOnEvent: Promise<unknown>[];
}> => {
  const now = new Date();
  const session: PiSession = {
    id: options.params.sessionId,
    name: null,
    status: "active",
    agent: options.params.agentName,
    createdAt: now,
    updatedAt: now,
  };

  const agentTools = await resolveTools({
    agent: options.agent,
    tools: options.tools,
    session,
    turnId: options.turnId,
    messages: options.messages,
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

  const events: AgentEvent[] = [];
  const pendingOnEvent: Promise<unknown>[] = [];
  const unsubscribe = agent.subscribe((event) => {
    events.push(event);
    pendingOnEvent.push(Promise.resolve(options.onEvent?.(event)));
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
    events,
    unsubscribe,
    pendingOnEvent,
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
  turnId: string;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
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
    await Promise.all(result.pendingOnEvent);
  } finally {
    unsubscribeController();
    result.unsubscribe();
  }

  const assistant = findLastAssistantMessage(result.agent.state.messages);
  const outcome = getRunOutcome(result.agent, assistant);
  const errorMessage = result.agent.state.errorMessage ?? getAssistantErrorMessage(assistant);

  return {
    outcome,
    messages: result.agent.state.messages,
    events: result.events,
    errorMessage: errorMessage ?? null,
  };
};
