import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { PathError } from "@earendil-works/chord/delta";
import { copyJson } from "@earendil-works/chord/json";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import {
  PI_AGENT_WATCH_REFUSED,
  piAgentConfigSchema,
  type PiAgentConfig,
  type PiAgentEntryRange,
  type PiSubagentAsk,
  type PiSubagentSummary,
} from "@fragno-dev/backoffice-api/v0/pi";
import {
  piAgentNotificationSchema,
  type PiAgentNotification,
  PI_NOTIFICATION_ENTRY_KIND,
  renderPiNotification,
  renderPiNotificationRequest,
} from "@fragno-dev/backoffice-api/v0/pi-conversation/notification-entry";
import {
  backofficeContextScopeSchema,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { RpcTarget } from "cloudflare:workers";
import { z } from "zod";

import {
  configure,
  StorageRequestError,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type Cursor,
  type EntryId,
  type JsonObject,
  type Harness,
  type SessionEnd,
  type Storage,
  type SubmissionRecord,
  type TaskId,
  type Wake,
} from "@earendil-works/pi-durable";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { type BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { readPiCompactionStatus } from "@/fragno/pi/agent/compaction-status";
import { piConversationActivity } from "@/fragno/pi/agent/conversation-activity";
import { listPiConversationMessages } from "@/fragno/pi/agent/conversation-messages";
import { createPiConversationExportStream } from "@/fragno/pi/agent/conversation-streams";
import {
  piAgentCompactionWorkSchema,
  piAgentMessagePageRequestSchema,
  piAgentSteerSchema,
  piQueuedSubagentSchema,
  piAgentTurnSchema,
  piAgentWorkSchema,
  piQueuedAskSchema,
  PiConversationViewDamagedError,
  type PiAgent,
  type PiAgentCompactionStatus,
  type PiAgentCompactionWork,
  type PiAgentEntryPage,
  type PiAgentPrompt,
  type PiAgentSteer,
  type PiAgentSubmission,
  type PiQueuedAsk,
  type PiQueuedSubagent,
  type PiSubagentPage,
  type PiAgentTurn,
  type PiAgentViewFrame,
  type PiAgentWaitingQueue,
  type PiAgentWork,
} from "@/fragno/pi/agent/pi-agent-contract";
import {
  openPiAgentHarness,
  type OpenPiAgent,
  type PiAgentDependencies,
} from "@/fragno/pi/agent/pi-agent-harness";
import {
  piNotificationInput,
  piNotificationRequestId,
} from "@/fragno/pi/agent/pi-agent-notification-entry";
import { mayJoinPiAgentTurn } from "@/fragno/pi/agent/pi-agent-queue-rules";
import {
  listPiSubagents,
  openPiSubagentConversation,
  piSubagentAnchorNotify,
  piSubagentConversation,
  readPiSubagentSummary,
  readWaitingPiSubagents,
  recordDroppedPiSubagent,
  recordStartedPiSubagent,
  recordWaitingPiSubagent,
  startPiSubagentAnchor,
  type PiAnchoredSubagent,
} from "@/fragno/pi/agent/pi-agent-subagents";
import {
  readPiAgentRun,
  recordAdmittedPiAgentTurn,
  recordPiAgentCompactionTurn,
  recordPiAgentTurn,
  readQueuedPiCompactionStart,
  recordQueuedPiCompaction,
  withdrawPiAgentTurn,
} from "@/fragno/pi/agent/pi-agent-turns";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import { PiAgentViewerConnection, PiAgentViewers, type PiAgentViewer } from "./pi-agent-viewers";

const AGENT_CONFIG_KEY = "pi-agent-config";
const LEGACY_BILLING_SCOPE_KEY = "pi-legacy-billing-scope";
// The queue revision of the agent's latest stop; work handed over before it is refused.
const STOP_FENCE_KEY = "pi-stop-fence";
const WAKE_HEARTBEAT_MS = 30_000;
const WAKE_BUDGET_MS = 10 * 60_000;

/**
 * Opens Pi's storage on the agent object's SQLite database, beside the agent's own keys. Pi's tables
 * keep the `pi_` prefix every stored agent already has them under.
 */
export function openPiAgentStorage(storage: DurableObjectStorage) {
  return openDurableObjectSqliteStorage(storage, { prefix: "pi_" });
}

/** Who connects to watch which agent, as the viewer's signed request says. */
export type PiAgentViewing = { agent: PiAgentConfig; execution: BackofficeExecutionContext };

/** A connected viewer: what it sends the agent, and how it disconnects. */
export type PiAgentViewerSession = {
  /** Takes one message the viewer sent, a JSON `PiAgentWatchMessage`. */
  receive(message: string): void;
  disconnect(): void;
};

/** How many subagents one viewer follows at most, besides the agent. */
const VIEWER_SUBAGENT_LIMIT = 16;
/** How many subagents' conversations a page of them reads at most. */
const SUBAGENT_PAGE_SIZE = 50;
/**
 * How many messages of a viewer wait at most while its view is sent; one following every subagent
 * it may sends two each, as it opens and closes them.
 */
const VIEWER_PENDING_LIMIT = 2 * VIEWER_SUBAGENT_LIMIT;

const piAgentWatchMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), subagent: z.string().min(1) }),
  z.object({ type: z.literal("unsubscribe"), subagent: z.string().min(1) }),
]);

/** A message a viewer sent, as `PiAgentWatchMessage`; null for one that is not. */
function piAgentWatchMessage(message: string): z.infer<typeof piAgentWatchMessageSchema> | null {
  try {
    return piAgentWatchMessageSchema.parse(JSON.parse(message));
  } catch {
    return null;
  }
}

/** An alarm waiting for the agent's work to stop. */
type PiAgentWaiter = {
  wake(wake: Wake): void;
  closed(end: SessionEnd): void;
};

type ProvisionedPiAgent = {
  config: PiAgentConfig;
  /** Null for agents provisioned since owner attribution: none of their deliveries is legacy. */
  legacyBillingScope: BackofficeContextScope | null;
};

