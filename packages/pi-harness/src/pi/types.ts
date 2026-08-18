import type { StandardSchemaV1 } from "@fragno-dev/core/api";
import type { InstanceStatus, WorkflowRegistryEntry } from "@fragno-dev/workflows/workflow";
import type { Static, TSchema as TypeBoxSchema } from "typebox";
import { z } from "zod";

import type { HookContext } from "@fragno-dev/db";

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import type { PiHarnessFrontendAgentMessage } from "./harness/agent-harness-event-protocol";
import type { PiHarnessOperation } from "./workflows/workflow-agent-harness";

export type PiLoggerConfig = {
  enabled?: boolean;
  level?: "off" | "error" | "warn" | "info" | "debug";
};

export type PiWorkflowStatus = InstanceStatus["status"];

export type PiSessionMetadata = Record<string, unknown>;

export type PiSession = {
  id: string;
  name: string | null;
  metadata: PiSessionMetadata | null;
  workflowName: string;
  createdAt: Date;
  updatedAt: Date;
};

const piSessionWorkflowParamsSchema = z.object({
  metadata: z.record(z.string(), z.unknown()).optional(),
  __piSession: z.object({
    name: z.string().nullable(),
  }),
});

export class PiSessionDataUnavailableError extends Error {
  readonly code = "PI_SESSION_DATA_UNAVAILABLE";

  constructor(
    readonly workflowName: string,
    readonly sessionId: string,
  ) {
    super(`Workflow ${workflowName}/${sessionId} does not contain Pi session data.`);
    this.name = "PiSessionDataUnavailableError";
  }
}

export class PiSessionDataIntegrityError extends Error {
  readonly code = "PI_SESSION_DATA_INTEGRITY_ERROR";

  constructor(
    readonly workflowName: string,
    readonly sessionId: string,
    cause: unknown,
  ) {
    super(`Persisted Pi session data for ${workflowName}/${sessionId} is invalid.`, { cause });
    this.name = "PiSessionDataIntegrityError";
  }
}

export const projectPiSessionFromWorkflowInstance = (instance: {
  id: string;
  workflowName: string;
  params: unknown;
  createdAt: Date;
  updatedAt: Date;
}): PiSession | null => {
  const persistedParams = instance.params;
  if (
    typeof persistedParams !== "object" ||
    persistedParams === null ||
    Array.isArray(persistedParams) ||
    !Object.hasOwn(persistedParams, "__piSession")
  ) {
    return null;
  }

  const params = piSessionWorkflowParamsSchema.safeParse(persistedParams);
  if (!params.success) {
    throw new PiSessionDataIntegrityError(instance.workflowName, instance.id, params.error);
  }

  return {
    id: instance.id,
    name: params.data.__piSession.name,
    metadata: params.data.metadata ?? null,
    workflowName: instance.workflowName,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
};

export type PiOperationDetails = {
  actor: unknown;
  workflowName: string;
  sessionId: string;
  metadata: PiSessionMetadata | null;
  stepName: string;
  operationId: string;
  operation: PiHarnessOperation["kind"];
};

export type PiOperationCompletedHookPayload = PiOperationDetails & {
  /**
   * Model calls exposed by Pi as assistant messages during this operation.
   *
   * Compact operations and tree navigation with summarization are not included yet because Pi
   * does not expose their internal model calls as first-class harness events.
   */
  modelCalls: Array<
    Pick<
      AssistantMessage,
      | "api"
      | "provider"
      | "model"
      | "responseModel"
      | "responseId"
      | "usage"
      | "stopReason"
      | "timestamp"
    >
  >;
  usage: AssistantMessage["usage"];
};

/** Maximum total Base64 characters persisted in one Pi command event. */
export const MAX_PI_COMMAND_IMAGE_DATA_LENGTH = 8 * 1024 * 1024;

export const PI_SESSION_COMMAND_STEP_PREFIX = "command:";

export type PiPromptInput = {
  text: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
};

export type PiCompactCommandOutcome =
  | {
      kind: "compact";
      commandId: string;
      status: "succeeded";
    }
  | {
      kind: "compact";
      commandId: string;
      status: "rejected";
      code: "nothing_to_compact" | "compaction_failed";
      message: string;
    };

export type PiSessionCommandPayload =
  | { commandId: string; kind: "prompt"; input: PiPromptInput }
  | { commandId: string; kind: "skill"; input: { name: string; additionalInstructions?: string } }
  | { commandId: string; kind: "promptFromTemplate"; input: { name: string; args?: string[] } }
  | { commandId: string; kind: "compact"; input: { customInstructions?: string } }
  | { commandId: string; kind: "abort"; reason?: string }
  | { commandId: string; kind: "steer"; input: PiPromptInput }
  | { commandId: string; kind: "followUp"; input: PiPromptInput };

export type PiAgentStateSnapshot = {
  messages: PiHarnessFrontendAgentMessage[];
};

export type PiSessionDetail = PiSession & {
  workflow: {
    status: PiWorkflowStatus;
    error?: { name: string; message: string };
    output?: unknown;
  };
  agent: {
    state: PiAgentStateSnapshot;
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
   * Called through a durable hook after a harness operation commits a terminal outcome.
   *
   * Usage reporting currently excludes compact operations and tree navigation with summarization.
   */
  onOperationCompleted?: (
    payload: PiOperationCompletedHookPayload,
    context: HookContext,
  ) => Promise<void> | void;
  /**
   * Optional logging config for internal pi-harness diagnostics.
   */
  logging?: PiLoggerConfig;
}
