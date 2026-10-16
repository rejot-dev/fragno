import { automationActorsSchema } from "@fragno-dev/backoffice-api/v0/automation";
import { automationEventSchema } from "@fragno-dev/backoffice-api/v0/events";
import {
  piAgentModelSchema,
  piPromptWhenBusySchema,
  type PiAgentConfig,
} from "@fragno-dev/backoffice-api/v0/pi";
import { jsonValueSchema } from "@fragno-dev/backoffice-api/v0/shared/json";
import { backofficePermissionRequirementSchema } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { backofficeContextScopeSchema } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import type {
  ConversationView,
  Cursor,
  EntryRecord,
  SubmissionRecord,
} from "@earendil-works/pi-durable";

import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";

/** One supported chat model whose provider credentials are available to durable Pi. */
export const piAvailableModelSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  label: z.string().min(1),
  contextWindow: z.number().int().positive(),
});
export type PiAvailableModel = z.infer<typeof piAvailableModelSchema>;

/** Stable across local calls and Cloudflare RPC, where custom Error prototypes are not authoritative. */
export class PiConversationViewDamagedError extends Error {
  static readonly code = "PI_CONVERSATION_VIEW_DAMAGED";
  static readonly publicMessage =
    "The Pi conversation state is damaged and cannot be resumed. Export its history before resetting the agent.";

  constructor(agentName: string, cause: unknown) {
    super(`${PiConversationViewDamagedError.code}:${agentName}`, { cause });
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

/** Request IDs deduplicate prompt admission within an agent's root conversation. */
export const piAgentPromptSchema = z.object({
  requestId: z.string().min(1),
  content: z.string().min(1),
  whenBusy: piPromptWhenBusySchema.default("followUp"),
});

/** An Automations event a route delivers to an agent; the route and event IDs name its turn. */
export const piAgentNotificationSchema = z.lazy(() =>
  z.object({
    routeId: z.string().min(1),
    event: automationEventSchema._zod.innerType.pick({
      id: true,
      source: true,
      eventType: true,
      occurredAt: true,
      subject: true,
      payload: true,
    }),
  }),
);
export type PiAgentNotification = z.infer<typeof piAgentNotificationSchema>;

/**
 * The authority of one turn: its submitter's actors, narrowed by the agent definition read when
 * the turn was admitted. The kernel re-resolves the actors' permissions on every check.
 */
export const piAgentTurnSchema = z.object({
  actors: automationActorsSchema,
  scopeRestriction: backofficeContextScopeSchema.nullable(),
  agent: z.object({
    model: piAgentModelSchema,
    instructions: z.string(),
    permissions: z.array(backofficePermissionRequirementSchema),
  }),
});
export type PiAgentTurn = z.infer<typeof piAgentTurnSchema>;

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

/**
 * Pages newest-first through the history older than entry `before`, which callers set to where the
 * active context begins; the conversation view already carries everything from there on. Entry
 * pagination state is backend-owned JSON round-tripped only to the same Pi agent and `before`.
 */
export const piAgentEntryPageRequestSchema = z.object({
  before: z.number().int().positive(),
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

/** `busy` answers a `reject` prompt that reached a running agent; nothing was recorded or queued. */
export type PiAgentSubmitResult =
  | {
      type: "admitted";
      submissionId: number;
      requestId: string;
      whenBusy: z.infer<typeof piPromptWhenBusySchema>;
    }
  | { type: "busy" };

/** Agent operations shared by Cloudflare RPC and the local object runtime. */
export type PiAgent = {
  submit(
    config: PiAgentConfig,
    turn: PiAgentTurn,
    prompt: z.infer<typeof piAgentPromptSchema>,
  ): Promise<PiAgentSubmitResult>;
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
  /**
   * Writes the event into the conversation, then asks for a turn with the given authority unless
   * a follow-up with that authority is still queued.
   */
  notify(
    config: PiAgentConfig,
    turn: PiAgentTurn,
    notification: PiAgentNotification,
  ): Promise<void>;
  compact(
    config: PiAgentConfig,
    turn: PiAgentTurn,
    request: z.infer<typeof piAgentCompactionSchema>,
  ): Promise<{ taskId: number }>;
  getCompaction(config: PiAgentConfig, taskId: number): Promise<PiAgentCompactionStatus | null>;
  abort(config: PiAgentConfig): Promise<void>;
};

/** Namespaced object identity prevents two execution scopes from sharing an agent. */
export function piAgentObjectName(config: Pick<PiAgentConfig, "scope" | "agentName">) {
  // The `agent` tag keeps defined agents apart from objects addressed by earlier session ids.
  return JSON.stringify(["agent", backofficeContextScopeRoutePath(config.scope), config.agentName]);
}
