import { NonRetryableError } from "@fragno-dev/workflows/workflow";

import {
  Agent,
  type AfterToolCallContext,
  type AfterToolCallResult,
  type AgentEvent,
  type AgentMessage,
  type AgentState,
  type AgentTool,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import type { StopReason } from "@earendil-works/pi-ai";

import type {
  PiAgentDefinition,
  PiPromptInput,
  PiSession,
  PiToolContext,
  PiToolRegistry,
} from "../types";

export type AgentLoopParams = {
  sessionId: string;
  agentName: string;
  systemPrompt?: string;
  initialMessages?: AgentMessage[];
};

export type PiAgentRunMode = "prompt" | "continue";

export type PiAgentTurnController = {
  abort(): void;
  steer(input: PiPromptInput): void;
  followUp(input: PiPromptInput): void;
};

export type PiAgentTurnOperation = {
  mode: PiAgentRunMode;
  promptInput?: PiPromptInput;
};

export type PiAgentTurnLifecycle = {
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  onController?: (controller: PiAgentTurnController) => void;
};

export type PiAgentTurnBehavior = {
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
  stopOnTools?: string[];
  toolExecution?: ToolExecutionMode;
};

export type PiAgentTurnOptions = {
  operation: PiAgentTurnOperation;
  session: AgentTurnSessionContext;
  agent: PiAgentDefinition;
  turn: AgentTurnContext;
  lifecycle?: PiAgentTurnLifecycle;
};

export type PiAgentRunResult = {
  stopReason: StopReason;
  messages: AgentMessage[];
  events: AgentEvent[];
  errorMessage: string | null;
};

export type PiAgentTurnRestoreResult =
  | {
      type: "run";
      operation: PiAgentTurnOperation;
      messages: AgentMessage[];
      events: AgentEvent[];
    }
  | {
      type: "finish";
      stopReason: StopReason;
      messages: AgentMessage[];
      events: AgentEvent[];
      errorMessage: string | null;
    };

export type AgentTurnSessionContext = {
  sessionId: string;
  agentName: string;
  workflowName: string;
  systemPrompt?: string;
};

export type AgentTurnContext = {
  tools: PiToolRegistry;
  messages: AgentMessage[];
  turnId: string;
};

// Tool calls are only safe to restore once their matching tool-result messages were emitted.
// If a crash happens after the assistant requested tools but before every result reached
// `message_end`, replay from before that assistant message so the whole tool batch runs again.
const rollbackIncompleteToolTurn = (options: {
  baseMessageCount: number;
  messages: AgentMessage[];
}) => {
  for (let index = options.baseMessageCount; index < options.messages.length; index += 1) {
    const message = options.messages[index];
    if (message.role !== "assistant") {
      continue;
    }

    const callIds = message.content.flatMap((content) =>
      content.type === "toolCall" ? [content.id] : [],
    );
    if (callIds.length === 0) {
      continue;
    }

    const resultIds = new Set<string>();
    for (let resultIndex = index + 1; resultIndex < options.messages.length; resultIndex += 1) {
      const result = options.messages[resultIndex];
      if (result.role !== "toolResult") {
        break;
      }
      resultIds.add(result.toolCallId);
    }

    if (callIds.some((id) => !resultIds.has(id))) {
      return options.messages.slice(0, index);
    }
  }
  return options.messages;
};

export const restoreAgentTurnFromEvents = (input: {
  baseMessages: AgentMessage[];
  operation: PiAgentTurnOperation;
  events: AgentEvent[];
}): PiAgentTurnRestoreResult => {
  const messages = [...input.baseMessages];
  const messageStartEventIndexes: number[] = [];
  const messageEndEventIndexes: number[] = [];
  let currentMessageStartIndex: number | null = null;
  let danglingMessageStartIndex: number | null = null;
  let sawAgentEnd = false;

  // Only `message_end` commits a message to Agent state. `message_start` is still useful
  // as a rollback boundary, because partial updates after it are UI-only and should be dropped.
  input.events.forEach((event, index) => {
    if (event.type === "message_start") {
      currentMessageStartIndex = index;
      danglingMessageStartIndex = index;
    }
    if (event.type === "message_end") {
      messages.push(event.message);
      messageStartEventIndexes.push(currentMessageStartIndex ?? index);
      messageEndEventIndexes.push(index);
      currentMessageStartIndex = null;
      danglingMessageStartIndex = null;
    }
    if (event.type === "agent_end") {
      sawAgentEnd = true;
    }
  });

  const toolSafeMessages = rollbackIncompleteToolTurn({
    baseMessageCount: input.baseMessages.length,
    messages,
  });
  const restoredMessages = toolSafeMessages;
  const restoredMessageCount = restoredMessages.length - input.baseMessages.length;
  if (
    input.operation.mode === "prompt" &&
    restoredMessageCount > 0 &&
    restoredMessages[input.baseMessages.length]?.role !== "user"
  ) {
    return {
      type: "run",
      operation: input.operation,
      messages: input.baseMessages,
      events: [],
    };
  }

  // Keep events only through the same boundary as the restored messages:
  // - no restored messages: drop all prior attempt events
  // - rolled back a committed message: cut before that message's `message_start`
  // - restored every committed message: keep everything unless there is a dangling
  //   `message_start`, in which case cut before the partial in-progress message.
  const eventCutoffIndex =
    restoredMessageCount === 0
      ? 0
      : restoredMessageCount < messageEndEventIndexes.length
        ? (messageStartEventIndexes[restoredMessageCount] ?? 0)
        : (danglingMessageStartIndex ?? input.events.length);
  const events = input.events.slice(0, eventCutoffIndex);
  const lastMessage = restoredMessages.at(-1);
  const lastAssistant = restoredMessages.findLast(
    (message): message is Extract<AgentMessage, { role: "assistant" }> =>
      message.role === "assistant",
  );
  const errorMessage = lastAssistant?.errorMessage ?? null;
  const stopReason = lastAssistant?.stopReason ?? (errorMessage ? "error" : "stop");
  const restoredNewMessages = restoredMessages.length > input.baseMessages.length;

  if (sawAgentEnd && eventCutoffIndex === input.events.length) {
    return { type: "finish", stopReason, messages: restoredMessages, events, errorMessage };
  }

  if (
    restoredNewMessages &&
    lastMessage?.role === "assistant" &&
    lastMessage.content.every((content) => content.type !== "toolCall")
  ) {
    return { type: "finish", stopReason, messages: restoredMessages, events, errorMessage };
  }
  const operation =
    restoredNewMessages && (lastMessage?.role === "user" || lastMessage?.role === "toolResult")
      ? ({ mode: "continue" } satisfies PiAgentTurnOperation)
      : input.operation;

  return { type: "run", operation, messages: restoredMessages, events };
};

const resolveTools = async (options: {
  agent: PiAgentDefinition;
  tools: PiToolRegistry;
  session: PiSession;
  turnId: string;
  messages: AgentMessage[];
}): Promise<AgentTool[]> => {
  if (!options.agent.tools?.length) {
    return [];
  }

  const context: PiToolContext = {
    session: options.session,
    turnId: options.turnId,
    toolConfig: options.agent.toolConfig ?? null,
    messages: options.messages,
  };

  return Promise.all(
    options.agent.tools.map(async (name) => {
      const factory = options.tools[name];
      if (!factory) {
        throw new NonRetryableError(`Tool '${name}' not found.`);
      }

      if (typeof factory !== "function") {
        return factory;
      }

      const tool = await factory(context);
      if (!tool) {
        throw new NonRetryableError(`Tool '${name}' returned no definition.`);
      }
      return tool;
    }),
  );
};

// --- Agent lifecycle ---

const createAgentTurnRuntime = async (
  agentDefinition: PiAgentDefinition,
  sessionContext: AgentTurnSessionContext,
  turnContext: AgentTurnContext,
  behavior: PiAgentTurnBehavior = {},
): Promise<Agent> => {
  const {
    systemPrompt,
    model,
    thinkingLevel,
    streamFn,
    convertToLlm,
    transformContext,
    getApiKey,
    thinkingBudgets,
    maxRetryDelayMs,
  } = agentDefinition;
  const now = new Date();
  const session: PiSession = {
    id: sessionContext.sessionId,
    name: null,
    status: "active",
    agent: sessionContext.agentName,
    workflowName: sessionContext.workflowName,
    createdAt: now,
    updatedAt: now,
  };

  const afterToolCall: PiAgentTurnBehavior["afterToolCall"] = async (context, signal) => {
    const result = await behavior.afterToolCall?.(context, signal);
    if (!behavior.stopOnTools?.includes(context.toolCall.name)) {
      return result;
    }
    return { ...result, terminate: true };
  };

  return new Agent({
    initialState: {
      systemPrompt: sessionContext.systemPrompt ?? systemPrompt,
      model,
      tools: await resolveTools({
        agent: agentDefinition,
        tools: turnContext.tools,
        session,
        turnId: turnContext.turnId,
        messages: turnContext.messages,
      }),
      messages: turnContext.messages,
      ...(thinkingLevel ? { thinkingLevel } : {}),
    } satisfies Partial<AgentState>,
    streamFn,
    convertToLlm,
    transformContext,
    getApiKey,
    thinkingBudgets,
    maxRetryDelayMs,
    sessionId: sessionContext.sessionId,
    beforeToolCall: behavior.beforeToolCall,
    afterToolCall,
    toolExecution: behavior.toolExecution ?? (behavior.stopOnTools ? "sequential" : undefined),
  });
};

export const runAgentTurn = async (
  operation: PiAgentTurnOperation,
  runtime: {
    agent: PiAgentDefinition;
    session: AgentTurnSessionContext;
    turn: AgentTurnContext;
  },
  lifecycle: PiAgentTurnLifecycle = {},
  behavior: PiAgentTurnBehavior = {},
): Promise<PiAgentRunResult> => {
  const agent = await createAgentTurnRuntime(
    runtime.agent,
    runtime.session,
    runtime.turn,
    behavior,
  );
  const events: AgentEvent[] = [];
  const pendingEventHandlers: Promise<unknown>[] = [];
  const unsubscribe = agent.subscribe((event) => {
    events.push(event);
    pendingEventHandlers.push(Promise.resolve(lifecycle.onEvent?.(event)));
  });

  lifecycle.onController?.({
    abort: () => agent.abort(),
    steer: (input) =>
      agent.steer({
        role: "user",
        content: [{ type: "text", text: input.text }, ...(input.images ?? [])],
        timestamp: Date.now(),
      }),
    followUp: (input) =>
      agent.followUp({
        role: "user",
        content: [{ type: "text", text: input.text }, ...(input.images ?? [])],
        timestamp: Date.now(),
      }),
  });

  try {
    switch (operation.mode) {
      case "prompt":
        if (!operation.promptInput) {
          throw new NonRetryableError("Prompt mode requires prompt input.");
        }
        await agent.prompt(operation.promptInput.text, operation.promptInput.images);
        break;
      case "continue":
        await agent.continue();
        break;
    }
    await Promise.all(pendingEventHandlers);
  } finally {
    unsubscribe();
  }

  const assistant = agent.state.messages.findLast((message) => message.role === "assistant");
  const errorMessage = agent.state.errorMessage || assistant?.errorMessage || null;
  const stopReason: StopReason = assistant?.stopReason ?? (errorMessage ? "error" : "stop");

  return {
    stopReason,
    messages: agent.state.messages,
    events,
    errorMessage,
  };
};