/** The model messages of an entry of the conversation; none for a missing entry. */
async function entryMessages(
  storage: Storage,
  conversationId: ConversationId,
  entryId: EntryId | undefined,
) {
  if (entryId === undefined) {
    return [];
  }
  const stored = await storage.entry(conversationId, entryId, BACKGROUND_CONTEXT);
  return stored?.entry.model ?? [];
}

/** The model responses that answered a done submission. */
async function answerResponses(
  storage: Storage,
  conversationId: ConversationId,
  submission: SubmissionRecord | null,
) {
  const answer =
    submission?.type === "input" && submission.status === "done" ? submission.answer : undefined;
  return (await entryMessages(storage, conversationId, answer)).filter(
    (message) => message.role === "assistant",
  );
}

/** What the responses said; null when they said nothing. */
function answerText(responses: Awaited<ReturnType<typeof answerResponses>>) {
  const text = responses
    .flatMap((message) => message.content)
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
  return text === "" ? null : text;
}

/**
 * The cursor a page of subagents gave, as `PiOlderSubagents.cursor` encodes it; null for text no
 * page gave. Pi checks the cursor itself.
 */
function subagentCursor(text: string): Cursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const cursor = z.record(z.string(), z.json()).safeParse(parsed);
  return cursor.success ? cursor.data : null;
}

/** Shared durable agent lifecycle; both runtimes persist an alarm before admitting work. */
export class PiObject extends RpcTarget implements PiAgent {
  readonly #state: BackofficeObjectState;
  readonly #ready: Promise<void>;
  readonly #startup: Promise<void>;
  readonly #dependencies: PiAgentDependencies;
  readonly #runtime: BackofficeRuntimeServices;
  readonly #openStorage: () => Promise<Storage>;
  readonly #idFromConfig: (config: PiAgentConfig) => DurableObjectId;
  readonly #nowEpochMs: () => number;
  #provisioned: ProvisionedPiAgent | null = null;
  #opened: OpenPiAgent | null = null;
  #opening: Promise<OpenPiAgent> | null = null;
  #admitting = 0;
  // Handovers of the queue's compactions start one at a time, so each sees what the one before it
  // recorded and a repeated or older one starts nothing.
  #startingCompaction: Promise<unknown> = Promise.resolve();
  // An alarm waiting for the agent's work to stop follows its wakeups and its session's end.
  readonly #waiters = new Set<PiAgentWaiter>();
  readonly #viewers = new PiAgentViewers();
  // The agent's viewers get its subagents one change at a time, so each gets them in the order
  // they changed, and after the ones it connected with.
  #publishingSubagents: Promise<void> = Promise.resolve();

