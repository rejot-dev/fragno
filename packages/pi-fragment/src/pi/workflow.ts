import { z } from "zod";
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentState,
  type AgentTool,
} from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
  defineWorkflow,
  NonRetryableError,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowsRegistry,
} from "@fragno-dev/workflows";

import { PiLogger } from "../debug-log";
import { extractAssistantTextFromMessage, normalizeSteeringMode } from "./mappers";
import {
  PI_TOOL_JOURNAL_VERSION,
  type PiActiveSessionState,
  type PiActiveSessionSubscriber,
  type PiActiveSessionUpdate,
  type PiAgentDefinition,
  type PiAgentRegistry,
  type PiAgentLoopPhase,
  type PiAgentLoopState,
  type PiAgentLoopWaitingFor,
  type PiFragmentConfig,
  type PiPersistedToolCall,
  type PiPersistedToolResult,
  type PiSession,
  type PiSessionDetailEvent,
  type PiToolFactory,
  type PiToolFactoryContext,
  type PiToolReplayContext,
  type PiToolRegistry,
  type PiToolSideEffectReducerRegistry,
  type PiTurnSummary,
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
  toolSideEffectReducers?: PiToolSideEffectReducerRegistry;
  logging?: PiFragmentConfig["logging"];
};

const TOOL_JOURNAL_FIELD = "toolJournal";
const WAIT_FOR_USER_TIMEOUT = "1 hour" as const;
const WAIT_FOR_USER_TIMEOUT_MS = 60 * 60 * 1000;

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const toSerializableValue = (value: unknown): unknown => {
  if (value === undefined) {
    return null;
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      return null;
    }
    return JSON.parse(serialized) as unknown;
  } catch {
    return String(value);
  }
};

const toSerializableRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value) || Array.isArray(value)) {
    return {};
  }
  const serialized = toSerializableValue(value);
  if (!isRecord(serialized) || Array.isArray(serialized)) {
    return {};
  }
  return serialized;
};

const cloneToolContent = (content: unknown): PiPersistedToolResult["content"] => {
  if (!Array.isArray(content)) {
    return [];
  }
  const serialized = toSerializableValue(content);
  if (!Array.isArray(serialized)) {
    return [];
  }
  return serialized as PiPersistedToolResult["content"];
};

const clonePersistedToolCall = (entry: PiPersistedToolCall): PiPersistedToolCall => ({
  ...entry,
  args: toSerializableRecord(entry.args),
  result: {
    content: cloneToolContent(entry.result.content),
    details: toSerializableValue(entry.result.details),
  },
});

const compareToolJournalEntries = (a: PiPersistedToolCall, b: PiPersistedToolCall) => {
  if (a.capturedAt !== b.capturedAt) {
    return a.capturedAt - b.capturedAt;
  }
  return a.seq - b.seq;
};

const buildStableToolCallKey = (options: {
  sessionId: string;
  turnId: string;
  toolCallId: string;
}) => `${options.sessionId}:${options.turnId}:${options.toolCallId}`;

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const buildToolErrorResult = (error: unknown): PiPersistedToolResult => ({
  content: [{ type: "text", text: getErrorMessage(error) }],
  details: {},
});

