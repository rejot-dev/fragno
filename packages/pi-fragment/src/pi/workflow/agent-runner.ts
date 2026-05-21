import { NonRetryableError } from "@fragno-dev/workflows/workflow";

import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentState,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import type { StopReason } from "@earendil-works/pi-ai";

import type {
  PiAgentDefinition,
  PiPromptInput,
  PiSession,
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

export type AgentTurnSessionContext = {
  sessionId: string;
  agentName: string;
  systemPrompt?: string;
};

export type AgentTurnContext = {
  tools: PiToolRegistry;
  messages: AgentMessage[];
  turnId: string;
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

  const context: PiToolFactoryContext = {
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
    createdAt: now,
    updatedAt: now,
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
): Promise<PiAgentRunResult> => {
  const agent = await createAgentTurnRuntime(runtime.agent, runtime.session, runtime.turn);
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
