import type {
  AgentEvent,
  AgentMessage,
  AgentOptions,
  AgentTool,
  StreamFn,
  ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@mariozechner/pi-ai";
import type { TxResult } from "@fragno-dev/db";
import type {
  InstanceStatus,
  WorkflowsFragmentServices,
  WorkflowsHistory,
  WorkflowsHistoryStep,
} from "@fragno-dev/workflows";
import type { PiLoggerConfig } from "../debug-log";

import type { PiSessionStatus, PiSteeringMode } from "./constants";
import type { PiWorkflowsRegistry } from "./workflow";

export type WorkflowsService = WorkflowsFragmentServices<PiWorkflowsRegistry>;

export type PiSession = {
  id: string;
  name: string | null;
  status: PiSessionStatus;
  agent: string;
  workflowInstanceId: string | null;
  steeringMode: PiSteeringMode;
  metadata: unknown;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
};

export type PiTurnSummary = {
  turn: number;
  assistant: AgentMessage | null;
  summary: string | null;
};

export type PiSessionDetailEvent = {
  id: string;
  type: string;
  payload: unknown | null;
  createdAt: Date;
  deliveredAt: Date | null;
  consumedByStepKey: string | null;
  runNumber?: number | null;
};

export type PiAgentLoopPhase = "waiting-for-user" | "running-agent" | "complete";

export type PiActiveSessionStreamItem = AgentEvent;

export type PiActiveSessionSettledStatus = "waiting-for-user" | "complete" | "errored";

export type PiActiveSessionUpdate =
  | {
      type: "event";
      turn: number;
      event: PiActiveSessionStreamItem;
    }
  | {
      type: "settled";
      turn: number;
      status: PiActiveSessionSettledStatus;
    };

export type PiActiveSessionSubscriber = (update: PiActiveSessionUpdate) => void;

export type PiActiveSessionState = {
  subscribe: (listener: PiActiveSessionSubscriber) => () => void;
  publishEvent: (turn: number, event: PiActiveSessionStreamItem) => void;
  settleTurn: (turn: number, status: PiActiveSessionSettledStatus) => void;
  replayTurn: (turn: number) => PiActiveSessionUpdate[];
  listenerCount: () => number;
};

export type PiAgentLoopWaitingFor =
  | {
      type: "user_message";
      turn: number;
      stepKey: string;
      timeoutMs: number | null;
    }
  | {
      type: "assistant";
      turn: number;
      stepKey: string;
    }
  | null;

export type PiAgentLoopSerializableState = {
  messages: AgentMessage[];
  events: PiSessionDetailEvent[];
  trace: AgentEvent[];
  summaries: PiTurnSummary[];
  turn: number;
  phase: PiAgentLoopPhase;
  waitingFor: PiAgentLoopWaitingFor;
};

export type PiSessionWorkflowStatus = {
  status: PiSessionStatus;
  error?: { name: string; message: string };
  output?: unknown;
};

export type PiSessionDetail = PiSession & {
  workflow: PiSessionWorkflowStatus;
  messages: AgentMessage[];
  events: PiSessionDetailEvent[];
  trace: AgentEvent[];
  summaries: PiTurnSummary[];
  turn: number;
  phase: PiAgentLoopPhase;
  waitingFor: PiAgentLoopWaitingFor;
};

export type PiAgentLoopState = PiAgentLoopSerializableState & {
  activeSession?: PiActiveSessionState;
};

export type PiWorkflowsInstanceStatus = InstanceStatus;
export type PiWorkflowsHistoryPage = WorkflowsHistory;
export type PiWorkflowHistoryStep = WorkflowsHistoryStep;

export type PiWorkflowsService = Pick<
  WorkflowsService,
  | "createInstance"
  | "getInstanceStatus"
  | "getLiveInstanceState"
  | "restoreInstanceState"
  | "sendEvent"
> & {
  getInstanceStatusBatch?: (
    workflowName: string,
    instanceIds: string[],
  ) => TxResult<PiWorkflowsInstanceStatus[], PiWorkflowsInstanceStatus[]>;
};

export type PiAgentDefinition = {
  name: string;
  systemPrompt: string;
  model: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
  toolConfig?: unknown;
  maxTraceEvents?: number;
  streamFn?: StreamFn;
  convertToLlm?: AgentOptions["convertToLlm"];
  transformContext?: AgentOptions["transformContext"];
  getApiKey?: AgentOptions["getApiKey"];
  thinkingBudgets?: AgentOptions["thinkingBudgets"];
  maxRetryDelayMs?: AgentOptions["maxRetryDelayMs"];
  onEvent?: (event: AgentEvent, ctx: { sessionId: string; turnId: string }) => void;
};

export type PiAgentRegistry = Record<string, PiAgentDefinition>;

export const PI_TOOL_JOURNAL_VERSION = 1 as const;

export type PiToolJournalVersion = typeof PI_TOOL_JOURNAL_VERSION;

export type PiToolCallStableKey = string;

export type PiPersistedToolResult = {
  content: Array<TextContent | ImageContent>;
  details: unknown;
};

export type PiPersistedToolCallSource = "executed" | "replay";

export type PiPersistedToolCallV1 = {
  version: PiToolJournalVersion;
  key: PiToolCallStableKey;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: PiPersistedToolResult;
  isError: boolean;
  source: PiPersistedToolCallSource;
  capturedAt: number;
  seq: number;
};

export type PiActiveSessionSystemMessage =
  | {
      layer: "system";
      type: "snapshot";
      turn: number;
      phase: PiAgentLoopPhase;
      waitingFor: PiAgentLoopWaitingFor;
      replayCount: number;
    }
  | {
      layer: "system";
      type: "settled";
      turn: number;
      status: PiActiveSessionSettledStatus;
    }
  | {
      layer: "system";
      type: "inactive";
      reason: "session-complete" | "session-idle";
      turn: number;
      phase: PiAgentLoopPhase;
      waitingFor: PiAgentLoopWaitingFor;
    };

export type PiActiveSessionProtocolMessage =
  | PiActiveSessionSystemMessage
  | {
      layer: "pi";
      type: "event";
      turn: number;
      source: "replay" | "live";
      event: PiActiveSessionStreamItem;
    };

export type PiPersistedToolCall = PiPersistedToolCallV1;

export type PiToolReplayCache = Map<PiToolCallStableKey, PiPersistedToolCall>;

export type PiToolSideEffectReducerContext = {
  key: PiToolCallStableKey;
  sessionId: string;
  turnId: string;
};

export type PiToolSideEffectReducer = (
  state: unknown,
  entry: PiPersistedToolCall,
  ctx: PiToolSideEffectReducerContext,
) => unknown;

export type PiToolSideEffectReducerRegistry = Record<string, PiToolSideEffectReducer>;

export type PiToolReplayContext = {
  cache: PiToolReplayCache;
  journal: PiPersistedToolCall[];
  sideEffects: Record<string, unknown>;
};

export type PiToolFactoryContext = {
  session: PiSession;
  turnId: string;
  toolConfig: unknown;
  messages: AgentMessage[];
  replay: PiToolReplayContext;
};

export type PiToolFactory =
  | AgentTool
  | ((ctx: PiToolFactoryContext) => AgentTool | Promise<AgentTool>);

export type PiToolRegistry = Record<string, PiToolFactory>;

export interface PiFragmentConfig {
  agents: PiAgentRegistry;
  tools: PiToolRegistry;
  defaultSteeringMode?: PiSteeringMode;
  toolSideEffectReducers?: PiToolSideEffectReducerRegistry;
  /**
   * Optional logging config for internal pi-fragment diagnostics.
   */
  logging?: PiLoggerConfig;
}
