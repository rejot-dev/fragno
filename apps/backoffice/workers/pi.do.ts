import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { PathError } from "@earendil-works/chord/delta";
import { DurableObject, RpcTarget } from "cloudflare:workers";
import type { z } from "zod";

import {
  createRegistry,
  Harness,
  type CompactionResult,
  type Conversation,
  type ConversationView,
  type Cursor,
  type HarnessOptions,
  type Storage,
  type TaskId,
  type WatchHandle,
} from "@earendil-works/pi-durable";

import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import {
  piAgentCompactionSchema,
  piAgentConfigSchema,
  piAgentEntryPageRequestSchema,
  piAgentObjectName,
  piAgentPromptSchema,
  piAgentSubmissionWaitRequestSchema,
  PiConversationViewDamagedError,
  type PiAgent,
  type PiAgentCompactionStatus,
  type PiAgentConfig,
  type PiAgentSubmissionWait,
} from "@/fragno/pi-manager/pi-agent-contract";
import { PI_THINKING_LEVEL } from "@/fragno/pi/pi-shared";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import { createCloudflarePostHog, shutdownCloudflarePostHog } from "./lib/cloudflare-posthog";
import { createBackofficePiDurableHarnessOptions } from "./lib/pi-durable-backoffice";
import {
  calculatePiDurableBillingRetryDelayMs,
  createPiDurableBillingTask,
  ensurePiDurableBillingTask,
  flushPiDurableBilling,
  type PiDurableBillingTask,
} from "./lib/pi-durable-billing";
import { createPiDurableHarnessOptions } from "./lib/pi-durable-harness-options";
import { createPiPostHogExtension } from "./lib/pi-posthog-extension";
import { openPiSessionStore } from "./lib/pi-session-store";

const AGENT_CONFIG_KEY = "pi-agent-config";
const WAKE_HEARTBEAT_MS = 30_000;
const WAKE_BUDGET_MS = 10 * 60_000;
const ENTRY_SCAN_PAGE_SIZE = 256;

type OpenPiAgent = {
  harness: Harness;
  storage: Storage;
  billingTask: PiDurableBillingTask | null;
};

function encodePiConversationViewFrame(type: "snapshot" | "update", view: ConversationView) {
  return new TextEncoder().encode(`${JSON.stringify({ type, view })}\n`);
}

function createPiConversationViewNdjsonStream(watch: WatchHandle<ConversationView>) {
  let cancelled = false;
  let pendingPulls = 0;
  let releaseBackpressure: (() => void) | null = null;

  return new ReadableStream<Uint8Array>({
    type: "bytes",
    start(controller) {
      controller.enqueue(encodePiConversationViewFrame("snapshot", watch.value));
      watch.start(async (view) => {
        if (!cancelled && (controller.desiredSize ?? 0) <= 0) {
          if (pendingPulls > 0) {
            pendingPulls -= 1;
          } else {
            await new Promise<void>((resolve) => {
              releaseBackpressure = resolve;
            });
            releaseBackpressure = null;
          }
        }
        if (!cancelled) {
          controller.enqueue(encodePiConversationViewFrame("update", view));
        }
      });
      void watch.closed.then((end) => {
        if (cancelled) {
          return;
        }
        if (end.reason === "listener_error") {
          controller.error(end.error);
          return;
        }
        controller.close();
      });
    },
    pull() {
      if (releaseBackpressure) {
        releaseBackpressure();
        return;
      }
      pendingPulls += 1;
    },
    async cancel() {
      cancelled = true;
      releaseBackpressure?.();
      await watch.stop();
    },
  });
}