const extractToolErrorMessage = (result: PiPersistedToolResult): string => {
  for (const block of result.content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return "Tool execution failed";
};

const isToolJournalSource = (value: unknown): value is PiPersistedToolCall["source"] =>
  value === "executed" || value === "replay";

const createPersistedToolCall = (options: {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: PiPersistedToolResult;
  isError: boolean;
  source: PiPersistedToolCall["source"];
  seq: number;
}): PiPersistedToolCall => ({
  version: PI_TOOL_JOURNAL_VERSION,
  key: buildStableToolCallKey({
    sessionId: options.sessionId,
    turnId: options.turnId,
    toolCallId: options.toolCallId,
  }),
  sessionId: options.sessionId,
  turnId: options.turnId,
  toolCallId: options.toolCallId,
  toolName: options.toolName,
  args: options.args,
  result: options.result,
  isError: options.isError,
  source: options.source,
  capturedAt: Date.now(),
  seq: options.seq,
});

const parsePersistedToolCall = (
  value: unknown,
  location: string,
  fallbackSeq: number,
): PiPersistedToolCall => {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new NonRetryableError(`Invalid tool journal entry at ${location}.`);
  }
  const entry = value as {
    version?: unknown;
    source?: unknown;
    result?: unknown;
    capturedAt?: unknown;
    key?: unknown;
    sessionId?: unknown;
    turnId?: unknown;
    toolCallId?: unknown;
    toolName?: unknown;
    args?: unknown;
    isError?: unknown;
    seq?: unknown;
  };

  if (entry.version !== PI_TOOL_JOURNAL_VERSION) {
    throw new NonRetryableError(
      `Unsupported tool journal version at ${location}: ${String(entry.version)}`,
    );
  }

  const source = isToolJournalSource(entry.source) ? entry.source : "executed";
  if (entry.source !== undefined && !isToolJournalSource(entry.source)) {
    throw new NonRetryableError(
      `Invalid tool journal source at ${location}: ${String(entry.source)}`,
    );
  }

  const resultRecord = isRecord(entry.result)
    ? (entry.result as { content?: unknown; details?: unknown })
    : {};
  const capturedAt =
    typeof entry.capturedAt === "number" && Number.isFinite(entry.capturedAt)
      ? entry.capturedAt
      : 0;
  const seq = typeof entry.seq === "number" && Number.isFinite(entry.seq) ? entry.seq : fallbackSeq;

  return {
    version: PI_TOOL_JOURNAL_VERSION,
    key: typeof entry.key === "string" ? entry.key : "",
    sessionId: typeof entry.sessionId === "string" ? entry.sessionId : "",
    turnId: typeof entry.turnId === "string" ? entry.turnId : "",
    toolCallId: typeof entry.toolCallId === "string" ? entry.toolCallId : "",
    toolName: typeof entry.toolName === "string" ? entry.toolName : "",
    args: toSerializableRecord(entry.args),
    result: {
      content: cloneToolContent(resultRecord.content),
      details: toSerializableValue(resultRecord.details ?? {}),
    },
    isError: Boolean(entry.isError),
    source,
    capturedAt,
    seq,
  };
};

const parsePersistedToolJournal = (
  assistantResult: unknown,
  stepName: string,
): PiPersistedToolCall[] => {
  if (!isRecord(assistantResult) || Array.isArray(assistantResult)) {
    throw new NonRetryableError(`Assistant step ${stepName} returned an invalid result object.`);
  }
  if (!(TOOL_JOURNAL_FIELD in assistantResult)) {
    return [];
  }
  const raw = assistantResult[TOOL_JOURNAL_FIELD];
  if (!Array.isArray(raw)) {
    throw new NonRetryableError(`Assistant step ${stepName} contains an invalid tool journal.`);
  }
  return raw.map((entry, index) => parsePersistedToolCall(entry, `${stepName}[${index}]`, index));
};

const hydrateReplayCache = (
  cache: PiToolReplayContext["cache"],
  entries: PiPersistedToolCall[],
): void => {
  const sorted = [...entries].sort(compareToolJournalEntries);
  for (const entry of sorted) {
    if (entry.source === "replay" && cache.has(entry.key)) {
      continue;
    }
    cache.set(entry.key, clonePersistedToolCall(entry));
  }
};

const reduceBashSideEffects = (state: unknown, entry: PiPersistedToolCall): unknown => {
  const details = isRecord(entry.result.details)
    ? (entry.result.details as {
        cwd?: unknown;
        files?: unknown;
        writes?: unknown;
        deletes?: unknown;
        deletedPaths?: unknown;
      })
    : {};
  const base = isRecord(state) ? (state as { cwd?: unknown; files?: unknown }) : {};

  const next = {
    cwd:
      typeof details.cwd === "string" ? details.cwd : typeof base.cwd === "string" ? base.cwd : "/",
    files:
      isRecord(base.files) && !Array.isArray(base.files)
        ? ({ ...(base.files as Record<string, unknown>) } as Record<string, unknown>)
        : ({} as Record<string, unknown>),
  };

  const detailsFiles =
    isRecord(details.files) && !Array.isArray(details.files) ? details.files : null;
  if (detailsFiles) {
    for (const [path, value] of Object.entries(detailsFiles)) {
      next.files[path] = value;
    }
  }

  if (Array.isArray(details.writes)) {
    for (const item of details.writes) {
      if (!isRecord(item)) {
        continue;
      }
      const writeEntry = item as { path?: unknown; content?: unknown };
      const path = typeof writeEntry.path === "string" ? writeEntry.path : null;
      if (!path) {
        continue;
      }
      next.files[path] = typeof writeEntry.content === "string" ? writeEntry.content : "";
    }
  }

  const deletes = Array.isArray(details.deletes)
    ? details.deletes
    : Array.isArray(details.deletedPaths)
      ? details.deletedPaths
      : [];
  for (const path of deletes) {
    if (typeof path === "string") {
      delete next.files[path];
    }
  }

  return next;
};

