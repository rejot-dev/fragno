import type { InstanceStatus } from "@fragno-dev/workflows/workflow";

import type { TxResult } from "@fragno-dev/db";
import type {
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

export type PiSessionDetailEvent = {
  id: string;
  type: string;
  payload: unknown | null;
  createdAt: Date;
  deliveredAt: Date | null;
  consumedByStepKey: string | null;
};

export type PiAgentLoopPhase = "waiting-for-command" | "running-agent" | "complete";

export type PiAgentStateSnapshot = {
  messages: AgentMessage[];
  errorMessage?: string;
};

export type PiActiveSessionUpdate =
  | {
      type: "event";
      event: AgentEvent;
    }
  | {
      type: "settled";
      state: PiAgentStateSnapshot;
    };

export type PiActiveSessionSubscriber = (update: PiActiveSessionUpdate) => void;

export type PiActiveSessionReplayBuffer = PiActiveSessionUpdate[];

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
  publishEvent: (event: AgentEvent) => void;
  settle: (state: PiAgentStateSnapshot) => void;
  replay: () => PiActiveSessionUpdate[];
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
  events: AgentEvent[];
};

export type PiAgentLoopCursorState = {
  turn: number;
  phase: PiAgentLoopPhase;
  waitingFor: PiAgentLoopWaitingFor;
};

export type PiAgentLoopSerializableState = PiSessionDetailProjection & PiAgentLoopCursorState;

export type PiAgentLoopPersistedState = PiAgentLoopCursorState;

export type PiSessionWorkflowStatus = {
  status: PiSessionStatus;
  error?: { name: string; message: string };
  output?: unknown;
};

export type PiSessionDetail = Omit<PiSession, "agent"> & {
  agentName: string;
  workflow: PiSessionWorkflowStatus;
  agent: {
    state: PiAgentStateSnapshot;
    events: AgentEvent[];
  };
};

export type PiAgentLoopState = PiAgentLoopPersistedState & {
  activeSession?: PiActiveSessionState;
};

export type PiWorkflowsInstanceStatus = InstanceStatus;
export type PiWorkflowsHistoryPage = WorkflowsHistory;
export type PiWorkflowHistoryStep = WorkflowsHistoryStep;

export type PiLiveCommandController = {
  abort(): void;
  steer(input: PiPromptInput): void;
};

export type PiStepEmissionState = {
  events: AgentEvent[];
  controller?: PiLiveCommandController | null;
  onEventHandlers?: Array<(event: PiSessionEventStreamItem) => void | Promise<void>>;
};

export type PiWorkflowsService = Pick<
  WorkflowsService,
  "createInstance" | "getInstanceStatus" | "listHistory" | "sendEvent" | "observeStepEmissions"
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

export type PiSessionEventStreamItem =
  | { type: "snapshot"; state: PiAgentStateSnapshot }
  | AgentEvent
  | { kind: "abort"; commandId: string; reason?: string }
  | { kind: "steer"; commandId: string; input: PiPromptInput };

export type PiActiveSessionProtocolMessage = PiSessionEventStreamItem;

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
