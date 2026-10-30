import type { Op } from "@earendil-works/chord/delta";
import { automationActorsSchema } from "@fragno-dev/backoffice-api/v0/automation";
import { automationEventSchema, type AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import type {
  PiAgentConfig,
  PiAgentMessagePage,
  PiAgentQueueEntry,
  PiAgentWatchFrame,
  PiPromptStatus,
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

/**
 * Prefixes of the request IDs Backoffice names its own work by: notifications by their route or as
 * replies, and compactions, the queue's and the summaries Pi writes as `compaction:<taskId>`.
 * Callers' request IDs never start with one, so no prompt takes the identity of such work.
 */
export const PI_INTERNAL_REQUEST_ID_PREFIX = {
  route: "route:",
  reply: "reply:",
  compaction: "compaction:",
} as const;

export function isPiInternalRequestId(requestId: string): boolean {
  return Object.values(PI_INTERNAL_REQUEST_ID_PREFIX).some((prefix) =>
    requestId.startsWith(prefix),
  );
}

/** Request IDs deduplicate prompt admission within an agent's root conversation. */
export const piAgentPromptSchema = z.object({
  requestId: z.string().min(1),
  content: z.string().min(1),
});
export type PiAgentPrompt = z.infer<typeof piAgentPromptSchema>;

/**
 * Where a subagent stands in its agent: Pi's submission of its prompt, null before it starts; when
 * its prompt was placed and when it was answered, as epoch milliseconds; and its answer's text.
 */
export type PiSubagentRun = {
  requestId: string;
  submission: SubmissionRecord | null;
  startedAt: number | null;
  answeredAt: number | null;
  answer: string | null;
};

/** What the queue knows of a subagent before its agent starts it: it waits, or it was dropped. */
export const piQueuedSubagentSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("waiting") }),
  z.object({ status: z.literal("dropped"), reason: z.string() }),
]);
export type PiQueuedSubagent = z.infer<typeof piQueuedSubagentSchema>;

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

/** What a notification delivers of a recorded event; its actors and scope stay behind. */
export function piAgentNotificationEvent(event: AutomationEvent): PiAgentNotification["event"] {
  const { id, source, eventType, occurredAt, subject, payload } = event;
  return { id, source, eventType, occurredAt, subject: subject ?? null, payload };
}

/**
 * A turn the agent settled, by its request ID, and the `turn.*` event recording how it ended; null
 * for settlements that record none. `compact` says the agent's context outgrew its compaction
 * threshold when the turn ended, so the queue compacts it before the next turn.
 */
export type PiAgentSettledTurn = {
  agentName: string;
  requestId: string;
  ended: AutomationEvent | null;
  compact: boolean;
};

/**
 * What a dispatched turn asks the agent for: one prompt, or the notifications it handles together,
 * named by the oldest one's request ID. A dispatched compaction runs between turns instead, under
 * the authority of the turn before it; the next turn waits until it settles.
 */
export const piAgentWorkSchema = z.lazy(() =>
  z.discriminatedUnion("type", [
    piAgentPromptSchema.extend({ type: z.literal("prompt") }),
    z.object({
      type: z.literal("notifications"),
      requestId: z.string().min(1),
      notifications: z.array(piAgentNotificationSchema).min(1),
    }),
    z.object({ type: z.literal("compaction"), requestId: z.string().min(1) }),
  ]),
);
export type PiAgentWork = z.infer<typeof piAgentWorkSchema>;

/**
 * What joins the dispatched turn: a prompt its sender steers it with, or an event the turn's own
 * sender caused, such as a prompt the turn sent ending, which the turn handles instead of a turn
 * of its own.
 */
export const piAgentSteerSchema = z.lazy(() =>
  z.discriminatedUnion("type", [
    piAgentPromptSchema.extend({ type: z.literal("prompt") }),
    z.object({ type: z.literal("notification"), notification: piAgentNotificationSchema }),
  ]),
);
export type PiAgentSteer = z.infer<typeof piAgentSteerSchema>;

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

/** Pi's submission of a prompt, and its answer's text once done; null when the answer said nothing. */
export type PiAgentSubmission = { record: SubmissionRecord; answer: string | null };