function encodePiExportLine(value: unknown) {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

function createPiConversationExportStream(root: Conversation, config: PiAgentConfig) {
  async function* exportLines() {
    yield encodePiExportLine({
      type: "pi-durable-session",
      version: 1,
      order: "newest-first",
      session: {
        sessionId: config.sessionId,
        scope: config.scope,
        name: config.name,
        model: config.model,
        instructions: config.instructions,
      },
    });

    let cursor: Cursor | undefined;
    do {
      const page = await root.entries({}, ENTRY_SCAN_PAGE_SIZE, cursor, BACKGROUND_CONTEXT);
      for (const entry of page.items) {
        yield encodePiExportLine({ type: "entry", entry });
      }
      cursor = page.next;
    } while (cursor !== undefined);
  }

  const lines = exportLines();
  return new ReadableStream<Uint8Array>({
    type: "bytes",
    async pull(controller) {
      const line = await lines.next();
      if (line.done) {
        controller.close();
        return;
      }
      controller.enqueue(line.value);
    },
    async cancel() {
      await lines.return(undefined);
    },
  });
}

/** Shared durable agent lifecycle; both runtimes persist an alarm before admitting work. */
export class InMemoryPiObject extends RpcTarget implements PiAgent {
  readonly #state: BackofficeObjectState;
  readonly #ready: Promise<void>;
  readonly #startup: Promise<void>;
  readonly #options: HarnessOptions;
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
    options,
    runtime,
    openStorage,
    idFromConfig,
    nowEpochMs,
  }: {
    state: BackofficeObjectState;
    options: HarnessOptions;
    runtime: BackofficeRuntimeServices;
    openStorage: () => Promise<Storage>;
    idFromConfig: (config: PiAgentConfig) => DurableObjectId;
    nowEpochMs: () => number;
  }) {
    super();
    this.#state = state;
    this.#options = options;
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
        const report = this.#options.onReport ?? console.error;
        report(error);
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
    const opening = this.#openHarness(config);
    this.#opening = opening;
    try {
      return await opening;
    } finally {
      this.#opening = null;
    }
  }

  async #openHarness(config: PiAgentConfig): Promise<OpenPiAgent> {
    const billingOrganizationId = config.billingOrganizationId;
    // Usage remains in pi.usage and is backfilled when an optional Billing binding is later configured.
    const billingTask =
      billingOrganizationId && this.#runtime.config.bindings.billing
        ? createPiDurableBillingTask({
            config,
            recordEvent: async (event) =>
              await this.#runtime.objects.billing
                .forOrg(billingOrganizationId)
                .commands.recordEvent(event),
            retryDelayMs: calculatePiDurableBillingRetryDelayMs,
          })
        : null;
    const options = await createBackofficePiDurableHarnessOptions({
      config,
      runtime: this.#runtime,
      options: this.#options,
      tasks: billingTask ? [billingTask] : [],
    });
    const storage = await this.#openStorage();
    const harness = await Harness.open(storage, options, BACKGROUND_CONTEXT);
    try {
      await harness.root(BACKGROUND_CONTEXT, {
        agent: {
          model: config.model,
          instructions: config.instructions,
          thinkingLevel: PI_THINKING_LEVEL,
        },
      });
    } catch (cause) {
      await harness.close(BACKGROUND_CONTEXT);
      throw cause;
    }
    this.#opened = { storage, harness, billingTask };
    return this.#opened;
  }

  async #ensureBillingDelivery(opened: OpenPiAgent) {
    if (!opened.billingTask) {
      return null;
    }
    return await ensurePiDurableBillingTask({
      harness: opened.harness,
      task: opened.billingTask,
      nowEpochMs: this.#nowEpochMs(),
      context: BACKGROUND_CONTEXT,
    });
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

  async submit(config: PiAgentConfig, rawPrompt: z.infer<typeof piAgentPromptSchema>) {
    const prompt = piAgentPromptSchema.parse(rawPrompt);
    const { harness } = await this.#requireAgent(config);
    const root = await harness.root(BACKGROUND_CONTEXT);
    this.#admitting += 1;
    try {
      // The wake must be durable before Pi admits work, not after the HTTP request returns.
      await this.#state.storage.setAlarm(this.#nowEpochMs());
      const submission = await root.submit({ type: "input", ...prompt }, BACKGROUND_CONTEXT);
      return { submissionId: submission.id, requestId: prompt.requestId };
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
      {},
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
    rawRequest: z.infer<typeof piAgentCompactionSchema>,
  ): Promise<{ taskId: number }> {
    const request = piAgentCompactionSchema.parse(rawRequest);
    const { harness } = await this.#requireAgent(config);
    this.#admitting += 1;
    try {
      await this.#state.storage.setAlarm(this.#nowEpochMs());
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
    const task = await harness.getTask(taskId as TaskId<CompactionResult>, BACKGROUND_CONTEXT);
    if (task?.kind !== "pi.compaction") {
      return null;
    }
    if (task.state.status !== "completing" && task.state.status !== "terminal") {
      return { taskId, status: "running", message: null };
    }
    const outcome = task.state.outcome;
    if (outcome.status === "completed") {
      return outcome.result.entryId !== undefined || outcome.result.submissionId !== undefined
        ? { taskId, status: "completed", message: null }
        : {
            taskId,
            status: "unchanged",
            message: "Pi context did not need compaction.",
          };
    }
    const message =
      outcome.status === "failed" || outcome.status === "faulted"
        ? outcome.error.message
        : (outcome.reason ?? `Pi compaction ${outcome.status}.`);
    return { taskId, status: "failed", message };
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
      throw new PiConversationViewDamagedError(config.sessionId, cause);
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
      throw new PiConversationViewDamagedError(config.sessionId, cause);
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
      if (opened.billingTask) {
        await flushPiDurableBilling({
          harness,
          task: opened.billingTask,
          nowEpochMs: this.#nowEpochMs,
          context: alarmContext,
        });
      }
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

/** One durable agent per object; scoped managers own session discovery. */
export class Pi extends DurableObject<CloudflareEnv> implements PiAgent {
  readonly #object: InMemoryPiObject;

  constructor(
    state: DurableObjectState,
    env: CloudflareEnv,
    options: HarnessOptions = createPiDurableHarnessOptions(env),
  ) {
    super(state, env);
    let harnessOptions = options;
    if (
      import.meta.env.BACKOFFICE_TARGET === "cloudflare" &&
      import.meta.env.PROD &&
      env.POSTHOG_PROJECT_TOKEN
    ) {
      const registry = createRegistry();
      for (const extension of options.registry.snapshot().installed()) {
        registry.install(extension);
      }
      let configPromise: Promise<PiAgentConfig> | null = null;
      registry.install(
        createPiPostHogExtension({
          getConfig: function loadPersistedPiConfig() {
            configPromise ??= state.storage.get<PiAgentConfig>(AGENT_CONFIG_KEY).then((config) => {
              if (!config) {
                throw new Error("Pi analytics requires a provisioned agent.");
              }
              return config;
            });
            return configPromise;
          },
          capture: async function queuePiGenerationEvent(event) {
            const client = await createCloudflarePostHog(env);
            if (!client) {
              return;
            }
            try {
              client.capture(event);
            } finally {
              state.waitUntil(shutdownCloudflarePostHog(client));
            }
          },
        }),
      );
      harnessOptions = { ...options, registry };
    }
    this.#object = new InMemoryPiObject({
      state,
      options: harnessOptions,
      runtime: createCloudflareDurableObjectRuntimeServices(env, state),
      openStorage: () => openPiSessionStore(state.storage),
      idFromConfig: (config) => env.PI.idFromName(piAgentObjectName(config)),
      nowEpochMs: Date.now,
    });
  }

  async initialize(config: PiAgentConfig): Promise<void> {
    await this.#object.initialize(config);
  }
  async submit(config: PiAgentConfig, prompt: z.infer<typeof piAgentPromptSchema>) {
    return await this.#object.submit(config, prompt);
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
    request: z.infer<typeof piAgentCompactionSchema>,
  ): Promise<{ taskId: number }> {
    return await this.#object.compact(config, request);
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
