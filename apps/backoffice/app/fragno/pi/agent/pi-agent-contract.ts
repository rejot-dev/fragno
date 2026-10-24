import type { Op } from "@earendil-works/chord/delta";
import { automationActorsSchema } from "@fragno-dev/backoffice-api/v0/automation";
import { automationEventSchema } from "@fragno-dev/backoffice-api/v0/events";
import type {
  PiAgentConfig,
  PiAgentMessagePage,
  PiAgentQueueEntry,
  PiAgentWatchFrame,
} from "@fragno-dev/backoffice-api/v0/pi";
import { jsonValueSchema } from "@fragno-dev/backoffice-api/v0/shared/json";
import { backofficePermissionRequirementSchema } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { backofficeContextScopeSchema } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
  ConversationView,
  Cursor,
  EntryRecord,
  SubmissionRecord,
} from "@earendil-works/pi-durable";

import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";

/** Pi's reasoning efforts, from none to the most a model offers. */
export const piThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ModelThinkingLevel[]);
export type PiThinkingLevel = z.infer<typeof piThinkingLevelSchema>;

/** A model, by provider and model ID, and how hard it reasons. */
export const piAgentModelChoiceSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  thinkingLevel: piThinkingLevelSchema,
});
export type PiAgentModelChoice = z.infer<typeof piAgentModelChoiceSchema>;

/** One supported chat model whose provider credentials are available to durable Pi. */
export const piAvailableModelSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  label: z.string().min(1),
  contextWindow: z.number().int().positive(),
  /** The reasoning efforts the model supports, in increasing order. */
  thinkingLevels: z.array(piThinkingLevelSchema).min(1).readonly(),
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
});
export type PiAgentPrompt = z.infer<typeof piAgentPromptSchema>;

/**
 * An event delivered to an agent, by an Automations route or, with no route, addressed to the
 * agent itself, as a workflow it started reports back. The route and event IDs name its turn.
 */
