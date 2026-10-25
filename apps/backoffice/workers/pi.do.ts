import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { PathError } from "@earendil-works/chord/delta";
import { boundOutput } from "@earendil-works/chord/output";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import {
  PI_AGENT_WATCH_REFUSED,
  piAgentConfigSchema,
  type PiAgentConfig,
} from "@fragno-dev/backoffice-api/v0/pi";
import {
  backofficeContextScopeSchema,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { DurableObject, RpcTarget } from "cloudflare:workers";
import type { PostHog } from "posthog-node";
import { z } from "zod";

import { copyJson } from "@earendil-works/chord";
import {
  type ConversationView,
  type EntryId,
  type JsonObject,
  type Harness,
  type SessionEnd,
  type Storage,
  type SubmissionRecord,
  type Wake,
  type WatchHandle,
} from "@earendil-works/pi-durable";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { verifyAuthorizedBackofficeObjectRequest } from "@/backoffice-runtime/internal-object-request";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import { readPiCompactionStatus } from "@/fragno/pi/agent/compaction-status";
import { listPiConversationMessages } from "@/fragno/pi/agent/conversation-messages";
import { createPiConversationExportStream } from "@/fragno/pi/agent/conversation-streams";
import {
  piAgentCompactionSchema,
  piAgentEntryPageRequestSchema,
  piAgentMessagePageRequestSchema,
  piAgentNotificationSchema,
  piAgentObjectName,
  piAgentPromptSchema,
  piAgentTurnSchema,
  piAgentWorkSchema,
  PiConversationViewDamagedError,
  type PiAgent,
  type PiAgentCompactionStatus,
  type PiAgentNotification,
  type PiAgentPrompt,
  type PiAgentTurn,
  type PiAgentViewFrame,
  type PiAgentWaitingQueue,
  type PiAgentWork,
} from "@/fragno/pi/agent/pi-agent-contract";
import {
  createPiAgentDependencies,
  openPiAgentHarness,
  type OpenPiAgent,
  type PiAgentDependencies,
} from "@/fragno/pi/agent/pi-agent-harness";
import {
  PI_NOTIFICATION_ENTRY_KIND,
  piNotificationRequestId,
  renderPiNotification,
  renderPiNotificationRequest,
} from "@/fragno/pi/agent/pi-agent-notification-entry";
import { mayJoinPiAgentTurn } from "@/fragno/pi/agent/pi-agent-queue-rules";
import {
  readPiAgentRun,
  recordAdmittedPiAgentTurn,
  recordPiAgentCompactionTurn,
  recordPiAgentTurn,
  withdrawPiAgentTurn,
} from "@/fragno/pi/agent/pi-agent-turns";
import { createPiPostHogExtension } from "@/fragno/pi/extensions/posthog/posthog-extension";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import { createCloudflarePostHog, shutdownCloudflarePostHog } from "./lib/cloudflare-posthog";

const AGENT_CONFIG_KEY = "pi-agent-config";
const LEGACY_BILLING_SCOPE_KEY = "pi-legacy-billing-scope";
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
type PiAgentViewing = { agent: PiAgentConfig; execution: BackofficeExecutionContext };

/** A view socket, as either runtime's WebSocket offers it to `connectViewer`. */
type PiAgentViewer = {
  /** Sends one JSON-encoded `PiAgentViewFrame`. */
  send(message: string): void;
  close(code: number, reason: string): void;
};

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

/** Shared durable agent lifecycle; both runtimes persist an alarm before admitting work. */
export class InMemoryPiObject extends RpcTarget implements PiAgent {
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
  // An alarm waiting for the agent's work to stop follows its wakeups and its session's end.
  readonly #waiters = new Set<PiAgentWaiter>();
  // Only the manager knows the queue; it publishes every change, and before each viewer connects.
  // Hibernation forgets it, so the first publication after waking is taken whatever its revision.
  #queue: PiAgentWaitingQueue | null = null;
  readonly #viewers = new Set<PiAgentViewer>();
  // Viewers a hibernated object kept, which lost their watch with its memory, until it opens again.
  readonly #restoredViewers = new Set<PiAgentViewer>();
  // One watch serves every viewer, so each commit is encoded once. It stays open until it ends.
  #viewWatch: Promise<WatchHandle<ConversationView>> | null = null;

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
      if ("billingOrganizationId" in stored) {
        const organizationId = z.string().nullable().parse(stored.billingOrganizationId);
        const legacyBillingScope: BackofficeContextScope =
          organizationId === null ? { kind: "system" } : { kind: "org", orgId: organizationId };
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
      // Before anything else uses the agent, so no commit can reach the viewers as ops they miss.
      await this.#serveRestoredViewers(opened.harness);
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
    turn: PiAgentTurn,
    prompt: PiAgentPrompt,
    whenBusy: "steer" | "followUp",
  ): Promise<void> {
    const { harness } = opened;
    const root = await harness.root(BACKGROUND_CONTEXT);
    this.#admitting += 1;
    try {
      // The wake must be durable before Pi admits work, not after the HTTP request returns.
      await this.#state.storage.setAlarm(this.#nowEpochMs());
      await recordPiAgentTurn(harness, prompt.requestId, turn, BACKGROUND_CONTEXT);
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
          { type: "input", requestId: prompt.requestId, content: prompt.content, whenBusy },
          BACKGROUND_CONTEXT,
        );
        await recordAdmittedPiAgentTurn(harness, turn, BACKGROUND_CONTEXT);
      } catch (error) {
        // Withdrawal keeps the record of a submission Pi did admit before the failure.
        await withdrawPiAgentTurn(harness, prompt.requestId, BACKGROUND_CONTEXT);
        throw error;
      }
    } finally {
      this.#admitting -= 1;
    }
  }

  async steer(config: PiAgentConfig, rawTurn: PiAgentTurn, rawPrompt: PiAgentPrompt) {
    const prompt = piAgentPromptSchema.parse(rawPrompt);
    const turn = piAgentTurnSchema.parse(rawTurn);
    const opened = await this.#requireAgent(config);
    const root = await opened.harness.root(BACKGROUND_CONTEXT);
    if (await opened.storage.submissionByRequest(root.id, prompt.requestId, BACKGROUND_CONTEXT)) {
      return;
    }
    const run = await readPiAgentRun(opened.harness, opened.storage, BACKGROUND_CONTEXT);
    // The manager's dispatched turn may have just ended; a steer never joins another authority's.
    const joins = run.type === "running" && run.turn !== null && mayJoinPiAgentTurn(run.turn, turn);
    await this.#admit(opened, turn, prompt, joins ? "steer" : "followUp");
  }

  async dispatch(config: PiAgentConfig, rawTurn: PiAgentTurn, rawWork: PiAgentWork) {
    const work = piAgentWorkSchema.parse(rawWork);
    const turn = piAgentTurnSchema.parse(rawTurn);
    const opened = await this.#requireAgent(config);
    const root = await opened.harness.root(BACKGROUND_CONTEXT);
    // A turn handed over again keeps the submission and turn Pi already has for it.
    if (await opened.storage.submissionByRequest(root.id, work.requestId, BACKGROUND_CONTEXT)) {
      return;
    }
    if (work.type === "prompt") {
      // Only a steer that outlived its turn can still be running; Pi queues the prompt behind it.
      await this.#admit(opened, turn, work, "followUp");
      return;
    }
    // Cards written when their notifications arrived are kept where they are.
    await this.#writeNotifications(opened, work.notifications);
    await this.#admit(
      opened,
      turn,
      {
        requestId: work.requestId,
        content: renderPiNotificationRequest(
          work.notifications.map(({ routeId, event }) => ({ routeId, eventId: event.id })),
        ),
      },
      "followUp",
    );
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
            data: copyJson(notification) as JsonObject,
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

  async getSubmission(config: PiAgentConfig, requestId: string): Promise<SubmissionRecord | null> {
    const { storage, harness } = await this.#requireAgent(config);
    const root = await harness.root(BACKGROUND_CONTEXT);
    return (await storage.submissionByRequest(root.id, requestId, BACKGROUND_CONTEXT)) ?? null;
  }

  async listEntries(
    config: PiAgentConfig,
    rawRequest: z.infer<typeof piAgentEntryPageRequestSchema>,
  ) {
    const request = piAgentEntryPageRequestSchema.parse(rawRequest);
    const { harness } = await this.#requireAgent(config);
    const root = await harness.root(BACKGROUND_CONTEXT);
    const page = await root.entries(
      // Pi's entry bounds are inclusive.
      { maxEntryId: (request.before - 1) as EntryId },
      request.pageSize,
      request.cursor ?? undefined,
      BACKGROUND_CONTEXT,
    );
    return { entries: page.items, cursor: page.next ?? null };
  }

  async listMessages(
    config: PiAgentConfig,
    rawRequest: z.infer<typeof piAgentMessagePageRequestSchema>,
  ) {
    const request = piAgentMessagePageRequestSchema.parse(rawRequest);
    const { harness } = await this.#requireAgent(config);
    return await listPiConversationMessages(await harness.root(BACKGROUND_CONTEXT), request);
  }

  async exportEntries(config: PiAgentConfig): Promise<ReadableStream<Uint8Array>> {
    const { harness } = await this.#requireAgent(config);
    return createPiConversationExportStream(await harness.root(BACKGROUND_CONTEXT), config);
  }

  async compact(
    config: PiAgentConfig,
    rawTurn: PiAgentTurn,
    rawRequest: z.infer<typeof piAgentCompactionSchema>,
  ): Promise<{ taskId: number }> {
    const request = piAgentCompactionSchema.parse(rawRequest);
    const turn = piAgentTurnSchema.parse(rawTurn);
    const { harness } = await this.#requireAgent(config);
    this.#admitting += 1;
    try {
      await this.#state.storage.setAlarm(this.#nowEpochMs());
      await recordPiAgentCompactionTurn(harness, turn, BACKGROUND_CONTEXT);
      const taskId = await (
        await harness.root(BACKGROUND_CONTEXT)
      ).compact(request.instructions ?? undefined, BACKGROUND_CONTEXT);
      return { taskId };
    } finally {
      this.#admitting -= 1;
    }
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

  async getView(config: PiAgentConfig): Promise<unknown> {
    const { harness } = await this.#requireAgent(config);
    const root = await harness.root(BACKGROUND_CONTEXT);
    try {
      const view = await root.viewState(BACKGROUND_CONTEXT);
      try {
        return view.value;
      } finally {
        view.dispose();
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
    if (this.#queue && this.#queue.revision >= queue.revision) {
      return;
    }
    this.#queue = queue;
    // Queue frames do not build on the view, so viewers still waiting for theirs get them too.
    this.#broadcast({ type: "queue", paused: queue.paused, items: queue.items }, [
      ...this.#viewers,
      ...this.#restoredViewers,
    ]);
  }

  #broadcast(frame: PiAgentViewFrame, viewers: Iterable<PiAgentViewer>) {
    let message: string | null = null;
    for (const viewer of viewers) {
      message ??= JSON.stringify(frame);
      viewer.send(message);
    }
  }

  // Concurrent connections share the opening watch; a watch that failed or ended is opened again.
  #watchView(harness: Harness) {
    if (this.#viewWatch) {
      return this.#viewWatch;
    }
    const watching = (async () => {
      const watch = await (await harness.root(BACKGROUND_CONTEXT)).watch(BACKGROUND_CONTEXT);
      // Each frame's ops turn the previous frame's view into this one's, so viewers that start
      // from any delivered view stay exact.
      watch.start(async (_view, ops) => {
        this.#broadcast({ type: "ops", ops }, this.#viewers);
      });
      // The watch ends with the agent's session, as when the object closes; viewers reconnect.
      void watch.closed.then(() => {
        if (this.#viewWatch === watching) {
          this.#viewWatch = null;
        }
        const viewers = [...this.#viewers];
        this.#viewers.clear();
        for (const viewer of viewers) {
          viewer.close(1012, "The conversation closed.");
        }
      });
      return watch;
    })();
    this.#viewWatch = watching;
    watching.catch(() => {
      if (this.#viewWatch === watching) {
        this.#viewWatch = null;
      }
    });
    return watching;
  }

  /**
   * Sends the viewer the queue and the whole conversation view, then every change to either, until
   * the returned function disconnects it. The manager decides whether the viewer may watch; a
   * viewer it refuses, or that the agent cannot serve, is closed instead.
   */
  async connectViewer(
    viewer: PiAgentViewer,
    { agent, execution }: PiAgentViewing,
  ): Promise<() => void> {
    let watching: Promise<WatchHandle<ConversationView>>;
    let watch: WatchHandle<ConversationView>;
    try {
      this.#assertObjectIdentity(agent);
      const authorization = await this.#runtime.objects.piManager
        .for(agent.scope)
        .commands.authorizeViewer({ agentName: agent.agentName, execution });
      if (authorization.type === "refused") {
        viewer.close(PI_AGENT_WATCH_REFUSED, authorization.message);
        return () => {};
      }
      // The agent holds only the queues published to it, which a restart forgets.
      await this.publishQueue(authorization.queue);
      await this.#ready;
      if (!this.#provisioned) {
        viewer.close(PI_AGENT_WATCH_REFUSED, "Pi agent has no turns yet.");
        return () => {};
      }
      const { harness } = await this.#open(this.#provisioned);
      watching = this.#watchView(harness);
      watch = await watching;
    } catch (cause) {
      this.#closeUnservedViewer(viewer, cause);
      return () => {};
    }
    if (this.#viewWatch !== watching) {
      viewer.close(1012, "The conversation closed.");
      return () => {};
    }
    if (this.#queue) {
      viewer.send(
        JSON.stringify({
          type: "queue",
          paused: this.#queue.paused,
          items: this.#queue.items,
        } satisfies PiAgentViewFrame),
      );
    }
    // `value` is the latest view the watch delivered, and every delivery is broadcast at once, so
    // the first ops this viewer receives start from this view.
    viewer.send(JSON.stringify({ type: "view", view: watch.value } satisfies PiAgentViewFrame));
    this.#viewers.add(viewer);
    return () => {
      this.#viewers.delete(viewer);
    };
  }

  /**
   * Takes back a viewer that had its view when the object hibernated. Once the agent opens, the
   * viewer gets the whole view again, then every change, until the returned function disconnects it.
   */
  restoreViewer(viewer: PiAgentViewer): () => void {
    this.#restoredViewers.add(viewer);
    // An agent opened before the viewer came back serves it now; an opening one serves it once open.
    if (this.#opened) {
      void this.#serveRestoredViewers(this.#opened.harness);
    }
    return () => {
      this.#restoredViewers.delete(viewer);
      this.#viewers.delete(viewer);
    };
  }

  // Recovery on opening may commit what the viewers never saw, so each starts again from a whole view.
  async #serveRestoredViewers(harness: Harness): Promise<void> {
    if (this.#restoredViewers.size === 0) {
      return;
    }
    let watch: WatchHandle<ConversationView>;
    try {
      watch = await this.#watchView(harness);
    } catch (cause) {
      for (const viewer of this.#restoredViewers) {
        this.#closeUnservedViewer(viewer, cause);
      }
      this.#restoredViewers.clear();
      return;
    }
    const message = JSON.stringify({ type: "view", view: watch.value } satisfies PiAgentViewFrame);
    for (const viewer of this.#restoredViewers) {
      viewer.send(message);
      this.#viewers.add(viewer);
    }
    this.#restoredViewers.clear();
  }

  #closeUnservedViewer(viewer: PiAgentViewer, cause: unknown) {
    if (cause instanceof PathError) {
      viewer.close(PI_AGENT_WATCH_REFUSED, PiConversationViewDamagedError.publicMessage);
    } else {
      this.#dependencies.report(cause, this.#provisioned?.config ?? null);
      viewer.close(1011, "The conversation is unavailable.");
    }
  }

  async reset(config: PiAgentConfig): Promise<void> {
    const { harness } = await this.#requireAgent(config);
    // A busy conversation queues the reset for its next boundary, which only a running wake reaches.
    await this.#state.storage.setAlarm(this.#nowEpochMs());
    await (await harness.root(BACKGROUND_CONTEXT)).reset(undefined, BACKGROUND_CONTEXT);
  }

  async abort(config: PiAgentConfig): Promise<void> {
    const { harness } = await this.#requireAgent(config);
    await this.#state.storage.setAlarm(this.#nowEpochMs());
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
            if (end.reason === "closed") {
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

/** A view socket as the agent sends to it; a socket that closes meanwhile drops what it is sent. */
function piAgentSocketViewer(socket: WebSocket): PiAgentViewer {
  return {
    send(message) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message);
      }
    },
    close(code, reason) {
      socket.close(code, closeReason(reason));
    },
  };
}

