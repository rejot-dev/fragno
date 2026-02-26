import type {
  AgentEvent,
  AgentMessage,
  AgentOptions,
  AgentTool,
  StreamFn,
  ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { InstantiatedFragmentFromDefinition } from "@fragno-dev/core";
import type { TxResult } from "@fragno-dev/db";
import type {
  InstanceStatus,
  WorkflowsHistory,
  WorkflowsHistoryStep,
  workflowsFragmentDefinition,
} from "@fragno-dev/workflows";

import type { PiSessionStatus, PiSteeringMode } from "./constants";

export type WorkflowsService = InstantiatedFragmentFromDefinition<
  typeof workflowsFragmentDefinition
>["services"];

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

export type PiWorkflowsInstanceStatus = InstanceStatus;
export type PiWorkflowsHistoryPage = WorkflowsHistory;
export type PiWorkflowHistoryStep = WorkflowsHistoryStep;

export type PiWorkflowsService = Pick<
  WorkflowsService,
  "createInstance" | "getInstanceStatus" | "getInstanceRunNumber" | "sendEvent" | "listHistory"
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
}
