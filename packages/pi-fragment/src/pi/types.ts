import type { InstanceStatus } from "@fragno-dev/workflows/workflow";

import type { TxResult } from "@fragno-dev/db";
import type { WorkflowsFragmentServices } from "@fragno-dev/workflows";

import type {
  AgentEvent,
  AgentMessage,
  AgentOptions,
  AgentTool,
  StreamFn,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

import type { PiLoggerConfig } from "../debug-log";
import type { PiWorkflowsRegistry } from "./workflow/workflow";

export type PiSessionStatus =
  | "active"
  | "paused"
  | "errored"
  | "terminated"
  | "complete"
  | "waiting";

export type PiSession = {
  id: string;
  name: string | null;
  status: PiSessionStatus;
  agent: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PiPromptInput = {
  text: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
};

export type PiSessionCommandPayload =
  | { commandId: string; kind: "prompt"; input: PiPromptInput }
  | { commandId: string; kind: "continue" }
  | { commandId: string; kind: "abort"; reason?: string }
  | { commandId: string; kind: "steer"; input: PiPromptInput }
  | { commandId: string; kind: "followUp"; input: PiPromptInput }
  | { commandId: string; kind: "complete"; reason?: string };

export type PiAgentStateSnapshot = {
  messages: AgentMessage[];
  errorMessage?: string;
};

export type PiSessionDetail = Omit<PiSession, "agent"> & {
  agentName: string;
  workflow: {
    status: PiSessionStatus;
    error?: { name: string; message: string };
    output?: unknown;
  };
  agent: {
    state: PiAgentStateSnapshot;
    events: AgentEvent[];
  };
};

export type PiWorkflowsInstanceStatus = InstanceStatus;

type WorkflowsService = WorkflowsFragmentServices<PiWorkflowsRegistry>;

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
  tools?: readonly string[];
  toolConfig?: unknown;
  maxTraceEvents?: number;
  streamFn?: StreamFn;
  convertToLlm?: AgentOptions["convertToLlm"];
  transformContext?: AgentOptions["transformContext"];
  getApiKey?: AgentOptions["getApiKey"];
  thinkingBudgets?: AgentOptions["thinkingBudgets"];
  maxRetryDelayMs?: AgentOptions["maxRetryDelayMs"];
};

export type PiAgentRegistry = Record<string, PiAgentDefinition>;

export type PiSessionEventStreamItem =
  | { type: "snapshot"; state: PiAgentStateSnapshot }
  | AgentEvent
  | { kind: "abort"; commandId: string; reason?: string }
  | { kind: "steer"; commandId: string; input: PiPromptInput };

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
  /**
   * Optional logging config for internal pi-fragment diagnostics.
   */
  logging?: PiLoggerConfig;
}
