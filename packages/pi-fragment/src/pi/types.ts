import type { StandardSchemaV1 } from "@fragno-dev/core/api";
import type { TSchema as TypeBoxSchema } from "typebox";

import type {
  AgentEvent,
  AgentMessage,
  AgentOptions,
  AgentTool,
  AgentToolResult,
  StreamFn,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

import type { PiLoggerConfig } from "../debug-log";
import type { PiWorkflowDefinition } from "./dsl";
import type { PiAgentSkillSelection, PiSkillRegistrySource } from "./skills";

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
  workflowName: string;
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

export type PiAgentDefinition = {
  name: string;
  systemPrompt: string;
  model: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  tools?: readonly string[];
  skills?: PiAgentSkillSelection;
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

export type PiSessionStepEmissionFrame = {
  kind: "step-emission";
  actor: string;
  stepKey: string;
  epoch: string;
  payload: unknown;
};

export type PiSessionEventStreamItem =
  | { type: "snapshot"; state: PiAgentStateSnapshot }
  | AgentEvent
  | PiSessionStepEmissionFrame
  | { kind: "abort"; commandId: string; reason?: string }
  | { kind: "steer"; commandId: string; input: PiPromptInput };

export type PiToolContext = {
  session: PiSession;
  turnId: string;
  toolConfig: unknown;
  messages: AgentMessage[];
};

export type PiToolResultSchema<TDetails> = StandardSchemaV1<unknown, TDetails> | TypeBoxSchema;

export type PiToolDefinition<
  TParameters extends TypeBoxSchema = TypeBoxSchema,
  TDetails = unknown,
> = AgentTool<TParameters, TDetails> & {
  name: string;
  resultSchema?: PiToolResultSchema<TDetails>;
  handoff?: boolean;
};

export type AnyPiToolDefinition = Omit<AgentTool<TypeBoxSchema, unknown>, "execute"> & {
  name: string;
  resultSchema?: PiToolResultSchema<unknown>;
  handoff?: boolean;
  execute: (
    toolCallId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params: any,
    signal?: AbortSignal,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onUpdate?: (partialResult: AgentToolResult<any>) => void,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => Promise<AgentToolResult<any>>;
};

export type PiTool =
  | AnyPiToolDefinition
  | ((ctx: PiToolContext) => AnyPiToolDefinition | Promise<AnyPiToolDefinition>);

export type PiToolRegistry = Record<string, PiTool>;

export interface PiFragmentConfig {
  agents: PiAgentRegistry;
  tools: PiToolRegistry;
  skills?: PiSkillRegistrySource;
  workflows?: PiWorkflowDefinition[];
  /**
   * Optional logging config for internal pi-fragment diagnostics.
   */
  logging?: PiLoggerConfig;
}