const buildSideEffectState = (options: {
  cache: PiToolReplayContext["cache"];
  reducers?: PiToolSideEffectReducerRegistry;
}): Record<string, unknown> => {
  const reducers: PiToolSideEffectReducerRegistry = {
    bash: reduceBashSideEffects,
    ...options.reducers,
  };

  const state: Record<string, unknown> = {};
  const journal = [...options.cache.values()].sort(compareToolJournalEntries);

  for (const entry of journal) {
    const reducer = reducers[entry.toolName];
    if (!reducer) {
      continue;
    }

    try {
      state[entry.toolName] = reducer(state[entry.toolName], entry, {
        key: entry.key,
        sessionId: entry.sessionId,
        turnId: entry.turnId,
      });
    } catch (error) {
      throw new NonRetryableError(
        `Tool side-effect reducer failed for ${entry.toolName}: ${getErrorMessage(error)}`,
      );
    }
  }

  return state;
};

const replaySequenceByContext = new WeakMap<PiToolReplayContext, number>();

const takeNextReplaySequence = (replayContext: PiToolReplayContext): number => {
  const current = replaySequenceByContext.get(replayContext) ?? 0;
  replaySequenceByContext.set(replayContext, current + 1);
  return current;
};

const createReplayContext = (options: {
  cache: PiToolReplayContext["cache"];
  reducers?: PiToolSideEffectReducerRegistry;
}): PiToolReplayContext => {
  const localCache: PiToolReplayContext["cache"] = new Map();
  for (const [key, entry] of options.cache.entries()) {
    localCache.set(key, clonePersistedToolCall(entry));
  }

  const replayContext: PiToolReplayContext = {
    cache: localCache,
    journal: [],
    sideEffects: buildSideEffectState({ cache: localCache, reducers: options.reducers }),
  };
  const maxSeq = [...localCache.values()].reduce(
    (max, entry) => (entry.seq > max ? entry.seq : max),
    -1,
  );
  replaySequenceByContext.set(replayContext, maxSeq + 1);
  return replayContext;
};

const getArrayFromResult = <T>(result: unknown, key: string): T[] => {
  if (!isRecord(result)) {
    return [];
  }
  const value = result[key];
  return Array.isArray(value) ? (value as T[]) : [];
};

const getAssistantFromResult = (result: unknown): AgentMessage | null => {
  if (!isRecord(result)) {
    return null;
  }
  const assistant = result["assistant"];
  if (!assistant || typeof assistant !== "object") {
    return null;
  }
  return assistant as AgentMessage;
};

const parseAssistantStepResult = (value: unknown, stepName: string) => {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new NonRetryableError(`Assistant step ${stepName} returned an invalid result.`);
  }
  const result = value as { messages?: unknown };
  const messages = result.messages;
  if (!Array.isArray(messages)) {
    throw new NonRetryableError(`Assistant step ${stepName} is missing messages.`);
  }
  return {
    messages: messages as AgentMessage[],
    trace: getArrayFromResult<AgentEvent>(value, "trace"),
    assistant:
      getAssistantFromResult(value) ?? findLastAssistantMessage(messages as AgentMessage[]),
    toolJournal: parsePersistedToolJournal(value, stepName),
  };
};

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

const buildWaitUserStepKey = (turn: number) => `waitForEvent:wait-user-${turn}`;

const buildAssistantStepKey = (turn: number) => `do:assistant-${turn}`;

const buildWaitingForUser = (turn: number): NonNullable<PiAgentLoopWaitingFor> => ({
  type: "user_message",
  turn,
  stepKey: buildWaitUserStepKey(turn),
  timeoutMs: WAIT_FOR_USER_TIMEOUT_MS,
});