export const piAgentNotificationSchema = z.lazy(() =>
  z.object({
    routeId: z.string().min(1).nullable(),
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
 * What a dispatched turn asks the agent for: one prompt, or the notifications it handles together,
 * named by the oldest one's request ID.
 */
export const piAgentWorkSchema = z.lazy(() =>
  z.discriminatedUnion("type", [
    piAgentPromptSchema.extend({ type: z.literal("prompt") }),
    z.object({
      type: z.literal("notifications"),
      requestId: z.string().min(1),
      notifications: z.array(piAgentNotificationSchema).min(1),
    }),
  ]),
);
export type PiAgentWork = z.infer<typeof piAgentWorkSchema>;

/**
 * The authority of one turn: its submitter's actors, narrowed by the agent definition read when
 * the turn was admitted. The kernel re-resolves the actors' permissions on every check.
 */
export const piAgentTurnSchema = z.object({
  actors: automationActorsSchema,
  scopeRestriction: backofficeContextScopeSchema.nullable(),
  agent: z.object({
    // Null keeps the conversation's model. Turns recorded before efforts were chosen ran at low.
    model: piAgentModelChoiceSchema
      .extend({ thinkingLevel: piThinkingLevelSchema.default("low") })
      .nullable(),
    instructions: z.string(),
    permissions: z.array(backofficePermissionRequirementSchema),
  }),
});
export type PiAgentTurn = z.infer<typeof piAgentTurnSchema>;

/** Manual compaction accepts no instructions or one explicit summary requirement. */
export const piAgentCompactionSchema = z.object({
  instructions: z.string().trim().min(1).nullable().default(null),
});

/**
 * A prompt's submission while its manager holds it: queued for a turn, which Pi knows nothing of
 * until the queue dispatches it, or dropped before Pi ever received it.
 */
export type PiAgentQueueSubmission =
  | { type: "input"; status: "queued"; requestId: string }
  | { type: "input"; status: "dropped"; requestId: string; reason: string };

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

/** The `last` messages said before entry `before`, or the latest ones when it is null. */
export const piAgentMessagePageRequestSchema = z.object({
  last: z.number().int().min(1).max(100),
  before: z.number().int().positive().nullable(),
});

/**
 * An agent's waiting items in queue order, and whether its queue is paused, as of a revision of
 * its queue.
 */
export type PiAgentWaitingQueue = { revision: number; paused: boolean; items: PiAgentQueueEntry[] };

/** What an agent sends its view socket, which `pi.agent.watch` exposes. */
export type PiAgentViewFrame = PiAgentWatchFrame<ConversationView, Op>;

/** The manager's answer when an agent asks whether a viewer may watch its conversation. */
export type PiAgentViewerAuthorization =
  | { type: "authorized"; queue: PiAgentWaitingQueue }
  | { type: "refused"; message: string };

/** Agent operations shared by Cloudflare RPC and the local object runtime. */
export type PiAgent = {
  /**
   * Resolves once a provisioned agent has opened its harness. An agent that has never been
   * provisioned has nothing to open, and warming does not provision it.
   */
  warm(): Promise<void>;
  /**
   * Joins the running turn at its next tool boundary. The manager steers only the turn it
   * dispatched; if another turn runs by then, the prompt follows it instead of joining it.
   */
  steer(config: PiAgentConfig, turn: PiAgentTurn, prompt: PiAgentPrompt): Promise<void>;
  /**
   * Hands Pi the turn the manager's queue dispatched, writing its notifications into the
   * conversation first; a request ID Pi already has is kept.
   */
  dispatch(config: PiAgentConfig, turn: PiAgentTurn, work: PiAgentWork): Promise<void>;
  /**
   * Writes notifications into the conversation as they arrive, at a running turn's next boundary;
   * the request to handle them waits in the manager's queue. A written one is not written again.
   */
  writeNotifications(config: PiAgentConfig, notifications: PiAgentNotification[]): Promise<void>;
  getView(config: PiAgentConfig): Promise<unknown>;
  /**
   * Accepts a view socket upgrade (see `PiAgentViewFrame`) signed for this agent with the viewer's
   * execution, which the agent's manager authorizes before the agent sends anything.
   */
  fetch(request: Request): Promise<Response>;
  /**
   * Sends the agent's view sockets what waits in its queue. Publications may arrive out of order,
   * so an older revision than the agent has is ignored.
   */
  publishQueue(queue: PiAgentWaitingQueue): Promise<void>;
  getSubmission(config: PiAgentConfig, requestId: string): Promise<SubmissionRecord | null>;
  listEntries(
    config: PiAgentConfig,
    request: z.infer<typeof piAgentEntryPageRequestSchema>,
  ): Promise<PiAgentEntryPage>;
  listMessages(
    config: PiAgentConfig,
    request: z.infer<typeof piAgentMessagePageRequestSchema>,
  ): Promise<PiAgentMessagePage>;
  exportEntries(config: PiAgentConfig): Promise<ReadableStream<Uint8Array>>;
  compact(
    config: PiAgentConfig,
    turn: PiAgentTurn,
    request: z.infer<typeof piAgentCompactionSchema>,
  ): Promise<{ taskId: number }>;
  getCompaction(config: PiAgentConfig, taskId: number): Promise<PiAgentCompactionStatus | null>;
  /**
   * Starts a new, empty context; earlier entries stay in history. A running turn ends at its next
   * boundary, where the reset lands.
   */
  reset(config: PiAgentConfig): Promise<void>;
  abort(config: PiAgentConfig): Promise<void>;
};

/**
 * The view socket upgrade for an agent. It names the agent, whose object checks the signature
 * against that name before it reads anything, including whether the agent was ever provisioned.
 */
export function piAgentViewSocketRequest(agent: PiAgentConfig): Request {
  const url = new URL("https://pi.do/view-socket");
  url.searchParams.set("agent", JSON.stringify(agent));
  return new Request(url, { headers: { upgrade: "websocket" } });
}

/** Names an agent's object; unlike its config, it does not need the agent to be provisioned. */
export type PiAgentAddress = Pick<PiAgentConfig, "scope" | "agentName">;

/** Namespaced object identity prevents two execution scopes from sharing an agent. */
export function piAgentObjectName(config: PiAgentAddress) {
  // The `agent` tag keeps defined agents apart from objects addressed by earlier session ids.
  return JSON.stringify(["agent", backofficeContextScopeRoutePath(config.scope), config.agentName]);
}
