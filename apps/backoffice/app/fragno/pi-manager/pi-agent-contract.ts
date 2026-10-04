import { z } from "zod";

import type {
  ConversationView,
  Cursor,
  EntryRecord,
  SubmissionRecord,
} from "@earendil-works/pi-durable";

import { backofficeContextScopeSchema } from "@/backoffice-runtime/context";
import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";
import { automationActorsSchema } from "@/fragno/automation/actors";
import { jsonValueSchema } from "@/lib/zod/json-value";

/** One supported chat model whose provider credentials are available to durable Pi. */
export const piAvailableModelSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  label: z.string().min(1),
});
export type PiAvailableModel = z.infer<typeof piAvailableModelSchema>;

/** Stable across local calls and Cloudflare RPC, where custom Error prototypes are not authoritative. */
export class PiConversationViewDamagedError extends Error {
  static readonly code = "PI_CONVERSATION_VIEW_DAMAGED";
  static readonly publicMessage =
    "The Pi conversation state is damaged and cannot be resumed. Export its history and create a replacement session.";

  constructor(sessionId: string, cause: unknown) {
    super(`${PiConversationViewDamagedError.code}:${sessionId}`, { cause });
    this.name = "PiConversationViewDamagedError";
  }

  static is(cause: unknown): cause is Error {
    return (
      cause instanceof Error &&
      (cause.name === "PiConversationViewDamagedError" ||
        cause.message.includes(`${PiConversationViewDamagedError.code}:`))
    );
  }
}

export const piAgentModelSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
});

/** Session choices accepted from callers; an omitted model selects the configured default. */
export const piAgentCreationSchema = z.object({
  name: z.string().nullable(),
  model: piAgentModelSchema.optional(),
  instructions: z.string().default(""),
  billingOrganizationId: z.string().trim().min(1).nullable().default(null),
});

/** Provisioning persists actor provenance and a concrete immutable model selection. */
export const piAgentConfigSchema = piAgentCreationSchema.extend({
  model: piAgentModelSchema,
  scope: backofficeContextScopeSchema,
  sessionId: z.string().min(1),
  actors: automationActorsSchema,
});

/** Directory records share the provisioning contract and use database creation time. */
export const piManagerSessionSchema = piAgentConfigSchema.extend({ createdAt: z.string() });
export type PiManagerSession = z.infer<typeof piManagerSessionSchema>;

/** Initial agent choices are immutable; Pi owns subsequent conversation state. */
export type PiAgentConfig = z.infer<typeof piAgentConfigSchema>;

/** Request IDs deduplicate prompt admission within an agent's root conversation. */
export const piAgentPromptSchema = z.object({
  requestId: z.string().min(1),
  content: z.string().min(1),
  whenBusy: z.enum(["followUp", "steer", "reject"]).default("followUp"),
});

/** Manual compaction accepts no instructions or one explicit summary requirement. */
export const piAgentCompactionSchema = z.object({
  instructions: z.string().trim().min(1).nullable().default(null),
});

export const PI_AGENT_SUBMISSION_WAIT_MAX_MS = 25_000;

/** A bounded wait keeps infrastructure cancellation from leaving an unbounded agent waiter. */
export const piAgentSubmissionWaitRequestSchema = z.object({
  waitMs: z.number().int().min(1).max(PI_AGENT_SUBMISSION_WAIT_MAX_MS),
});
export const piAgentSubmissionWaitSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), submission: z.null() }),
  z.object({ status: z.literal("settled"), submission: z.unknown() }),
]);
export type PiAgentSubmissionWait =
  | { status: "pending"; submission: null }
  | { status: "settled"; submission: SubmissionRecord };

/** Public manual compaction state omits internal durable checkpoints and task inputs. */
export const piAgentCompactionStatusSchema = z.object({
  taskId: z.number().int().positive(),
  status: z.enum(["running", "completed", "unchanged", "failed"]),
  message: z.string().nullable(),
});
export type PiAgentCompactionStatus = z.infer<typeof piAgentCompactionStatusSchema>;

/** Entry pagination state is backend-owned JSON round-tripped only to the same Pi agent. */
export const piAgentEntryPageRequestSchema = z.object({
  pageSize: z.number().int().min(1).max(256),
  cursor: z.record(z.string(), jsonValueSchema).nullable(),
});
export type PiAgentEntryPage = {
  entries: readonly EntryRecord[];
  cursor: Cursor | null;
};

/** NDJSON frames replace the browser's durable conversation view with one committed revision. */
export const piAgentViewStreamFrameSchema = z.object({
  type: z.enum(["snapshot", "update"]),
  view: z.unknown(),
});
export type PiAgentViewStreamFrame = {
  type: "snapshot" | "update";
  view: ConversationView;
};

/** Agent operations shared by Cloudflare RPC and the local object runtime. */
export type PiAgent = {
  submit(
    config: PiAgentConfig,
    prompt: z.infer<typeof piAgentPromptSchema>,
  ): Promise<{ submissionId: number; requestId: string }>;
  getView(config: PiAgentConfig): Promise<unknown>;
  watchView(config: PiAgentConfig): Promise<ReadableStream<Uint8Array>>;
  getSubmission(config: PiAgentConfig, requestId: string): Promise<unknown>;
  waitForSubmission(
    config: PiAgentConfig,
    requestId: string,
    request: z.infer<typeof piAgentSubmissionWaitRequestSchema>,
  ): Promise<PiAgentSubmissionWait | null>;
  listEntries(
    config: PiAgentConfig,
    request: z.infer<typeof piAgentEntryPageRequestSchema>,
  ): Promise<PiAgentEntryPage>;
  exportEntries(config: PiAgentConfig): Promise<ReadableStream<Uint8Array>>;
  compact(
    config: PiAgentConfig,
    request: z.infer<typeof piAgentCompactionSchema>,
  ): Promise<{ taskId: number }>;
  getCompaction(config: PiAgentConfig, taskId: number): Promise<PiAgentCompactionStatus | null>;
  abort(config: PiAgentConfig): Promise<void>;
};

/** Namespaced object identity prevents two execution scopes from sharing an agent. */
export function piAgentObjectName(config: Pick<PiAgentConfig, "scope" | "sessionId">) {
  return JSON.stringify([backofficeContextScopeRoutePath(config.scope), config.sessionId]);
}