/**
 * A submission as the manager answers for it, Pi's own once a turn took it, and where it stands in
 * public terms, with `answer`, the text of a done submission's answer.
 */
export function piPromptStatusOf(
  requestId: string,
  submission: PiAgentQueueSubmission | SubmissionRecord,
  answer: string | null,
): PiPromptStatus {
  switch (submission.status) {
    case "queued":
      return { requestId, status: "queued" };
    case "placed":
      return { requestId, status: "running" };
    case "done":
      return { requestId, status: "completed", answer };
    case "unanswered":
    case "dropped":
      return { requestId, status: "failed", reason: submission.reason };
  }
  throw new Error("Unsupported Pi submission status.");
}

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

/**
 * The `last` messages said before entry `before`, or the latest ones when it is null, in the
 * agent's conversation or, by the request ID that started it, one of its subagents', from the
 * newest compaction or reset on.
 */
export const piAgentMessagePageRequestSchema = z.object({
  last: z.number().int().min(1).max(100),
  before: z.number().int().positive().nullable(),
  subagent: z.string().min(1).nullable(),
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
   * dispatched; if another turn runs by then, the prompt or event follows it instead of joining it.
   * Like every start, refused when a stop fenced its queue `revision` (see `abort`).
   */
  steer(
    config: PiAgentConfig,
    revision: number,
    turn: PiAgentTurn,
    steer: PiAgentSteer,
  ): Promise<void>;
  /**
   * Hands Pi the turn the manager's queue dispatched, writing its notifications into the
   * conversation first; a request ID Pi already has is kept. A dispatched compaction starts once
   * per request ID.
   */
  dispatch(
    config: PiAgentConfig,
    revision: number,
    turn: PiAgentTurn,
    work: PiAgentWork,
  ): Promise<void>;
  /**
   * Writes notifications into the conversation as they arrive, at a running turn's next boundary;
   * the request to handle them waits in the manager's queue. A written one is not written again.
   */
  writeNotifications(config: PiAgentConfig, notifications: PiAgentNotification[]): Promise<void>;
  /**
   * Starts a subagent: a new conversation of the agent that answers `prompt` under `turn`,
   * alongside the agent's other work. A request ID that started one finds it again.
   */
  startSubagent(
    config: PiAgentConfig,
    revision: number,
    turn: PiAgentTurn,
    prompt: PiAgentPrompt,
  ): Promise<void>;
  /**
   * Records what the queue knows of a subagent before it starts, so a turn waiting for it learns
   * that it waits or was dropped. A subagent that started keeps its record.
   */
  recordSubagent(
    config: PiAgentConfig,
    requestId: string,
    subagent: PiQueuedSubagent,
  ): Promise<void>;
  /**
   * The conversation's view, or by the request ID that started it a subagent's; null when no
   * subagent has that request ID.
   */
  getView(config: PiAgentConfig, subagent: string | null): Promise<unknown>;
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
  /** A request's submission, in the agent's conversation or the subagent it started. */
  getSubmission(config: PiAgentConfig, requestId: string): Promise<PiAgentSubmission | null>;
  /** Where each of the subagents `requestIds` asked for stands, in the same order. */
  getSubagentRuns(config: PiAgentConfig, requestIds: string[]): Promise<PiSubagentRun[]>;
  listEntries(
    config: PiAgentConfig,
    request: z.infer<typeof piAgentEntryPageRequestSchema>,
  ): Promise<PiAgentEntryPage>;
  listMessages(
    config: PiAgentConfig,
    request: z.infer<typeof piAgentMessagePageRequestSchema>,
  ): Promise<PiAgentMessagePage>;
  /** The conversation as JSONL; only `history` reaches past the newest compaction or reset. */
  exportEntries(config: PiAgentConfig, history: boolean): Promise<ReadableStream<Uint8Array>>;
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
  /**
   * Stops the agent's turn and subagents, and fences the queue revision `revision` that paused
   * it: work handed over at an earlier revision is refused from then on, so a handover still on
   * its way or retried cannot start once the stop returns. Resuming hands it over again.
   */
  abort(config: PiAgentConfig, revision: number): Promise<void>;
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