  constructor({
    state,
    dependencies,
    runtime,
    openStorage,
    idFromConfig,
    nowEpochMs,
  }: {
    state: BackofficeObjectState;
    dependencies: PiAgentDependencies;
    runtime: BackofficeRuntimeServices;
    openStorage: () => Promise<Storage>;
    idFromConfig: (config: PiAgentConfig) => DurableObjectId;
    nowEpochMs: () => number;
  }) {
    super();
    this.#state = state;
    this.#dependencies = dependencies;
    this.#runtime = runtime;
    this.#openStorage = openStorage;
    this.#idFromConfig = idFromConfig;
    this.#nowEpochMs = nowEpochMs;
    this.#ready = state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get<Record<string, unknown>>(AGENT_CONFIG_KEY);
      if (!stored) {
        return;
      }
      const config = piAgentConfigSchema.parse(stored);
      this.#assertObjectIdentity(config);
      // A delivery queued before this upgrade may already have reached its old organization.
      // Keep that destination across restarts so retrying cannot also charge the user's ledger.
      // It predates jurisdictions, so its organization names none.
      if ("billingOrganizationId" in stored) {
        const organizationId = z.string().nullable().parse(stored.billingOrganizationId);
        const legacyBillingScope: BackofficeContextScope =
          organizationId === null
            ? { kind: "system" }
            : { kind: "org", orgId: organizationId, jurisdiction: null };
        await state.storage.put(LEGACY_BILLING_SCOPE_KEY, legacyBillingScope);
        await state.storage.put(AGENT_CONFIG_KEY, config);
        this.#provisioned = { config, legacyBillingScope };
      } else {
        const legacy = await state.storage.get(LEGACY_BILLING_SCOPE_KEY);
        this.#provisioned = {
          config,
          legacyBillingScope: backofficeContextScopeSchema.optional().parse(legacy) ?? null,
        };
      }
    });
    // Startup failures must not poison configuration readiness or prevent a later open from retrying.
    this.#startup = this.#ready
      .then(async () => {
        if (!this.#provisioned) {
          return;
        }
        const opened = await this.#open(this.#provisioned);
        await this.#ensureBillingDelivery(opened);
        // Work a lost instance left, and sleeps, need a wakeup; one already armed may be earlier.
        const wake = opened.harness.wake();
        const wakeAt = wake.active ? this.#nowEpochMs() : wake.at;
        const armed = await state.storage.getAlarm();
        if (wakeAt !== undefined && (armed === null || armed > wakeAt)) {
          await state.storage.setAlarm(wakeAt);
        }
      })
      .catch((error: unknown) => {
        this.#dependencies.report(error, this.#provisioned?.config ?? null);
      });
  }

  #assertObjectIdentity(config: PiAgentConfig) {
    if (!this.#state.id.equals(this.#idFromConfig(config))) {
      throw new Error("Pi agent configuration does not match its object address.");
    }
  }

  async #open({ config, legacyBillingScope }: ProvisionedPiAgent): Promise<OpenPiAgent> {
    if (this.#opened) {
      return this.#opened;
    }
    if (this.#opening) {
      return await this.#opening;
    }
    // Once external work leaves the input gate, concurrent requests must still share one storage owner.
    const opening = (async () => {
      const opened = await openPiAgentHarness({
        config,
        legacyBillingScope,
        runtime: this.#runtime,
        dependencies: this.#dependencies,
        openStorage: this.#openStorage,
        nowEpochMs: this.#nowEpochMs,
        onWake: (wake) => {
          for (const waiter of this.#waiters) {
            waiter.wake(wake);
          }
        },
        onSubagentsChange: (subagents) => {
          this.#publishSubagents(subagents);
        },
      });
      // A failed session stays failed, so the next call opens the agent again.
      void opened.harness.closed.then((end) => {
        if (this.#opened === opened) {
          this.#opened = null;
        }
        for (const waiter of this.#waiters) {
          waiter.closed(end);
        }
      });
      // Before anything else uses the agent, so no commit can reach them as ops they miss.
      this.#viewers.closeHibernated();
      return opened;
    })();
    this.#opening = opening;
    try {
      this.#opened = await opening;
      return this.#opened;
    } finally {
      this.#opening = null;
    }
  }

  async #ensureBillingDelivery(opened: OpenPiAgent) {
    return await opened.billing.ensure(opened.harness, this.#nowEpochMs(), BACKGROUND_CONTEXT);
  }

  async #requireAgent(rawConfig: PiAgentConfig) {
    const config = piAgentConfigSchema.parse(rawConfig);
    this.#assertObjectIdentity(config);
    await this.#ready;
    const provisioned = await this.#state.blockConcurrencyWhile(async () => {
      if (this.#provisioned) {
        if (JSON.stringify(this.#provisioned.config) !== JSON.stringify(config)) {
          throw new Error("Pi agent provisioning configuration cannot be changed.");
        }
        return this.#provisioned;
      }
      // Persist provisioning before opening Pi so a cold start can finish initialization.
      await this.#state.storage.put(AGENT_CONFIG_KEY, config);
      this.#provisioned = { config, legacyBillingScope: null };
      return this.#provisioned;
    });
    return await this.#open(provisioned);
  }

  async initialize(config: PiAgentConfig): Promise<void> {
    await this.#requireAgent(config);
  }

  async warm(): Promise<void> {
    await this.#startup;
  }

  // Records the turn before Pi admits its prompt, so no generation or tool can start without it.
  async #admit(
    opened: OpenPiAgent,
    // The queue revision that handed it over, which a stop may fence.
    revision: number,
    turn: PiAgentTurn,
    prompt: PiAgentPrompt,
    // The transcript entry the input is placed as, when it is not the prompt's own.
    entry: { kind: string; data: JsonObject } | null,
    whenBusy: "steer" | "followUp",
  ): Promise<void> {
    const { harness } = opened;
    const root = await harness.root(BACKGROUND_CONTEXT);
    this.#admitting += 1;
    try {
      // The wake must be durable before Pi admits work, not after the HTTP request returns.
      await this.#state.storage.setAlarm(this.#nowEpochMs());
      await recordPiAgentTurn(harness, root.id, prompt.requestId, turn, BACKGROUND_CONTEXT);
      try {
        // The conversation keeps its model and effort for turns that name none.
        const chosen = turn.agent.model;
        const current = await root.agent(BACKGROUND_CONTEXT);
        if (
          chosen &&
          (current.model?.provider !== chosen.provider ||
            current.model.modelId !== chosen.modelId ||
            current.thinkingLevel !== chosen.thinkingLevel)
        ) {
          await root.configure(
            {
              model: { provider: chosen.provider, modelId: chosen.modelId },
              thinkingLevel: chosen.thinkingLevel,
            },
            BACKGROUND_CONTEXT,
          );
        }
        await root.submit(
          {
            type: "input",
            requestId: prompt.requestId,
            content: prompt.content,
            whenBusy,
            ...(entry && { entry }),
          },
          BACKGROUND_CONTEXT,
        );
        await recordAdmittedPiAgentTurn(harness, turn, BACKGROUND_CONTEXT);
      } catch (error) {
        // Withdrawal keeps the record of a submission Pi did admit before the failure.
        await withdrawPiAgentTurn(harness, root.id, prompt.requestId, BACKGROUND_CONTEXT);
        throw error;
      }
      // A stop that landed while it was admitted aborted only what ran before it.
      if (await this.#fenced(revision)) {
        await root.abort(BACKGROUND_CONTEXT, { background: true });
      }
    } finally {
      this.#admitting -= 1;
    }
  }

  /**
   * Reloads the agent's skills as `turn`'s submitter, for the turns after it: where its context
   * starts over, at a compaction or clear, and for a turn admitted without any. Returns the skills
   * offered from then on; null when the reload failed, which keeps those offered before and fails
   * nothing.
   */
  async #reloadSkills(opened: OpenPiAgent, turn: PiAgentTurn) {
    try {
      return (await opened.reloadSkills(turn, BACKGROUND_CONTEXT)).skills;
    } catch (error) {
      this.#dependencies.report(error, this.#provisioned?.config ?? null);
      return null;
    }
  }

  /**
   * A turn admitted without skills belongs to an agent never reloaded, or whose definition changed
   * since, so it reloads them first. One whose reload fails finds the skills its definition selected
   * as the files are now.
   */
  async #withSkills(opened: OpenPiAgent, turn: PiAgentTurn): Promise<PiAgentTurn> {
    if (turn.agent.skills !== null) {
      return turn;
    }
    return {
      ...turn,
      agent: { ...turn.agent, skills: await this.#reloadSkills(opened, turn) },
    };
  }

  /** Whether a stop came after the queue handed over work at `revision`. */
  async #fenced(revision: number): Promise<boolean> {
    const fence = await this.#state.storage.get<number>(STOP_FENCE_KEY);
    return fence !== undefined && revision < fence;
  }

  async startSubagent(
    config: PiAgentConfig,
    revision: number,
    rawTurn: PiAgentTurn,
    rawAsk: PiQueuedAsk,
  ) {
    const queued = piQueuedAskSchema.parse(rawAsk);
    const admitted = piAgentTurnSchema.parse(rawTurn);
    if (await this.#fenced(revision)) {
      return;
    }
    const opened = await this.#requireAgent(config);
    const { harness, storage, awaitSubagentsTool } = opened;
    const { requestId } = queued;
    const ask = await this.#namedAsk(queued);
    this.#admitting += 1;
    try {
      // The wake must be durable before Pi admits work, not after the HTTP request returns.
      await this.#state.storage.setAlarm(this.#nowEpochMs());
      // Each step is one commit that a handover of the subagent again finds done.
      const anchored = await startPiSubagentAnchor(
        harness,
        ask,
        this.#nowEpochMs(),
        BACKGROUND_CONTEXT,
      );
      const chosen = admitted.agent.model;
      const subagent =
        anchored.status === "starting"
          ? await openPiSubagentConversation(
              harness,
              requestId,
              anchored.taskId,
              async (tx, conversationId) => {
                await configure(tx, conversationId, {
                  ...(chosen && {
                    model: { provider: chosen.provider, modelId: chosen.modelId },
                    thinkingLevel: chosen.thinkingLevel,
                  }),
                  // A subagent waiting for subagents would hold a slot they need.
                  tools: { remove: [awaitSubagentsTool] },
                });
              },
              BACKGROUND_CONTEXT,
            )
          : anchored;
      // A subagent handed over again keeps the submission and turn Pi already has for it.
      if (subagent.status !== "opened") {
        return;
      }
      const conversation = await this.#requireConversation(
        harness,
        subagent.conversationId as ConversationId,
      );
      if (!(await storage.submissionByRequest(conversation.id, requestId, BACKGROUND_CONTEXT))) {
        const turn = await this.#withSkills(opened, admitted);
        await recordPiAgentTurn(harness, conversation.id, requestId, turn, BACKGROUND_CONTEXT);
        try {
          await conversation.submit(
            {
              type: "input",
              requestId,
              content: ask.task,
              notify: piSubagentAnchorNotify(subagent.taskId),
            },
            BACKGROUND_CONTEXT,
          );
        } catch (error) {
          await withdrawPiAgentTurn(harness, conversation.id, requestId, BACKGROUND_CONTEXT);
          throw error;
        }
      }
      // Only once its prompt is submitted, so a turn waiting for it finds the submission.
      await recordStartedPiSubagent(harness, requestId, BACKGROUND_CONTEXT);
      // A stop that landed while it started may have ended its anchor before its prompt existed.
      if (await this.#fenced(revision)) {
        await conversation.abort(BACKGROUND_CONTEXT, { background: true });
      }
    } finally {
      this.#admitting -= 1;
    }
  }

  async recordSubagent(config: PiAgentConfig, requestId: string, rawSubagent: PiQueuedSubagent) {
    const subagent = piQueuedSubagentSchema.parse(rawSubagent);
    const { harness } = await this.#requireAgent(config);
    const asked = subagent.status === "waiting" ? await this.#namedAsk(subagent.ask) : null;
    const changed = await harness.commit(async (tx): Promise<PiSubagentSummary | null> => {
      if (asked) {
        return (await recordWaitingPiSubagent(tx, asked))
          ? { ...asked, state: { status: "waiting" } }
          : null;
      }
      if (subagent.status !== "dropped") {
        throw new Error("A waiting subagent has what it was asked.");
      }
      const ask = await recordDroppedPiSubagent(tx, requestId, subagent.reason);
      return ask && { ...ask, state: { status: "dropped", reason: subagent.reason } };
    }, BACKGROUND_CONTEXT);
    if (changed) {
      this.#publishSubagent(async () => changed);
    }
  }

  /**
   * What a subagent was asked, as its viewers see it: an app asker with the slug it has now, which
   * the viewers know it by later too, even once the app is gone.
   */
  async #namedAsk(ask: PiQueuedAsk): Promise<PiSubagentAsk> {
    const { askedBy } = ask;
    if (askedBy.kind !== "app") {
      return { ...ask, askedBy };
    }
    const app = await this.#runtime.objects.apps.singleton().commands.getApp({
      appId: askedBy.appId,
    });
    return { ...ask, askedBy: { ...askedBy, appSlug: app?.slug ?? null } };
  }

  async #requireConversation(harness: Harness, conversationId: Conversation["id"]) {
    const conversation = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
    if (!conversation) {
      throw new Error(`Pi conversation ${conversationId} is missing.`);
    }
    return conversation;
  }

  /** The root conversation, or the subagent's that `subagent` asked for; null before it starts. */
  async #conversation(harness: Harness, subagent: string | null): Promise<Conversation | null> {
    if (subagent === null) {
      return await harness.root(BACKGROUND_CONTEXT);
    }
    const conversationId = await piSubagentConversation(harness, subagent, BACKGROUND_CONTEXT);
    return conversationId === null
      ? null
      : await this.#requireConversation(harness, conversationId);
  }

  async steer(
    config: PiAgentConfig,
    revision: number,
    rawTurn: PiAgentTurn,
    rawSteer: PiAgentSteer,
  ) {
    const steer = piAgentSteerSchema.parse(rawSteer);
    const turn = piAgentTurnSchema.parse(rawTurn);
    if (await this.#fenced(revision)) {
      return;
    }
    const { entry, ...prompt } =
      steer.type === "prompt"
        ? { requestId: steer.requestId, content: steer.content, entry: null }
        : piNotificationInput(steer.notification);
    const opened = await this.#requireAgent(config);
    const root = await opened.harness.root(BACKGROUND_CONTEXT);
    if (await opened.storage.submissionByRequest(root.id, prompt.requestId, BACKGROUND_CONTEXT)) {
      return;
    }
    const run = await readPiAgentRun(opened.harness, opened.storage, root.id, BACKGROUND_CONTEXT);
    // The manager's dispatched turn may have just ended; a steer never joins another authority's.
    const joins = run.type === "running" && run.turn !== null && mayJoinPiAgentTurn(run.turn, turn);
    await this.#admit(
      opened,
      revision,
      turn,
      prompt,
      entry && { kind: entry.kind, data: copyJson(entry.data) as JsonObject },
      joins ? "steer" : "followUp",
    );
  }

  async dispatch(
    config: PiAgentConfig,
    revision: number,
    rawTurn: PiAgentTurn,
    rawWork: PiAgentWork,
  ) {
    const work = piAgentWorkSchema.parse(rawWork);
    const admitted = piAgentTurnSchema.parse(rawTurn);
    if (await this.#fenced(revision)) {
      return;
    }
    const opened = await this.#requireAgent(config);
    if (work.type === "compaction") {
      await this.#startQueuedCompaction(opened, revision, admitted, work);
      return;
    }
    const root = await opened.harness.root(BACKGROUND_CONTEXT);
    // A turn handed over again keeps the submission and turn Pi already has for it.
    if (await opened.storage.submissionByRequest(root.id, work.requestId, BACKGROUND_CONTEXT)) {
      return;
    }
    const turn = await this.#withSkills(opened, admitted);
    if (work.type === "prompt") {
      // Only a steer that outlived its turn can still be running; Pi queues the prompt behind it.
      await this.#admit(opened, revision, turn, work, null, "followUp");
      return;
    }
    // Cards written when their notifications arrived are kept where they are.
    await this.#writeNotifications(opened, work.notifications);
    await this.#admit(
      opened,
      revision,
      turn,
      {
        requestId: work.requestId,
        content: renderPiNotificationRequest(
          work.notifications.map(({ routeId, event }) => ({ routeId, eventId: event.id })),
        ),
      },
      null,
      "followUp",
    );
  }

  /**
   * Starts the compaction the queue dispatched between turns, which runs as the turn before it or
   * whoever requested it, and returns its Pi task; null when it was fenced or superseded. Starting
   * the task and recording it are two commits, so an object lost between them leaves a compaction
   * a repeated handover starts again; Pi keeps the furthest cut of the two.
   */
  #startQueuedCompaction(
    opened: OpenPiAgent,
    // The queue revision that handed it over, which a stop may fence.
    revision: number,
    turn: PiAgentTurn,
    work: PiAgentCompactionWork,
  ): Promise<number | null> {
    const starting = this.#startingCompaction.then(async () => {
      const { harness } = opened;
      const start = await readQueuedPiCompactionStart(
        harness,
        work.requestId,
        revision,
        BACKGROUND_CONTEXT,
      );
      if (start.type !== "new") {
        return start.type === "started" ? start.taskId : null;
      }
      this.#admitting += 1;
      try {
        // The alarm reports the compaction once it ends, which the queue waits for.
        await this.#state.storage.setAlarm(this.#nowEpochMs());
        await recordPiAgentCompactionTurn(harness, turn, BACKGROUND_CONTEXT);
        const root = await harness.root(BACKGROUND_CONTEXT);
        // A stop that landed while it was admitted found nothing to abort. The compaction stays
        // dispatched, so resuming hands it over again.
        if (await this.#fenced(revision)) {
          return null;
        }
        // Before the compaction settles, which starts the next turn.
        await this.#reloadSkills(opened, turn);
        const taskId = await root.compact(work.instructions ?? undefined, BACKGROUND_CONTEXT);
        await recordQueuedPiCompaction(
          harness,
          work.requestId,
          revision,
          taskId,
          BACKGROUND_CONTEXT,
        );
        // A stop that landed after that check aborted before the compaction existed.
        if (await this.#fenced(revision)) {
          await root.abort(BACKGROUND_CONTEXT, { background: true });
        }
        return taskId;
      } finally {
        this.#admitting -= 1;
      }
    });
    this.#startingCompaction = starting.catch(() => undefined);
    return starting;
  }

  async writeNotifications(config: PiAgentConfig, rawNotifications: PiAgentNotification[]) {
    const notifications = z.array(piAgentNotificationSchema).parse(rawNotifications);
    await this.#writeNotifications(await this.#requireAgent(config), notifications);
  }

  // A busy conversation places a write at its next boundary, so a running turn sees the event.
  // The write's request ID makes writing it again a no-op.
  async #writeNotifications(opened: OpenPiAgent, notifications: readonly PiAgentNotification[]) {
    const root = await opened.harness.root(BACKGROUND_CONTEXT);
    for (const notification of notifications) {
      await root.submit(
        {
          type: "write",
          requestId: `${piNotificationRequestId(notification)}:event`,
          entry: {
            kind: PI_NOTIFICATION_ENTRY_KIND,
            data: copyJson(notification),
            model: [
              {
                role: "user",
                content: renderPiNotification(notification),
                timestamp: this.#nowEpochMs(),
              },
            ],
          },
        },
        BACKGROUND_CONTEXT,
      );
    }
  }

  async getSubmission(config: PiAgentConfig, requestId: string): Promise<PiAgentSubmission | null> {
    const { storage, harness } = await this.#requireAgent(config);
    const conversationId =
      (await piSubagentConversation(harness, requestId, BACKGROUND_CONTEXT)) ??
      (await harness.root(BACKGROUND_CONTEXT)).id;
    const record = await storage.submissionByRequest(conversationId, requestId, BACKGROUND_CONTEXT);
    if (record === undefined) {
      return null;
    }
    // The answer is read by its entry, which a later compaction or reset leaves in place.
    return { record, answer: answerText(await answerResponses(storage, conversationId, record)) };
  }

  async listSubagents(
    config: PiAgentConfig,
    rawCursor: string | null,
  ): Promise<PiSubagentPage | null> {
    const text = z.string().nullable().parse(rawCursor);
    const cursor = text === null ? null : subagentCursor(text);
    if (text !== null && cursor === null) {
      return null;
    }
    const { harness, storage } = await this.#requireAgent(config);
    try {
      return await listPiSubagents(
        storage,
        cursor,
        SUBAGENT_PAGE_SIZE,
        async (taskId, conversationId) =>
          await this.#listedSubagent(harness, storage, taskId, conversationId),
        BACKGROUND_CONTEXT,
      );
    } catch (error) {
      // Pi refuses a cursor its scans never gave.
      if (error instanceof StorageRequestError) {
        return null;
      }
      throw error;
    }
  }

  async listEntries(
    config: PiAgentConfig,
    range: PiAgentEntryRange,
    subagent: string | null,
  ): Promise<PiAgentEntryPage> {
    const { harness } = await this.#requireAgent(config);
    const conversation = await this.#conversation(harness, z.string().nullable().parse(subagent));
    // A request that started no subagent has no entries yet.
    if (!conversation) {
      return { entries: [], more: false };
    }
    const page = await conversation.entries(
      {
        ...(range.minEntryId === null ? {} : { minEntryId: range.minEntryId as EntryId }),
        ...(range.maxEntryId === null ? {} : { maxEntryId: range.maxEntryId as EntryId }),
        order: range.order,
      },
      range.pageSize,
      undefined,
      BACKGROUND_CONTEXT,
    );
    return { entries: page.items, more: page.next !== undefined };
  }

  async listMessages(
    config: PiAgentConfig,
    rawRequest: z.infer<typeof piAgentMessagePageRequestSchema>,
  ) {
    const request = piAgentMessagePageRequestSchema.parse(rawRequest);
    const { harness } = await this.#requireAgent(config);
    const conversation = await this.#conversation(harness, request.subagent);
    // A request that started no subagent has said nothing.
    return conversation
      ? await listPiConversationMessages(conversation, request)
      : { messages: [], before: null };
  }

  async exportEntries(
    config: PiAgentConfig,
    history: boolean,
  ): Promise<ReadableStream<Uint8Array>> {
    const { harness } = await this.#requireAgent(config);
    return createPiConversationExportStream(
      await harness.root(BACKGROUND_CONTEXT),
      config,
      z.boolean().parse(history),
    );
  }

  async compact(
    config: PiAgentConfig,
    revision: number,
    rawTurn: PiAgentTurn,
    rawWork: PiAgentCompactionWork,
  ): Promise<{ taskId: number } | null> {
    const work = piAgentCompactionWorkSchema.parse(rawWork);
    const turn = piAgentTurnSchema.parse(rawTurn);
    if (await this.#fenced(revision)) {
      return null;
    }
    const opened = await this.#requireAgent(config);
    const taskId = await this.#startQueuedCompaction(opened, revision, turn, work);
    return taskId === null ? null : { taskId };
  }

  async getCompaction(
    config: PiAgentConfig,
    taskId: number,
  ): Promise<PiAgentCompactionStatus | null> {
    if (!Number.isSafeInteger(taskId) || taskId <= 0) {
      return null;
    }
    const { harness } = await this.#requireAgent(config);
    return await readPiCompactionStatus(harness, taskId);
  }

  async getActivity(config: PiAgentConfig, subagent: string | null) {
    const { harness } = await this.#requireAgent(config);
    const conversation = await this.#conversation(harness, z.string().nullable().parse(subagent));
    // A request that started no subagent has run nothing.
    if (!conversation) {
      return { tools: [], omitted: 0 };
    }
    return piConversationActivity(await this.#activeView(config, conversation));
  }

  async getView(config: PiAgentConfig): Promise<unknown> {
    const { harness } = await this.#requireAgent(config);
    return await this.#activeView(config, await harness.root(BACKGROUND_CONTEXT));
  }

  /**
   * The conversation's view over its active context, the newest head marker first, as the model
   * sees it: a watch's view holds a window over the newest entries, from before a compaction or
   * clear too.
   */
  async #activeView(config: PiAgentConfig, conversation: Conversation): Promise<ConversationView> {
    try {
      const watch = await conversation.watch(BACKGROUND_CONTEXT);
      try {
        const { entries } = await conversation.context(BACKGROUND_CONTEXT);
        const { before: _before, ...view } = watch.value;
        return { ...view, entries };
      } finally {
        await watch.stop();
      }
    } catch (cause) {
      if (!(cause instanceof PathError)) {
        throw cause;
      }
      throw new PiConversationViewDamagedError(config.agentName, cause);
    }
  }

  async fetch(_request: Request): Promise<Response> {
    throw new Error("Pi view sockets are not implemented outside Cloudflare.");
  }

  async publishQueue(queue: PiAgentWaitingQueue): Promise<void> {
    this.#viewers.publishQueue(queue);
  }

  /** Sends the agent's viewers each of `subagents`, which started or ended. */
  #publishSubagents(subagents: readonly PiAnchoredSubagent[]) {
    for (const { taskId, conversationId } of subagents) {
      this.#publishSubagent(async ({ harness, storage }) =>
        readPiSubagentSummary(harness, storage, taskId, conversationId, BACKGROUND_CONTEXT),
      );
    }
  }

  /**
   * Sends the agent's viewers a subagent that changed, as `read` reads it once those before it
   * were sent; null sends nothing. A change that cannot be sent reconnects them instead, since
   * nothing may change it again.
   */
  #publishSubagent(read: (opened: OpenPiAgent) => Promise<PiSubagentSummary | null>) {
    this.#publishingSubagents = this.#publishingSubagents
      .then(async () => {
        const opened = this.#opened;
        if (!opened || !this.#viewers.watched) {
          return;
        }
        const summary = await read(opened);
        if (summary) {
          this.#viewers.publishSubagent(summary);
        }
      })
      .catch((error: unknown) => {
        this.#dependencies.report(error, this.#provisioned?.config ?? null);
        this.#viewers.resynchronize();
      });
  }

  /**
   * Sends the viewer the agent's queue, conversation, and subagents (see `PiAgentViewFrame`), then
   * every change, and the conversations of the subagents it subscribes to, until it disconnects.
   * The manager decides whether the viewer may watch; a viewer it refuses, or that the agent cannot
   * serve, is closed instead.
   */
  connectViewer(viewer: PiAgentViewer, viewing: PiAgentViewing): PiAgentViewerSession {
    const connection = new PiAgentViewerConnection();
    // The subagents the viewer follows, each until it unsubscribes or disconnects.
    const subscriptions = new Map<string, PiAgentViewerConnection>();
    // Subscriptions wait for the agent's conversation, so the agent decides on the viewer first.
    const served = this.#serveViewer(viewer, viewing, connection);
    // Messages wait for that, each holding its place, so a viewer may send only so many meanwhile.
    let pending = 0;
    const refuse = (reason: string) => {
      viewer.close(PI_AGENT_WATCH_REFUSED, reason);
      connection.close();
    };
    return {
      receive: (message) => {
        if (connection.closed) {
          return;
        }
        const parsed = piAgentWatchMessage(message);
        if (parsed === null) {
          refuse("The viewer sent a message the agent cannot read.");
          return;
        }
        if (pending === VIEWER_PENDING_LIMIT) {
          refuse("The viewer sent more messages than the agent can take at once.");
          return;
        }
        pending += 1;
        void served.then(async (harness) => {
          pending -= 1;
          if (harness === null || connection.closed) {
            return;
          }
          const { subagent } = parsed;
          if (parsed.type === "unsubscribe") {
            subscriptions.get(subagent)?.close();
            subscriptions.delete(subagent);
            return;
          }
          if (subscriptions.has(subagent)) {
            return;
          }
          if (subscriptions.size === VIEWER_SUBAGENT_LIMIT) {
            unsubscribed(
              viewer,
              subagent,
              `A viewer follows at most ${VIEWER_SUBAGENT_LIMIT} subagents at once.`,
            );
            return;
          }
          const subscription = new PiAgentViewerConnection();
          subscriptions.set(subagent, subscription);
          const release = connection.hold(() => {
            subscription.close();
          });
          subscription.hold(() => {
            release();
            if (subscriptions.get(subagent) === subscription) {
              subscriptions.delete(subagent);
            }
          });
          await this.#serveSubscription(viewer, harness, subagent, subscription);
        });
      },
      disconnect: () => {
        connection.close();
      },
    };
  }

  /**
   * Sends the viewer the agent's queue, conversation, and subagents; resolves with the agent's
   * harness once it did, or null when the viewer was refused, closed, or disconnected.
   */
  async #serveViewer(
    viewer: PiAgentViewer,
    { agent, execution }: PiAgentViewing,
    connection: PiAgentViewerConnection,
  ): Promise<Harness | null> {
    try {
      this.#assertObjectIdentity(agent);
      const authorization = await this.#runtime.objects.piManager
        .for(agent.scope)
        .commands.authorizeViewer({ agentName: agent.agentName, execution });
      if (authorization.type === "refused") {
        viewer.close(PI_AGENT_WATCH_REFUSED, authorization.message);
        return null;
      }
      // The agent holds only the queues published to it, which a restart forgets.
      this.#viewers.publishQueue(authorization.queue);
      await this.#ready;
      if (!this.#provisioned) {
        viewer.close(PI_AGENT_WATCH_REFUSED, "Pi agent has no turns yet.");
        return null;
      }
      const opened = await this.#open(this.#provisioned);
      const view = await this.#viewers.watch(
        viewer,
        await opened.harness.root(BACKGROUND_CONTEXT),
        null,
        connection,
      );
      if (view === null) {
        return null;
      }
      // Changes the viewer gets from now on are read after these.
      const sending = this.#publishingSubagents.then(async () => {
        const frame = await this.#subagentsFrame(opened);
        if (!connection.closed) {
          viewer.send(JSON.stringify(frame));
        }
      });
      this.#publishingSubagents = sending.catch(() => {});
      await sending;
      return opened.harness;
    } catch (cause) {
      this.#closeUnservedViewer(viewer, cause);
      return null;
    }
  }

  /**
   * The subagents a viewer starts with: the oldest page of those that wait, the newest page of the
   * others, and those that run, however old. The queue says how many wait.
   */
  async #subagentsFrame({ harness, storage, subagents }: OpenPiAgent): Promise<PiAgentViewFrame> {
    const listed = await readWaitingPiSubagents(harness, SUBAGENT_PAGE_SIZE, BACKGROUND_CONTEXT);
    const read = async (taskId: TaskId, conversationId: ConversationId) =>
      await this.#listedSubagent(harness, storage, taskId, conversationId);
    const page = await listPiSubagents(storage, null, SUBAGENT_PAGE_SIZE, read, BACKGROUND_CONTEXT);
    listed.push(...page.subagents);
    for (const { taskId, conversationId } of subagents.running()) {
      if (page.older === null || conversationId > page.older.through) {
        continue;
      }
      const summary = await read(taskId, conversationId);
      if (summary) {
        listed.push(summary);
      }
    }
    return { type: "subagents", subagents: listed, older: page.older };
  }

  /**
   * A subagent as a list of them shows it; null for one it cannot read, which is reported, so the
   * others still show.
   */
  async #listedSubagent(
    harness: Harness,
    storage: Storage,
    taskId: TaskId,
    conversationId: ConversationId,
  ): Promise<PiSubagentSummary | null> {
    try {
      return await readPiSubagentSummary(
        harness,
        storage,
        taskId,
        conversationId,
        BACKGROUND_CONTEXT,
      );
    } catch (error) {
      this.#dependencies.report(error, this.#provisioned?.config ?? null);
      return null;
    }
  }

  /**
   * Sends the viewer the conversation of the subagent `requestId`, then every change. A subagent
   * it cannot send ends only that subscription.
   */
  async #serveSubscription(
    viewer: PiAgentViewer,
    harness: Harness,
    requestId: string,
    subscription: PiAgentViewerConnection,
  ): Promise<void> {
    try {
      const conversationId = await piSubagentConversation(harness, requestId, BACKGROUND_CONTEXT);
      if (subscription.closed) {
        return;
      }
      if (conversationId === null) {
        subscription.close();
        unsubscribed(viewer, requestId, "No subagent of this agent started for that request.");
        return;
      }
      await this.#viewers.watch(
        viewer,
        await this.#requireConversation(harness, conversationId),
        requestId,
        subscription,
      );
    } catch (cause) {
      subscription.close();
      if (cause instanceof PathError) {
        unsubscribed(viewer, requestId, PiConversationViewDamagedError.publicMessage);
      } else {
        this.#dependencies.report(cause, this.#provisioned?.config ?? null);
        unsubscribed(viewer, requestId, "The subagent's conversation is unavailable.");
      }
    }
  }

  /**
   * Takes back a viewer the object kept while it hibernated. It lost its view, so it is closed as
   * worth reconnecting after once the agent opens, or at once if it is open, until it disconnects.
   * What it sends meanwhile is dropped.
   */
  restoreViewer(viewer: PiAgentViewer): PiAgentViewerSession {
    const disconnect = this.#viewers.restore(viewer);
    if (this.#opened) {
      this.#viewers.closeHibernated();
    }
    return { receive: () => {}, disconnect };
  }

  #closeUnservedViewer(viewer: PiAgentViewer, cause: unknown) {
    if (cause instanceof PathError) {
      viewer.close(PI_AGENT_WATCH_REFUSED, PiConversationViewDamagedError.publicMessage);
    } else {
      this.#dependencies.report(cause, this.#provisioned?.config ?? null);
      viewer.close(1011, "The conversation is unavailable.");
    }
  }

  async reset(config: PiAgentConfig, rawTurn: PiAgentTurn | null): Promise<void> {
    const turn = piAgentTurnSchema.nullable().parse(rawTurn);
    const opened = await this.#requireAgent(config);
    const { harness } = opened;
    if (turn) {
      await this.#reloadSkills(opened, turn);
    }
    // A busy conversation queues the reset for its next boundary, which only a running wake reaches.
    await this.#state.storage.setAlarm(this.#nowEpochMs());
    await (await harness.root(BACKGROUND_CONTEXT)).reset(undefined, BACKGROUND_CONTEXT);
  }

  async abort(config: PiAgentConfig, revision: number): Promise<void> {
    const { harness } = await this.#requireAgent(config);
    // Stops arrive out of order; the latest one fences.
    const fence = await this.#state.storage.get<number>(STOP_FENCE_KEY);
    if (fence === undefined || fence < revision) {
      await this.#state.storage.put(STOP_FENCE_KEY, revision);
    }
    await this.#state.storage.setAlarm(this.#nowEpochMs());
    // Subagents' anchors are the root's background tasks, so this stops them too.
    await (await harness.root(BACKGROUND_CONTEXT)).abort(BACKGROUND_CONTEXT, { background: true });
  }

  async alarm(): Promise<void> {
    await this.#ready;
    if (!this.#provisioned) {
      return;
    }
    const opened = await this.#open(this.#provisioned);
    const { harness } = opened;
    await this.#state.storage.setAlarm(this.#nowEpochMs() + WAKE_HEARTBEAT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, WAKE_BUDGET_MS);
    const alarmContext = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
    try {
      // A billing delivery is a task too. It runs after the turns whose usage it bills, until no
      // work can run now; a sleeping task waits for the alarm armed below, not in this handler.
      let billingTaskId: Awaited<ReturnType<OpenPiAgent["billing"]["ensure"]>> = null;
      do {
        harness.resume();
        await this.#untilInactive(harness, controller.signal);
        if (billingTaskId !== null) {
          await opened.billing.assertNotFailed(harness, billingTaskId, alarmContext);
        }
        // A throw keeps the heartbeat alarm, which retries reports a restart or failure left behind.
        await opened.reportTurns(alarmContext);
        billingTaskId = await this.#ensureBillingDelivery(opened);
      } while (billingTaskId !== null && harness.wake().active);
    } catch (error) {
      if (!controller.signal.aborted) {
        throw error;
      }
    } finally {
      clearTimeout(timer);
    }
    await this.#state.blockConcurrencyWhile(async () => {
      await this.#ensureBillingDelivery(opened);
      const wake = harness.wake();
      // Work that can still run, or is being admitted, keeps the heartbeat.
      if (wake.active || this.#admitting > 0) {
        return;
      }
      // Parked tasks wait for a retry, so an agent with only those, or nothing, needs no wakeup.
      if (wake.at === undefined) {
        await this.#state.storage.deleteAlarm();
      } else {
        await this.#state.storage.setAlarm(wake.at);
      }
    });
  }

  /**
   * Resolves once no work of the agent can run now; it may still have sleeps ahead. Rejects when the
   * agent's session ends meanwhile, with the error of one that failed.
   */
  async #untilInactive(harness: Harness, signal: AbortSignal): Promise<void> {
    let waiter: PiAgentWaiter | null = null;
    // The earliest sleep this wait resumes; none is armed at `Infinity`.
    const sleep: { at: number; timer: ReturnType<typeof setTimeout> | undefined } = {
      at: Infinity,
      timer: undefined,
    };
    try {
      await new Promise<void>((resolve, reject) => {
        waiter = {
          wake: (wake) => {
            if (!wake.active) {
              resolve();
              return;
            }
            // Pi keeps no timers for sleeps, and while this alarm runs no other can, so a sleep that
            // comes due beside running work is resumed here. An armed timer stays until it fires: a
            // sleep overdue by then counts as active, without its time.
            const { at } = wake;
            if (at !== undefined && at < sleep.at) {
              clearTimeout(sleep.timer);
              sleep.at = at;
              sleep.timer = setTimeout(
                () => {
                  sleep.at = Infinity;
                  sleep.timer = undefined;
                  harness.resume();
                },
                Math.max(0, at - this.#nowEpochMs()),
              );
            }
          },
          closed: (end) => {
            if (end.kind === "closed") {
              reject(new Error("The Pi agent closed while its alarm waited."));
            } else {
              reject(
                end.error instanceof Error
                  ? end.error
                  : new Error("The Pi agent's session failed.", { cause: end.error }),
              );
            }
          },
        };
        this.#waiters.add(waiter);
        signal.addEventListener(
          "abort",
          () => {
            resolve();
          },
          { once: true },
        );
        if (signal.aborted) {
          resolve();
        } else {
          waiter.wake(harness.wake());
        }
      });
    } finally {
      if (waiter) {
        this.#waiters.delete(waiter);
      }
      clearTimeout(sleep.timer);
    }
    signal.throwIfAborted();
  }

  async close(): Promise<void> {
    await this.#ready;
    await this.#startup;
    await this.#opening;
    if (this.#opened) {
      await this.#opened.harness.close(BACKGROUND_CONTEXT);
      this.#opened = null;
    }
  }
}

/** Tells the viewer it follows the subagent `requestId` no longer, and why. */
function unsubscribed(viewer: PiAgentViewer, requestId: string, message: string) {
  viewer.send(
    JSON.stringify({
      type: "unsubscribed",
      subagent: requestId,
      message,
    } satisfies PiAgentViewFrame),
  );
}