const buildWaitingForAssistant = (turn: number): NonNullable<PiAgentLoopWaitingFor> => ({
  type: "assistant",
  turn,
  stepKey: buildAssistantStepKey(turn),
});

const buildTurnSummary = (turn: number, assistant: AgentMessage | null): PiTurnSummary | null => {
  if (!assistant) {
    return null;
  }
  return {
    turn,
    assistant,
    summary: extractAssistantTextFromMessage(assistant) || null,
  };
};

const coerceEventTimestamp = (value: Date | string | number): Date => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  const coerced = new Date(value);
  if (!Number.isNaN(coerced.getTime())) {
    return coerced;
  }
  return new Date(0);
};

const buildDetailEvent = (options: {
  turn: number;
  event: { type: string; payload: unknown; timestamp: Date | string | number };
}): PiSessionDetailEvent => {
  const timestamp = coerceEventTimestamp(options.event.timestamp);
  return {
    id: `${options.event.type}:${options.turn}:${timestamp.getTime()}`,
    type: options.event.type,
    payload: options.event.payload ?? null,
    createdAt: timestamp,
    deliveredAt: timestamp,
    consumedByStepKey: buildWaitUserStepKey(options.turn),
  };
};

const notifyActiveSessionSubscribers = (
  listeners: Set<PiActiveSessionSubscriber>,
  update: Parameters<PiActiveSessionSubscriber>[0],
) => {
  for (const listener of Array.from(listeners)) {
    try {
      listener(update);
    } catch (error) {
      console.warn("Pi active-session listener failed.", { error, updateType: update.type });
    }
  }
};