// close() throws on a reason over 123 UTF-8 bytes, which would turn a refusal into an unavailable
// close that viewers reconnect after. Denials name actors and grants, so they can be longer.
function closeReason(reason: string) {
  const bounded = boundOutput(reason, { maxBytes: 120, maxLines: 1, retain: "head" });
  return bounded.droppedBytes === 0 ? reason : `${bounded.text.trimEnd()}…`;
}

/** One durable agent per object; scoped managers own agent discovery. */
export class Pi extends DurableObject<CloudflareEnv> implements PiAgent {
  readonly #object: InMemoryPiObject;
  // View sockets hibernate with the object, so they outlive this map, which `ctx` restores.
  readonly #disconnects = new Map<WebSocket, Promise<() => void>>();

  constructor(
    state: DurableObjectState,
    env: CloudflareEnv,
    dependencies: PiAgentDependencies = createPiAgentDependencies(env),
  ) {
    super(state, env);
    const analyticsEnabled =
      import.meta.env.BACKOFFICE_TARGET === "cloudflare" &&
      import.meta.env.PROD &&
      Boolean(env.POSTHOG_PROJECT_TOKEN);
    async function queuePiGenerationEvent(event: Parameters<PostHog["capture"]>[0]) {
      const client = await createCloudflarePostHog(env);
      if (!client) {
        return;
      }
      try {
        client.capture(event);
      } finally {
        state.waitUntil(shutdownCloudflarePostHog(client));
      }
    }
    this.#object = new InMemoryPiObject({
      state,
      dependencies: analyticsEnabled
        ? {
            ...dependencies,
            extensions: (config, agent) => [
              ...dependencies.extensions(config, agent),
              createPiPostHogExtension({ config, agent, capture: queuePiGenerationEvent }),
            ],
          }
        : dependencies,
      runtime: createCloudflareDurableObjectRuntimeServices(env, state),
      openStorage: () => openPiAgentStorage(state.storage),
      idFromConfig: (config) => env.PI.idFromName(piAgentObjectName(config)),
      nowEpochMs: Date.now,
    });
    // An object woken from hibernation still has the view sockets it accepted; each had its view.
    // Only sockets with their view stay accepted while the object can hibernate: one that has none
    // yet is still connecting, which keeps the object awake, or was closed instead.
    for (const socket of state.getWebSockets()) {
      this.#disconnects.set(
        socket,
        Promise.resolve(this.#object.restoreViewer(piAgentSocketViewer(socket))),
      );
    }
  }

  async initialize(config: PiAgentConfig): Promise<void> {
    await this.#object.initialize(config);
  }

  async warm(): Promise<void> {
    await this.#object.warm();
  }
  async steer(config: PiAgentConfig, turn: PiAgentTurn, prompt: PiAgentPrompt) {
    await this.#object.steer(config, turn, prompt);
  }
  async dispatch(config: PiAgentConfig, turn: PiAgentTurn, work: PiAgentWork) {
    await this.#object.dispatch(config, turn, work);
  }
  async writeNotifications(config: PiAgentConfig, notifications: PiAgentNotification[]) {
    await this.#object.writeNotifications(config, notifications);
  }
  async getSubmission(config: PiAgentConfig, requestId: string): Promise<SubmissionRecord | null> {
    return await this.#object.getSubmission(config, requestId);
  }
  async listEntries(config: PiAgentConfig, request: z.infer<typeof piAgentEntryPageRequestSchema>) {
    return await this.#object.listEntries(config, request);
  }
  async listMessages(
    config: PiAgentConfig,
    request: z.infer<typeof piAgentMessagePageRequestSchema>,
  ) {
    return await this.#object.listMessages(config, request);
  }
  async exportEntries(config: PiAgentConfig): Promise<ReadableStream<Uint8Array>> {
    return await this.#object.exportEntries(config);
  }
  async compact(
    config: PiAgentConfig,
    turn: PiAgentTurn,
    request: z.infer<typeof piAgentCompactionSchema>,
  ): Promise<{ taskId: number }> {
    return await this.#object.compact(config, turn, request);
  }
  async getCompaction(
    config: PiAgentConfig,
    taskId: number,
  ): Promise<PiAgentCompactionStatus | null> {
    return await this.#object.getCompaction(config, taskId);
  }
  async getView(config: PiAgentConfig): Promise<unknown> {
    return await this.#object.getView(config);
  }
  async publishQueue(queue: PiAgentWaitingQueue): Promise<void> {
    await this.#object.publishQueue(queue);
  }
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("A Pi agent serves only its view socket.", { status: 426 });
    }
    let viewing: PiAgentViewing;
    try {
      // The request names the agent, so its signature can be checked before the agent is read.
      const agent = piAgentConfigSchema.parse(
        JSON.parse(new URL(request.url).searchParams.get("agent") ?? "null"),
      );
      const verified = await verifyAuthorizedBackofficeObjectRequest({
        request,
        address: { binding: "PI", agent },
        env: this.env,
      });
      viewing = { agent, execution: verified.context.execution };
    } catch (cause) {
      return Response.json(
        {
          code: "INVALID_INTERNAL_CONTEXT",
          message: cause instanceof Error ? cause.message : "Invalid view socket request.",
        },
        { status: 401 },
      );
    }
    const { 0: client, 1: server } = new WebSocketPair();
    // Hibernatable: an idle agent's open sockets do not keep the object in memory.
    this.ctx.acceptWebSocket(server);
    this.#disconnects.set(server, this.#object.connectViewer(piAgentSocketViewer(server), viewing));
    return new Response(null, { status: 101, webSocket: client });
  }
  // Viewers send nothing; the socket carries only the agent's frames.
  async webSocketMessage(): Promise<void> {}
  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    this.#disconnect(socket);
    try {
      socket.close(code, reason);
    } catch {
      // A code such as 1005 cannot be sent back, and a socket may already have closed.
    }
  }
  async webSocketError(socket: WebSocket): Promise<void> {
    this.#disconnect(socket);
  }
  #disconnect(socket: WebSocket) {
    const disconnecting = this.#disconnects.get(socket);
    this.#disconnects.delete(socket);
    void disconnecting?.then((disconnect) => {
      disconnect();
    });
  }
  async reset(config: PiAgentConfig): Promise<void> {
    await this.#object.reset(config);
  }
  async abort(config: PiAgentConfig): Promise<void> {
    await this.#object.abort(config);
  }
  async alarm(): Promise<void> {
    await this.#object.alarm();
  }
}
