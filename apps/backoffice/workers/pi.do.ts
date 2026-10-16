import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { PathError } from "@earendil-works/chord/delta";
import { piAgentConfigSchema, type PiAgentConfig } from "@fragno-dev/backoffice-api/v0/pi";
import { DurableObject, RpcTarget } from "cloudflare:workers";
import type { PostHog } from "posthog-node";
import type { z } from "zod";

import { ConversationBusy, type EntryId, type Storage } from "@earendil-works/pi-durable";

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
  piAgentObjectName,
  piAgentPromptSchema,
  piAgentSubmissionWaitRequestSchema,
  piAgentTurnSchema,
  PiConversationViewDamagedError,
  type PiAgent,
  type PiAgentCompactionStatus,
  type PiAgentSubmissionWait,
  type PiAgentSubmitResult,
  type PiAgentTurn,
} from "@/fragno/pi/agent/pi-agent-contract";
import {
  createPiAgentDependencies,
  openPiAgentHarness,
  type OpenPiAgent,
  type PiAgentDependencies,
} from "@/fragno/pi/agent/pi-agent-harness";
import {
  mayJoinPiAgentTurn,
  readPiAgentRun,
  recordAdmittedPiAgentTurn,
  recordPiAgentCompactionTurn,
  recordPiAgentTurn,
  withdrawPiAgentTurn,
} from "@/fragno/pi/agent/pi-agent-turns";
import { createPiPostHogExtension } from "@/fragno/pi/extensions/posthog/posthog-extension";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import { createCloudflarePostHog, shutdownCloudflarePostHog } from "./lib/cloudflare-posthog";
import { openPiSessionStore } from "./lib/pi-session-store";