const createPiActiveSessionState = (): PiActiveSessionState => {
  const listeners = new Set<PiActiveSessionSubscriber>();
  const updatesByTurn = new Map<number, PiActiveSessionUpdate[]>();

  const appendUpdate = (turn: number, update: PiActiveSessionUpdate) => {
    const existing = updatesByTurn.get(turn) ?? [];
    updatesByTurn.set(turn, [...existing, update]);

    for (const previousTurn of updatesByTurn.keys()) {
      if (previousTurn < turn - 1) {
        updatesByTurn.delete(previousTurn);
      }
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publishEvent(turn, event) {
      const update: PiActiveSessionUpdate = {
        type: "event",
        turn,
        event,
      };
      appendUpdate(turn, update);
      notifyActiveSessionSubscribers(listeners, update);
    },
    settleTurn(turn, status) {
      const update: PiActiveSessionUpdate = {
        type: "settled",
        turn,
        status,
      };
      appendUpdate(turn, update);
      notifyActiveSessionSubscribers(listeners, update);
    },
    replayTurn(turn) {
      return [...(updatesByTurn.get(turn) ?? [])];
    },
    listenerCount: () => listeners.size,
  };
};

const isRunnerSuspendedError = (error: unknown): boolean =>
  error instanceof Error && error.name === "RunnerStepSuspended";

export const createInitialPiAgentLoopState = (messages: AgentMessage[] = []): PiAgentLoopState => ({
  messages,
  events: [],
  trace: [],
  summaries: [],
  turn: 0,
  phase: "waiting-for-user",
  waitingFor: buildWaitingForUser(0),
});

export const ensurePiActiveSessionState = (state: PiAgentLoopState): PiActiveSessionState => {
  if (state.activeSession) {
    return state.activeSession;
  }

  const activeSession = createPiActiveSessionState();
  state.activeSession = activeSession;
  return activeSession;
};

type AgentStreamFn = NonNullable<PiAgentDefinition["streamFn"]>;

type AgentStreamFnArgs = Parameters<AgentStreamFn>;

const isAssistantLikeMessage = (value: unknown): value is AssistantMessage => {
  if (!isRecord(value) || Array.isArray(value)) {
    return false;
  }
  const message = value as { role?: unknown; content?: unknown; stopReason?: unknown };
  return (
    message.role === "assistant" &&
    Array.isArray(message.content) &&
    typeof message.stopReason === "string"
  );
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
        if (!isRecord(stream) || Array.isArray(stream)) {
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

const wrapToolWithReplay = (options: {
  toolName: string;
  tool: AgentTool;
  context: PiToolFactoryContext;
}): AgentTool => ({
  ...options.tool,
  execute: async (toolCallId, params, signal, onUpdate) => {
    const sessionId = options.context.session.id;
    const toolCallIdValue = String(toolCallId);
    const key = buildStableToolCallKey({
      sessionId,
      turnId: options.context.turnId,
      toolCallId: toolCallIdValue,
    });
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
      return {
        content: cloneToolContent(replayEntry.result.content),
        details: toSerializableValue(replayEntry.result.details),
      };
    }

    const argsSnapshot = toSerializableRecord(params);
    try {
      const result = await options.tool.execute(toolCallId, params, signal, onUpdate);
      const entry = createPersistedToolCall({
        sessionId,
        turnId: options.context.turnId,
        toolCallId: toolCallIdValue,
        toolName: options.toolName,
        args: argsSnapshot,
        result: {
          content: cloneToolContent(result.content),
          details: toSerializableValue(result.details),
        },
        isError: false,
        source: "executed",
        seq: takeNextReplaySequence(options.context.replay),
      });
      options.context.replay.cache.set(entry.key, clonePersistedToolCall(entry));
      options.context.replay.journal.push(clonePersistedToolCall(entry));
      return result;
    } catch (error) {
      const entry = createPersistedToolCall({
        sessionId,
        turnId: options.context.turnId,
        toolCallId: toolCallIdValue,
        toolName: options.toolName,
        args: argsSnapshot,
        result: buildToolErrorResult(error),
        isError: true,
        source: "executed",
        seq: takeNextReplaySequence(options.context.replay),
      });
      options.context.replay.cache.set(entry.key, clonePersistedToolCall(entry));
      options.context.replay.journal.push(clonePersistedToolCall(entry));
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

  const toolConfig = options.agent.toolConfig ?? null;
  const context: PiToolFactoryContext = {
    session: options.session,
    turnId: options.turnId,
    toolConfig,
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

const createAgent = async (options: {
  agent: PiAgentDefinition;
  tools: PiToolRegistry;
  params: PiAgentLoopParams;
  messages: AgentMessage[];
  steeringMode: "all" | "one-at-a-time";
  turnId: string;
  instanceId: string;
  replay: PiToolReplayContext;
  onEvent?: (event: AgentEvent) => void;
}): Promise<{
  agent: Agent;
  trace: AgentEvent[];
  assistant: AgentMessage | null;
  toolJournal: PiPersistedToolCall[];
}> => {
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
  });

  agent.setSteeringMode(options.steeringMode);

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

  try {
    await agent.continue();
  } finally {
    unsubscribe();
  }

  const assistant = findLastAssistantMessage(agent.state.messages);
  const assistantError = getAssistantErrorMessage(assistant);
  const stateError = agent.state.error as unknown;
  if (stateError) {
    if (typeof stateError === "object" && stateError !== null && stateError instanceof Error) {
      throw stateError;
    }
    throw new Error(String(stateError));
  }
  if (assistantError) {
    throw new Error(assistantError);
  }
  return {
    agent,
    trace,
    assistant,
    toolJournal: options.replay.journal.map(clonePersistedToolCall),
  };
};

const runAgentTurn = async (options: {
  params: PiAgentLoopParams;
  agent: PiAgentDefinition;
  tools: PiToolRegistry;
  messages: AgentMessage[];
  steeringMode: "all" | "one-at-a-time";
  turnId: string;
  instanceId: string;
  replay: PiToolReplayContext;
  onEvent?: (event: AgentEvent) => void;
}) => {
  const result = await createAgent({
    agent: options.agent,
    tools: options.tools,
    params: options.params,
    messages: options.messages,
    steeringMode: options.steeringMode,
    turnId: options.turnId,
    instanceId: options.instanceId,
    replay: options.replay,
    onEvent: options.onEvent,
  });

  return {
    messages: result.agent.state.messages,
    trace: result.trace,
    assistant: result.assistant,
    toolJournal: result.toolJournal,
  };
};

export const createPiAgentLoopWorkflow = (options: PiWorkflowsOptions) =>
  defineWorkflow(
    {
      name: PI_WORKFLOW_NAME,
      schema: agentLoopParamsSchema,
      initialState: createInitialPiAgentLoopState(),
    },
    async function (event: WorkflowEvent<PiAgentLoopParams>, step: WorkflowStep) {
      const params = agentLoopParamsSchema.parse(event.payload ?? {});
      const agentDefinition = options.agents[params.agentName];
      if (!agentDefinition) {
        throw new NonRetryableError(`Agent ${params.agentName} not found.`);
      }

      let messages: AgentMessage[] = Array.isArray(params.initialMessages)
        ? params.initialMessages
        : [];
      let events: PiSessionDetailEvent[] = [];
      let trace: AgentEvent[] = [];
      let summaries: PiTurnSummary[] = [];
      let turn = 0;
      let phase: PiAgentLoopPhase = "waiting-for-user";
      let waitingFor: PiAgentLoopWaitingFor = buildWaitingForUser(turn);
      const replayCache: PiToolReplayContext["cache"] = new Map();
      const currentState = this?.getState();
      const activeSession = currentState
        ? ensurePiActiveSessionState(currentState)
        : createPiActiveSessionState();
      const emitState = () => {
        const snapshot = {
          messages,
          events,
          trace,
          summaries,
          turn,
          phase,
          waitingFor,
          activeSession,
        } satisfies PiAgentLoopState;
        this?.setState({
          ...snapshot,
        });
      };

      emitState();

      while (true) {
        phase = "waiting-for-user";
        waitingFor = buildWaitingForUser(turn);
        emitState();

        const userEvent = await step.waitForEvent(`wait-user-${turn}`, {
          type: "user_message",
          timeout: WAIT_FOR_USER_TIMEOUT,
        });
        const payload = userMessageSchema.parse(userEvent.payload ?? {});
        const steeringMode = normalizeSteeringMode(payload.steeringMode);
        const turnId = `${event.instanceId}:${turn}`;
        events = [...events, buildDetailEvent({ turn, event: userEvent })];

        const userResult = await step.do(`user-${turn}`, async () => {
          const userMessage = buildUserMessage(payload.text ?? "");
          return { messages: [...messages, userMessage], user: userMessage };
        });
        messages = userResult.messages;
        phase = "running-agent";
        waitingFor = buildWaitingForAssistant(turn);
        emitState();

        const replay = createReplayContext({
          cache: replayCache,
          reducers: options.toolSideEffectReducers,
        });
        const assistantStepName = `assistant-${turn}`;
        const traceLengthBeforeTurn = trace.length;
        let assistantResult: Awaited<ReturnType<typeof runAgentTurn>>;
        try {
          assistantResult = await step.do(
            assistantStepName,
            { retries: { limit: 1, delay: "0 ms", backoff: "constant" } },
            async () =>
              await runAgentTurn({
                params,
                agent: agentDefinition,
                tools: options.tools,
                messages,
                steeringMode,
                turnId,
                instanceId: event.instanceId,
                replay,
                onEvent: (agentEvent) => {
                  trace = [...trace, agentEvent];
                  activeSession.publishEvent(turn, agentEvent);
                  this?.setState({
                    trace,
                    activeSession,
                  });
                },
              }),
          );
        } catch (error) {
          if (!isRunnerSuspendedError(error)) {
            activeSession.settleTurn(turn, "errored");
          }
          throw error;
        }

        const parsedAssistantResult = parseAssistantStepResult(assistantResult, assistantStepName);
        messages = parsedAssistantResult.messages;
        trace = [...trace.slice(0, traceLengthBeforeTurn), ...parsedAssistantResult.trace];
        const summary = buildTurnSummary(turn, parsedAssistantResult.assistant);
        if (summary) {
          summaries = [...summaries, summary];
        }
        hydrateReplayCache(replayCache, parsedAssistantResult.toolJournal);

        if (payload.done) {
          phase = "complete";
          waitingFor = null;
          emitState();
          activeSession.settleTurn(turn, "complete");
          return { messages };
        }

        const settledTurn = turn;
        turn += 1;
        phase = "waiting-for-user";
        waitingFor = buildWaitingForUser(turn);
        emitState();
        activeSession.settleTurn(settledTurn, "waiting-for-user");
      }
    },
  );

export type PiWorkflowsRegistry = {
  agentLoop: ReturnType<typeof createPiAgentLoopWorkflow>;
};

export const createPiWorkflows = (options: PiWorkflowsOptions) => {
  PiLogger.reset();
  if (options.logging) {
    PiLogger.configure(options.logging);
  }

  return {
    agentLoop: createPiAgentLoopWorkflow(options),
  } satisfies WorkflowsRegistry;
};
