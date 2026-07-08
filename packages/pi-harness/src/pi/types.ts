import type { StandardSchemaV1 } from "@fragno-dev/core/api";
import type { InstanceStatus, WorkflowRegistryEntry } from "@fragno-dev/workflows/workflow";
import type { Static, TSchema as TypeBoxSchema } from "typebox";

import type { AgentMessage, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

export type PiLoggerConfig = {
  enabled?: boolean;
  level?: "off" | "error" | "warn" | "info" | "debug";
};

export type PiWorkflowStatus = InstanceStatus["status"];

export type PiSession = {
  id: string;
  name: string | null;
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
  | { commandId: string; kind: "abort"; reason?: string }
  | { commandId: string; kind: "steer"; input: PiPromptInput }
  | { commandId: string; kind: "followUp"; input: PiPromptInput }
  | { commandId: string; kind: "nextTurn"; input: PiPromptInput };

export type PiAgentStateSnapshot = {
  messages: AgentMessage[];
  errorMessage?: string;
};

export type PiSessionDetail = Omit<PiSession, "agent"> & {
  agentName: string;
  workflow: {
    status: PiWorkflowStatus;
    error?: { name: string; message: string };
    output?: unknown;
  };
  agent: {
    state: PiAgentStateSnapshot;
    completedStepKeys: string[];
  };
};

export type PiToolResultSchema<TDetails> = StandardSchemaV1<unknown, TDetails> | TypeBoxSchema;

export type PiToolDetailsFromResultSchema<TResultSchema> =
  TResultSchema extends StandardSchemaV1<unknown, infer TDetails>
    ? TDetails
    : TResultSchema extends TypeBoxSchema
      ? Static<TResultSchema>
      : unknown;

export type PiToolDefinition<
  TParameters extends TypeBoxSchema = TypeBoxSchema,
  TDetails = unknown,
  TResultSchema extends PiToolResultSchema<TDetails> | undefined =
    | PiToolResultSchema<TDetails>
    | undefined,
> = AgentTool<TParameters, TDetails> & {
  name: string;
  resultSchema?: TResultSchema;
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

export interface PiFragmentConfig {
  workflows?: WorkflowRegistryEntry[];
  /**
   * Optional logging config for internal pi-harness diagnostics.
   */
  logging?: PiLoggerConfig;
}
