import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { PathError } from "@earendil-works/chord/delta";
import { piAgentConfigSchema, type PiAgentConfig } from "@fragno-dev/backoffice-api/v0/pi";
import {
  backofficeContextScopeSchema,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { DurableObject, RpcTarget } from "cloudflare:workers";
import type { PostHog } from "posthog-node";
import { z } from "zod";

import { copyJson } from "@earendil-works/chord";
import {
  type EntryId,
  type JsonObject,
  type Storage,
  type SubmissionRecord,
} from "@earendil-works/pi-durable";

import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import { readPiCompactionStatus } from "@/fragno/pi/agent/compaction-status";
import {
  createPiConversationExportStream,
  createPiConversationViewNdjsonStream,
} from "@/fragno/pi/agent/conversation-streams";
import {
  piAgentCompactionSchema,
  piAgentEntryPageRequestSchema,
  piAgentNotificationSchema,
  piAgentObjectName,
  piAgentPromptSchema,
  piAgentSubmissionWaitRequestSchema,
  piAgentTurnSchema,
  piAgentWorkSchema,
  PiConversationViewDamagedError,
  type PiAgent,
  type PiAgentCompactionStatus,
  type PiAgentNotification,
  type PiAgentPrompt,
  type PiAgentSubmissionWait,
  type PiAgentTurn,
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
  waitForPiAgentSubmission,
  withdrawPiAgentTurn,
} from "@/fragno/pi/agent/pi-agent-turns";
import { createPiPostHogExtension } from "@/fragno/pi/extensions/posthog/posthog-extension";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import { createCloudflarePostHog, shutdownCloudflarePostHog } from "./lib/cloudflare-posthog";
import { openPiSessionStore } from "./lib/pi-session-store";

const AGENT_CONFIG_KEY = "pi-agent-config";
const LEGACY_BILLING_SCOPE_KEY = "pi-legacy-billing-scope";
const WAKE_HEARTBEAT_MS = 30_000;
const WAKE_BUDGET_MS = 10 * 60_000;

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
        // Compiler RPC consumes caller-owned streams; its pulls need the input gate to be open.
        const opened = await this.#open(this.#provisioned);
        const billingTaskId = await this.#ensureBillingDelivery(opened);
        if (
          billingTaskId !== null ||
          (await opened.harness.inspect(BACKGROUND_CONTEXT)).tasks.length > 0
        ) {
          await state.storage.setAlarm(this.#nowEpochMs());
        }
      })
      .catch((error: unknown) => {
        this.#dependencies.report(error);
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
    const opening = openPiAgentHarness({
      config,
      legacyBillingScope,
      runtime: this.#runtime,
      dependencies: this.#dependencies,
      openStorage: this.#openStorage,
      nowEpochMs: this.#nowEpochMs,
    });
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
        await opened.refreshWorkspaceExtensions(turn);
        const { model } = await root.agent(BACKGROUND_CONTEXT);
        if (
          model?.provider !== turn.agent.model.provider ||
          model.modelId !== turn.agent.model.modelId
        ) {
          await root.configure({ model: turn.agent.model }, BACKGROUND_CONTEXT);
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

  async waitForSubmission(
    config: PiAgentConfig,
    requestId: string,
    rawRequest: z.infer<typeof piAgentSubmissionWaitRequestSchema>,
  ): Promise<PiAgentSubmissionWait> {
    const request = piAgentSubmissionWaitRequestSchema.parse(rawRequest);
    const { storage, harness } = await this.#requireAgent(config);
    const controller = new AbortController();
    const timeoutReason = new Error("PI_AGENT_SUBMISSION_WAIT_TIMED_OUT");
    const timer = setTimeout(() => {
      controller.abort(timeoutReason);
    }, request.waitMs);
    const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
    try {
      const record = await waitForPiAgentSubmission(harness, storage, requestId, context);
      if (record.status === "done" || record.status === "unanswered") {
        return { status: "settled", submission: record };
      }
      const submission = await harness.submission(record.id, context);
      if (!submission) {
        return { status: "pending", submission: null };
      }
      return { status: "settled", submission: await submission.wait(context) };
    } catch (cause) {
      if (controller.signal.aborted && controller.signal.reason === timeoutReason) {
        return { status: "pending", submission: null };
      }
      throw cause;
    } finally {
      clearTimeout(timer);
    }
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

  async watchView(config: PiAgentConfig): Promise<ReadableStream<Uint8Array>> {
    const { harness } = await this.#requireAgent(config);
    const root = await harness.root(BACKGROUND_CONTEXT);
    try {
      return createPiConversationViewNdjsonStream(await root.watch(BACKGROUND_CONTEXT));
    } catch (cause) {
      if (!(cause instanceof PathError)) {
        throw cause;
      }
      throw new PiConversationViewDamagedError(config.agentName, cause);
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
    harness.resume();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, WAKE_BUDGET_MS);
    const alarmContext = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
    try {
      // Keep the alarm invocation alive while Pi runs; a persisted heartbeat covers eviction.
      await harness.waitForIdle(alarmContext);
      // A throw keeps the heartbeat alarm, which retries reports a restart or failure left behind.
      await opened.reportSettledTurns(alarmContext);
      await opened.billing.flush(harness, this.#nowEpochMs, alarmContext);
    } catch (error) {
      if (!controller.signal.aborted) {
        throw error;
      }
    } finally {
      clearTimeout(timer);
    }
    await this.#state.blockConcurrencyWhile(async () => {
      await this.#ensureBillingDelivery(opened);
      const { tasks } = await harness.inspect(BACKGROUND_CONTEXT);
      if (tasks.length === 0 && this.#admitting === 0) {
        await this.#state.storage.deleteAlarm();
      }
    });
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

/** One durable agent per object; scoped managers own agent discovery. */
export class Pi extends DurableObject<CloudflareEnv> implements PiAgent {
  readonly #object: InMemoryPiObject;

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
      openStorage: () => openPiSessionStore(state.storage),
      idFromConfig: (config) => env.PI.idFromName(piAgentObjectName(config)),
      nowEpochMs: Date.now,
    });
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
  async waitForSubmission(
    config: PiAgentConfig,
    requestId: string,
    request: z.infer<typeof piAgentSubmissionWaitRequestSchema>,
  ): Promise<PiAgentSubmissionWait> {
    return await this.#object.waitForSubmission(config, requestId, request);
  }
  async listEntries(config: PiAgentConfig, request: z.infer<typeof piAgentEntryPageRequestSchema>) {
    return await this.#object.listEntries(config, request);
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
  async watchView(config: PiAgentConfig): Promise<ReadableStream<Uint8Array>> {
    return await this.#object.watchView(config);
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
