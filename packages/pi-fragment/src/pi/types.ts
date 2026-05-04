import type { TxResult } from "@fragno-dev/db";
import type {
  InstanceStatus,
  WorkflowsFragmentServices,
  WorkflowsHistory,
  WorkflowsHistoryStep,
} from "@fragno-dev/workflows";

import type {
  AgentEvent,
  AgentMessage,
  AgentOptions,
  AgentTool,
  StreamFn,
  ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";

import type { PiLoggerConfig } from "../debug-log";
import type { PiSessionStatus, PiSteeringMode } from "./constants";
import type { PiWorkflowsRegistry } from "./workflow/workflow";

export type WorkflowsService = WorkflowsFragmentServices<PiWorkflowsRegistry>;

export type PiSession = {
  id: string;
  name: string | null;
  status: PiSessionStatus;
  agent: string;
  steeringMode: PiSteeringMode;
  metadata: unknown;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
};

export type PiSessionCommandId = string;
export type PiSessionCommandType =
  | "prompt"
  | "continue"
  | "abort"
  | "steer"
  | "followUp"
  | "complete";

export type PiPromptInput = {
  text: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
};

export type PiSessionCommandPayload =
  | { commandId: PiSessionCommandId; kind: "prompt"; input: PiPromptInput }
  | { commandId: PiSessionCommandId; kind: "continue" }
  | { commandId: PiSessionCommandId; kind: "abort"; reason?: string }
  | { commandId: PiSessionCommandId; kind: "steer"; input: PiPromptInput }
  | { commandId: PiSessionCommandId; kind: "followUp"; input: PiPromptInput }
  | { commandId: PiSessionCommandId; kind: "complete"; reason?: string };

export type PiTurnStatus = "idle" | "running" | "waiting-to-continue" | "aborted" | "completed";
export type PiTurnOperationKind = "prompt" | "continue" | "abort" | "steer" | "followUp";
export type PiTurnOperationOutcome = "completed" | "errored" | "aborted";

export type PiTurnOperationRecord = {
  commandId: PiSessionCommandId;
  turn: number;
  operationIndex: number;
  kind: PiTurnOperationKind;
  stepKey: string;
  outcome: PiTurnOperationOutcome;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

export type PiTurnSummary = {
  turn: number;
  status: PiTurnStatus;
  assistant: AgentMessage | null;
  summary: string | null;
  operations: PiTurnOperationRecord[];
};

export type PiSessionCommandRecord = {
  commandId: PiSessionCommandId;
  kind: PiSessionCommandType;
  turn: number | null;
  stepKey: string | null;
  commandStatus: "accepted" | "applied" | "rejected";
  rejectionReason: string | null;
  createdAt: Date;
  consumedAt: Date | null;
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

export type PiAgentLoopPhase = "waiting-for-command" | "running-agent" | "complete";

export type PiActiveSessionStreamItem = AgentEvent;

export type PiActiveSessionSettledStatus = "waiting-for-command" | "complete" | "errored";

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

export type PiActiveSessionReplayBufferEntry = {
  turn: number;
  updates: PiActiveSessionUpdate[];
};

export type PiActiveSessionReplayBuffer = PiActiveSessionReplayBufferEntry[];

export type PiLiveOperationController = {
  turn: number;
  operation: "prompt" | "continue";
  stepKey: string;
  abort(): void;
  steer(input: PiPromptInput): void;
  followUp(input: PiPromptInput): void;
};

export type PiLiveInjectionRecord = {
  commandId: PiSessionCommandId;
  commandKind: Extract<PiSessionCommandType, "abort" | "steer" | "followUp">;
  attempted: boolean;
  controllerPresent: boolean;
  injected: boolean;
  turn: number | null;
  stepKey: string | null;
  createdAt: Date;
};

export type PiActiveSessionState = {
  subscribe: (listener: PiActiveSessionSubscriber) => () => void;
  publishEvent: (turn: number, event: PiActiveSessionStreamItem) => void;
  settleTurn: (turn: number, status: PiActiveSessionSettledStatus) => void;
  replayTurn: (turn: number) => PiActiveSessionUpdate[];
  exportReplayBuffer: () => PiActiveSessionReplayBuffer;
  importReplayBuffer: (buffer: PiActiveSessionReplayBuffer) => void;
  listenerCount: () => number;
  registerLiveController: (controller: PiLiveOperationController) => void;
  clearLiveController: (stepKey: string) => void;
  getLiveController: () => PiLiveOperationController | null;
  recordLiveInjection: (
    commandId: PiSessionCommandId,
    commandKind: Extract<PiSessionCommandType, "abort" | "steer" | "followUp">,
    input?: PiPromptInput,
  ) => PiLiveInjectionRecord;
  getLiveInjection: (commandId: PiSessionCommandId) => PiLiveInjectionRecord | null;
};

export type PiAgentLoopWaitingFor =
  | {
      type: "command";
      turn: number;
      stepKey: string;
      allowedCommands: PiSessionCommandType[];
      timeoutMs: number | null;
    }
  | {
      type: "agent" | "assistant";
      turn: number;
      operation?: "prompt" | "continue";
      stepKey: string;
    }
  | null;

export type PiSessionDetailProjection = {
  messages: AgentMessage[];
  events: PiSessionDetailEvent[];
  trace: AgentEvent[];
  turns: PiTurnSummary[];
  commandHistory: PiSessionCommandRecord[];
};

export type PiAgentLoopLiveState = {
  turn: number;
  phase: PiAgentLoopPhase;
  waitingFor: PiAgentLoopWaitingFor;
};

export type PiAgentLoopSerializableState = PiSessionDetailProjection & PiAgentLoopLiveState;

export type PiAgentLoopPersistedState = PiAgentLoopLiveState & {
  activeSessionUpdatesByTurn: PiActiveSessionReplayBuffer;
};

export type PiSessionWorkflowStatus = {
  status: PiSessionStatus;
  error?: { name: string; message: string };
  output?: unknown;
};

export type PiSessionDetail = PiSession & {
  workflow: PiSessionWorkflowStatus;
  messages: AgentMessage[];
  /** @deprecated commandHistory is the command-oriented replacement. */
  events: PiSessionDetailEvent[];
  trace: AgentEvent[];
  turns: PiTurnSummary[];
  commandHistory?: PiSessionCommandRecord[];
  turn: number;
  phase: PiAgentLoopPhase;
  waitingFor: PiAgentLoopWaitingFor;
};

export type PiAgentLoopState = PiAgentLoopPersistedState & {
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
  | "listHistory"
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

export type PiToolFactoryContext = {
  session: PiSession;
  turnId: string;
  toolConfig: unknown;
  messages: AgentMessage[];
};

export type PiToolFactory =
  | AgentTool
  | ((ctx: PiToolFactoryContext) => AgentTool | Promise<AgentTool>);

export type PiToolRegistry = Record<string, PiToolFactory>;

export interface PiFragmentConfig {
  agents: PiAgentRegistry;
  tools: PiToolRegistry;
  defaultSteeringMode?: PiSteeringMode;
  /**
   * Optional logging config for internal pi-fragment diagnostics.
   */
  logging?: PiLoggerConfig;
}