const AGENT_CONFIG_KEY = "pi-agent-config";
const WAKE_HEARTBEAT_MS = 30_000;
const WAKE_BUDGET_MS = 10 * 60_000;

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
  #config: PiAgentConfig | null = null;
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
      const config = await state.storage.get<PiAgentConfig>(AGENT_CONFIG_KEY);
      if (!config) {
        return;
      }
      this.#assertObjectIdentity(config);
      this.#config = config;
    });
    // Startup failures must not poison configuration readiness or prevent a later open from retrying.
    this.#startup = this.#ready
      .then(async () => {
        if (!this.#config) {
          return;
        }
        // Compiler RPC consumes caller-owned streams; its pulls need the input gate to be open.
        const opened = await this.#open(this.#config);
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

  async #open(config: PiAgentConfig): Promise<OpenPiAgent> {
    if (this.#opened) {
      return this.#opened;
    }
    if (this.#opening) {
      return await this.#opening;
    }
    // Once external work leaves the input gate, concurrent requests must still share one storage owner.
    const opening = openPiAgentHarness({
      config,
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
    return (
      (await opened.billing?.ensure(opened.harness, this.#nowEpochMs(), BACKGROUND_CONTEXT)) ?? null
    );
  }

  async #requireAgent(rawConfig: PiAgentConfig) {
    const config = piAgentConfigSchema.parse(rawConfig);
    this.#assertObjectIdentity(config);
    await this.#ready;
    await this.#state.blockConcurrencyWhile(async () => {
      if (this.#config) {
        if (JSON.stringify(this.#config) !== JSON.stringify(config)) {
          throw new Error("Pi agent provisioning configuration cannot be changed.");
        }
        return;
      }
      // Persist provisioning before opening Pi so a cold start can finish initialization.
      await this.#state.storage.put(AGENT_CONFIG_KEY, config);
      this.#config = config;
    });
    return await this.#open(config);
  }

  async initialize(config: PiAgentConfig): Promise<void> {
    await this.#requireAgent(config);
  }

  async submit(
    config: PiAgentConfig,
    rawTurn: PiAgentTurn,
    rawPrompt: z.infer<typeof piAgentPromptSchema>,
  ): Promise<PiAgentSubmitResult> {
    const prompt = piAgentPromptSchema.parse(rawPrompt);
    const turn = piAgentTurnSchema.parse(rawTurn);
    const opened = await this.#requireAgent(config);
    const { harness, storage } = opened;
    const root = await harness.root(BACKGROUND_CONTEXT);
    this.#admitting += 1;
    try {
      // The wake must be durable before Pi admits work, not after the HTTP request returns.
      await this.#state.storage.setAlarm(this.#nowEpochMs());
      const run = await readPiAgentRun(harness, storage, BACKGROUND_CONTEXT);
      const whenBusy =
        prompt.whenBusy === "steer" &&
        run.type === "running" &&
        (run.turn === null || !mayJoinPiAgentTurn(run.turn, turn))
          ? "followUp"
          : prompt.whenBusy;
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
        const submission = await root.submit(
          { type: "input", requestId: prompt.requestId, content: prompt.content, whenBusy },
          BACKGROUND_CONTEXT,
        );
        await recordAdmittedPiAgentTurn(harness, turn, BACKGROUND_CONTEXT);
        return {
          type: "admitted",
          submissionId: submission.id,
          requestId: prompt.requestId,
          whenBusy,
        };
      } catch (error) {
        // Withdrawal keeps the record of a submission Pi did admit before the failure.
        await withdrawPiAgentTurn(harness, prompt.requestId, BACKGROUND_CONTEXT);
        if (error instanceof ConversationBusy) {
          return { type: "busy" };
        }
        throw error;
      }
    } finally {
      this.#admitting -= 1;
    }
  }

  async getSubmission(config: PiAgentConfig, requestId: string): Promise<unknown> {
    const { storage, harness } = await this.#requireAgent(config);
    const root = await harness.root(BACKGROUND_CONTEXT);
    return (await storage.submissionByRequest(root.id, requestId, BACKGROUND_CONTEXT)) ?? null;
  }

  async waitForSubmission(
    config: PiAgentConfig,
    requestId: string,
    rawRequest: z.infer<typeof piAgentSubmissionWaitRequestSchema>,
  ): Promise<PiAgentSubmissionWait | null> {
    const request = piAgentSubmissionWaitRequestSchema.parse(rawRequest);
    const { storage, harness } = await this.#requireAgent(config);
    const root = await harness.root(BACKGROUND_CONTEXT);
    const record = await storage.submissionByRequest(root.id, requestId, BACKGROUND_CONTEXT);
    if (!record) {
      return null;
    }
    if (record.status === "done" || record.status === "unanswered") {
      return { status: "settled", submission: record };
    }
    const submission = await harness.submission(record.id, BACKGROUND_CONTEXT);
    if (!submission) {
      return null;
    }

    const controller = new AbortController();
    const timeoutReason = new Error("PI_AGENT_SUBMISSION_WAIT_TIMED_OUT");
    const timer = setTimeout(() => {
      controller.abort(timeoutReason);
    }, request.waitMs);
    try {
      return {
        status: "settled",
        submission: await submission.wait(withAbortSignal(controller.signal, BACKGROUND_CONTEXT)),
      };
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

  async abort(config: PiAgentConfig): Promise<void> {
    const { harness } = await this.#requireAgent(config);
    await this.#state.storage.setAlarm(this.#nowEpochMs());
    await (await harness.root(BACKGROUND_CONTEXT)).abort(BACKGROUND_CONTEXT, { background: true });
  }

  async alarm(): Promise<void> {
    await this.#ready;
    if (!this.#config) {
      return;
    }
    const opened = await this.#open(this.#config);
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
      await opened.billing?.flush(harness, this.#nowEpochMs, alarmContext);
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
  async submit(
    config: PiAgentConfig,
    turn: PiAgentTurn,
    prompt: z.infer<typeof piAgentPromptSchema>,
  ) {
    return await this.#object.submit(config, turn, prompt);
  }
  async getSubmission(config: PiAgentConfig, requestId: string): Promise<unknown> {
    return await this.#object.getSubmission(config, requestId);
  }
  async waitForSubmission(
    config: PiAgentConfig,
    requestId: string,
    request: z.infer<typeof piAgentSubmissionWaitRequestSchema>,
  ): Promise<PiAgentSubmissionWait | null> {
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
  async abort(config: PiAgentConfig): Promise<void> {
    await this.#object.abort(config);
  }
  async alarm(): Promise<void> {
    await this.#object.alarm();
  }
}
