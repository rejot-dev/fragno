import { z } from "zod";
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentState,
  type AgentTool,
} from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import {
  defineWorkflow,
  NonRetryableError,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowsRegistry,
} from "@fragno-dev/workflows";

import { normalizeSteeringMode } from "./mappers";
import type {
  PiAgentDefinition,
  PiAgentRegistry,
  PiSession,
  PiToolFactory,
  PiToolFactoryContext,
  PiToolRegistry,
} from "./types";

export const PI_WORKFLOW_NAME = "agent-loop-workflow";

export type PiAgentLoopParams = {
  sessionId: string;
  agentName: string;
  systemPrompt?: string;
  initialMessages?: AgentMessage[];
};

export type PiWorkflowsOptions = {
  agents: PiAgentRegistry;
  tools: PiToolRegistry;
};

const agentLoopParamsSchema: z.ZodType<PiAgentLoopParams> = z.object({
  sessionId: z.string(),
  agentName: z.string(),
  systemPrompt: z.string().optional(),
  initialMessages: z.array(z.custom<AgentMessage>()).optional(),
});

const userMessageSchema = z.object({
  text: z.string().optional(),
  done: z.boolean().optional(),
  steeringMode: z.enum(["all", "one-at-a-time"]).optional(),
});

const findLastAssistantMessage = (messages: AgentMessage[]): AgentMessage | null => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (
      message &&
      typeof message === "object" &&
      "role" in message &&
      (message as { role?: unknown }).role === "assistant"
    ) {
      return message;
    }
  }
  return null;
};

const buildUserMessage = (text: string): AgentMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: Date.now(),
});

const buildErrorMessage = (model: Model<Api>, error: unknown): AssistantMessage => ({
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

type AgentStreamFn = NonNullable<PiAgentDefinition["streamFn"]>;

type AgentStreamFnArgs = Parameters<AgentStreamFn>;

const wrapStreamFn = (streamFn: PiAgentDefinition["streamFn"]) =>
  streamFn
    ? async (...args: AgentStreamFnArgs) => {
        try {
          return await streamFn(...args);
        } catch (error) {
          const stream = createAssistantMessageEventStream();
          const [model] = args;
          stream.push({ type: "error", reason: "error", error: buildErrorMessage(model, error) });
          return stream;
        }
      }
    : undefined;

const getAssistantErrorMessage = (assistant: AgentMessage | null) => {
  if (!assistant || typeof assistant !== "object") {
    return undefined;
  }
  if ("errorMessage" in assistant && typeof assistant.errorMessage === "string") {
    return assistant.errorMessage;
  }
  return undefined;
};

const buildSessionContext = (options: {
  params: PiAgentLoopParams;
  instanceId: string;
  steeringMode: "all" | "one-at-a-time";
}): PiSession => {
  const now = new Date();
  return {
    id: options.params.sessionId,
    name: null,
    status: "active",
    agent: options.params.agentName,
    workflowInstanceId: options.instanceId,
    steeringMode: options.steeringMode,
    metadata: null,
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
};

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

  const toolConfig = options.agent.toolConfig ?? null;
  const context = {
    session: options.session,
    turnId: options.turnId,
    toolConfig,
    messages: options.messages,
  };

  const resolved: AgentTool[] = [];
  for (const name of toolNames) {
    const tool = await resolveTool(name, options.tools[name], context);
    resolved.push(tool);
  }

  return resolved;
};

const createAgent = async (options: {
  agent: PiAgentDefinition;
  tools: PiToolRegistry;
  params: PiAgentLoopParams;
  messages: AgentMessage[];
  steeringMode: "all" | "one-at-a-time";
  turnId: string;
  instanceId: string;
}): Promise<{ agent: Agent; trace: AgentEvent[]; assistant: AgentMessage | null }> => {
  const session = buildSessionContext({
    params: options.params,
    instanceId: options.instanceId,
    steeringMode: options.steeringMode,
  });

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
  });

  agent.setSteeringMode(options.steeringMode);

  const trace: AgentEvent[] = [];
  const unsubscribe = agent.subscribe((event) => {
    trace.push(event);
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

  await agent.continue();
  unsubscribe();

  const assistant = findLastAssistantMessage(agent.state.messages);
  const assistantError = getAssistantErrorMessage(assistant);
  if (agent.state.error || assistantError) {
    throw new Error(assistantError || agent.state.error || "Agent error");
  }
  return { agent, trace, assistant };
};

const runAgentTurn = async (options: {
  params: PiAgentLoopParams;
  agent: PiAgentDefinition;
  tools: PiToolRegistry;
  messages: AgentMessage[];
  steeringMode: "all" | "one-at-a-time";
  turnId: string;
  instanceId: string;
}) => {
  const result = await createAgent({
    agent: options.agent,
    tools: options.tools,
    params: options.params,
    messages: options.messages,
    steeringMode: options.steeringMode,
    turnId: options.turnId,
    instanceId: options.instanceId,
  });

  return {
    messages: result.agent.state.messages,
    trace: result.trace,
    assistant: result.assistant,
  };
};

const agentLoopWorkflow = (options: PiWorkflowsOptions) =>
  defineWorkflow(
    { name: PI_WORKFLOW_NAME, schema: agentLoopParamsSchema },
    async (event: WorkflowEvent<PiAgentLoopParams>, step: WorkflowStep) => {
      const params = agentLoopParamsSchema.parse(event.payload ?? {});
      const agentDefinition = options.agents[params.agentName];
      if (!agentDefinition) {
        throw new NonRetryableError(`Agent ${params.agentName} not found.`);
      }

      let messages: AgentMessage[] = Array.isArray(params.initialMessages)
        ? params.initialMessages
        : [];
      let turn = 0;

      while (true) {
        const userEvent = await step.waitForEvent(`wait-user-${turn}`, {
          type: "user_message",
          timeout: "1 hour",
        });
        const payload = userMessageSchema.parse(userEvent.payload ?? {});
        const steeringMode = normalizeSteeringMode(payload.steeringMode);
        const turnId = `${event.instanceId}:${turn}`;

        const userResult = await step.do(`user-${turn}`, async () => {
          const userMessage = buildUserMessage(payload.text ?? "");
          return { messages: [...messages, userMessage], user: userMessage };
        });
        messages = userResult.messages;

        const assistantResult = await step.do(
          `assistant-${turn}`,
          { retries: { limit: 1, delay: "10 ms", backoff: "constant" } },
          async () =>
            await runAgentTurn({
              params,
              agent: agentDefinition,
              tools: options.tools,
              messages,
              steeringMode,
              turnId,
              instanceId: event.instanceId,
            }),
        );

        messages = (assistantResult as { messages: AgentMessage[] }).messages;

        if (payload.done) {
          return { messages };
        }

        turn += 1;
      }
    },
  );

export type PiWorkflowsRegistry = {
  agentLoop: ReturnType<typeof agentLoopWorkflow>;
};

export const createPiWorkflows = (options: PiWorkflowsOptions) =>
  ({
    agentLoop: agentLoopWorkflow(options),
  }) satisfies WorkflowsRegistry;
