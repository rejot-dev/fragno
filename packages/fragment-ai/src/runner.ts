import type { SimpleQueryInterface } from "@fragno-dev/db/query";
import type { AiFragmentConfig, AiRunnerTickOptions, AiRunnerTickResult } from "./index";
import { aiSchema } from "./schema";
import {
  buildOpenAIIdempotencyKey,
  buildOpenAIResponseOptions,
  createOpenAIClient,
  resolveMessageText,
  resolveOpenAIResponseText,
} from "./openai";
import { FragnoId } from "@fragno-dev/db/schema";
import { registerRunAbortController } from "./run-abort";
import {
  estimateArtifactSizeBytes,
  estimateMessageSizeBytes,
  resolveMaxArtifactBytes,
  resolveMaxMessageBytes,
} from "./limits";

type Clock = {
  now: () => Date;
};

type AiRunRecord = {
  id: FragnoId;
  threadId: string;
  type: string;
  systemPrompt: string | null;
  modelId: string;
  thinkingLevel: string;
  executionMode: string;
  status: string;
  openaiResponseId: string | null;
  startedAt: Date | null;
  inputMessageId: string | null;
  openaiToolConfig: unknown | null;
  attempt: number;
  maxAttempts: number;
};

type AiThreadRecord = {
  id: FragnoId;
  openaiToolConfig: unknown | null;
};

type AiMessageRecord = {
  id: FragnoId;
  threadId: string;
  role: string;
  content: unknown;
  text: string | null;
  runId: string | null;
  createdAt: Date;
};

type AiRunEventRecord = {
  id: FragnoId;
  runId: string;
  seq: number;
  type: string;
  payload: unknown | null;
  createdAt: Date;
};

type AiRunnerOptions = {
  db: SimpleQueryInterface<typeof aiSchema>;
  config: AiFragmentConfig;
  clock?: Clock;
};

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const DEFAULT_RETRY_BASE_DELAY_MS = 2000;
const DEEP_RESEARCH_ARTIFACT_TYPE = "deep_research_report";

const resolveRetryDelayMs = (attempt: number, baseDelayMs: number) =>
  baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));

const buildOpenAIInput = (run: AiRunRecord, messages: AiMessageRecord[]) => {
  const input: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];

  if (run?.systemPrompt) {
    input.push({ role: "system", content: run.systemPrompt });
  }

  for (const message of messages) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) {
      continue;
    }

    const text = resolveMessageText(message);
    if (!text) {
      continue;
    }

    input.push({ role: message.role as "user" | "assistant", content: text });
  }

  return input;
};

const fetchRunData = async (
  db: SimpleQueryInterface<typeof aiSchema>,
  runId: string,
): Promise<{ run: AiRunRecord; messages: AiMessageRecord[]; thread: AiThreadRecord }> => {
  const run = (await db.findFirst("ai_run", (b) =>
    b.whereIndex("primary", (eb) => eb("id", "=", runId)),
  )) as AiRunRecord | null;

  if (!run) {
    throw new Error("RUN_NOT_FOUND");
  }

  const thread = (await db.findFirst("ai_thread", (b) =>
    b.whereIndex("primary", (eb) => eb("id", "=", run.threadId)),
  )) as AiThreadRecord | null;

  if (!thread) {
    throw new Error("THREAD_NOT_FOUND");
  }

  const messages = (await db.find("ai_message", (b) =>
    b
      .whereIndex("idx_ai_message_thread_createdAt", (eb) => eb("threadId", "=", run.threadId))
      .orderByIndex("idx_ai_message_thread_createdAt", "asc"),
  )) as AiMessageRecord[];

  if (run.inputMessageId) {
    const cutoffIndex = messages.findIndex(
      (message) => message.id.toString() === run.inputMessageId,
    );
    if (cutoffIndex >= 0) {
      return { run, messages: messages.slice(0, cutoffIndex + 1), thread };
    }
  }

  return { run, messages, thread };
};

const resolveNextRunEventSeq = async (db: SimpleQueryInterface<typeof aiSchema>, runId: string) => {
  const lastEvent = (await db.findFirst("ai_run_event", (b) =>
    b
      .whereIndex("idx_ai_run_event_run_seq", (eb) => eb("runId", "=", runId))
      .orderByIndex("idx_ai_run_event_run_seq", "desc"),
  )) as AiRunEventRecord | null;

  if (!lastEvent) {
    return 1;
  }

  return lastEvent.seq + 1;
};

const finalizeRun = async ({
  db,
  run,
  status,
  error,
  openaiResponseId,
  assistantText,
  clock,
}: {
  db: SimpleQueryInterface<typeof aiSchema>;
  run: AiRunRecord;
  status: "succeeded" | "failed" | "cancelled";
  error: string | null;
  openaiResponseId: string | null;
  assistantText: string | null;
  clock: Clock;
}) => {
  const completedAt = clock.now();
  const startedAt = run.startedAt ?? completedAt;
  const nextSeq = await resolveNextRunEventSeq(db, run.id.toString());
  const runEvents: Array<{ type: string; payload: unknown | null; createdAt: Date }> = [
    {
      type: "run.meta",
      payload: { runId: run.id.toString(), threadId: run.threadId },
      createdAt: completedAt,
    },
    { type: "run.status", payload: { status: "running" }, createdAt: completedAt },
  ];

  if (assistantText) {
    runEvents.push({
      type: "output.text.done",
      payload: { text: assistantText },
      createdAt: completedAt,
    });
  }

  runEvents.push({
    type: "run.final",
    payload: {
      status,
      error,
      completedAt: completedAt.toISOString(),
    },
    createdAt: completedAt,
  });

  const uow = db.createUnitOfWork("ai-run-finalize");
  const schema = uow.forSchema(aiSchema);
  schema.update("ai_run", run.id, (b) => {
    const builder = b.set({
      status,
      error,
      openaiResponseId: openaiResponseId ?? run.openaiResponseId,
      startedAt,
      completedAt,
      updatedAt: completedAt,
    });
    if (run.id instanceof FragnoId) {
      builder.check();
    }
    return builder;
  });

  if (assistantText) {
    schema.create("ai_message", {
      threadId: run.threadId,
      role: "assistant",
      content: { type: "text", text: assistantText },
      text: assistantText,
      runId: run.id.toString(),
      createdAt: completedAt,
    });
  }

  let seq = nextSeq;
  for (const event of runEvents) {
    schema.create("ai_run_event", {
      runId: run.id.toString(),
      seq,
      type: event.type,
      payload: event.payload,
      createdAt: event.createdAt,
    });
    seq += 1;
  }

  await uow.executeMutations();
};

const scheduleRetry = async ({
  db,
  run,
  error,
  clock,
  config,
}: {
  db: SimpleQueryInterface<typeof aiSchema>;
  run: AiRunRecord;
  error: string | null;
  clock: Clock;
  config: AiFragmentConfig;
}) => {
  if (run.attempt >= run.maxAttempts) {
    return null;
  }

  const storedRun = (await db.findFirst("ai_run", (b) =>
    b.whereIndex("primary", (eb) => eb("id", "=", run.id.toString())),
  )) as AiRunRecord | null;

  if (!storedRun || storedRun.status !== "failed") {
    return null;
  }

  if (storedRun.attempt >= storedRun.maxAttempts) {
    return null;
  }

  const now = clock.now();
  const baseDelayMs = config.retries?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const delayMs = resolveRetryDelayMs(storedRun.attempt, baseDelayMs);
  const nextAttemptAt = new Date(now.getTime() + delayMs);

  const uow = db.createUnitOfWork("ai-run-retry");
  const schema = uow.forSchema(aiSchema);
  schema.update("ai_run", storedRun.id, (b) => {
    const builder = b.set({
      status: "queued",
      error,
      nextAttemptAt,
      attempt: storedRun.attempt + 1,
      completedAt: null,
      updatedAt: now,
    });
    if (storedRun.id instanceof FragnoId) {
      builder.check();
    }
    return builder;
  });

  const { success } = await uow.executeMutations();
  if (!success) {
    return null;
  }

  return nextAttemptAt;
};

const scheduleWebhookRetry = async ({
  db,
  eventId,
  error,
  clock,
  config,
}: {
  db: SimpleQueryInterface<typeof aiSchema>;
  eventId: FragnoId;
  error: string;
  clock: Clock;
  config: AiFragmentConfig;
}) => {
  const now = clock.now();
  const baseDelayMs = config.retries?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const nextAttemptAt = new Date(now.getTime() + baseDelayMs);

  await db.update("ai_openai_webhook_event", eventId, (b) =>
    b.set({
      processingError: error,
      processingAt: null,
      nextAttemptAt,
    }),
  );

  return nextAttemptAt;
};

const submitDeepResearchRun = async ({
  db,
  config,
  runId,
  clock,
}: {
  db: SimpleQueryInterface<typeof aiSchema>;
  config: AiFragmentConfig;
  runId: string;
  clock: Clock;
}) => {
  const { run, messages, thread } = await fetchRunData(db, runId);
  const now = clock.now();

  if (TERMINAL_STATUSES.has(run.status)) {
    return {
      runId: run.id.toString(),
      status: run.status,
      openaiResponseId: run.openaiResponseId,
    };
  }

  let status: "waiting_webhook" | "failed" = "waiting_webhook";
  let error: string | null = null;
  let openaiResponseId: string | null = run.openaiResponseId;

  try {
    const client = await createOpenAIClient(config);
    const responseOptions = buildOpenAIResponseOptions({
      config,
      modelId: run.modelId,
      input: buildOpenAIInput(run, messages),
      thinkingLevel: run.thinkingLevel,
      openaiToolConfig: run.openaiToolConfig ?? thread.openaiToolConfig,
      background: true,
    });
    const response = await client.responses.create(responseOptions, {
      idempotencyKey: buildOpenAIIdempotencyKey(String(run.id), run.attempt),
    });
    if (response && typeof response === "object" && "id" in response) {
      const responseId = (response as { id?: unknown }).id;
      if (typeof responseId === "string") {
        openaiResponseId = responseId;
      }
    }

    if (!openaiResponseId) {
      throw new Error("OpenAI response id missing");
    }
  } catch (err) {
    status = "failed";
    error = err instanceof Error ? err.message : "OpenAI request failed";
  }

  const uow = db.createUnitOfWork("ai-run-deep-research-submit");
  const schema = uow.forSchema(aiSchema);
  schema.update("ai_run", run.id, (b) => {
    const builder = b.set({
      status,
      error,
      openaiResponseId,
      startedAt: run.startedAt ?? now,
      completedAt: status === "failed" ? now : null,
      updatedAt: now,
    });
    if (run.id instanceof FragnoId) {
      builder.check();
    }
    return builder;
  });

  await uow.executeMutations();

  let retryScheduledAt: Date | null = null;
  if (status === "failed") {
    retryScheduledAt = await scheduleRetry({ db, run, error, clock, config });
  }

  return {
    runId: run.id.toString(),
    status: retryScheduledAt ? "queued" : status,
    openaiResponseId,
    error,
    retryScheduledAt,
  };
};

const extractOpenAIUsage = (response: unknown) => {
  if (!response || typeof response !== "object") {
    return undefined;
  }
  const usage = (response as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  return usage;
};

const processWebhookEvent = async ({
  db,
  config,
  event,
  clock,
}: {
  db: SimpleQueryInterface<typeof aiSchema>;
  config: AiFragmentConfig;
  event: { id: FragnoId; responseId: string };
  clock: Clock;
}) => {
  const now = clock.now();
  let response: unknown;

  try {
    const client = await createOpenAIClient(config);
    response = await client.responses.retrieve(event.responseId);
  } catch (err) {
    const error = err instanceof Error ? err.message : "OpenAI retrieve failed";
    await scheduleWebhookRetry({
      db,
      eventId: event.id,
      error,
      clock,
      config,
    });
    return false;
  }

  const responseStatus =
    response && typeof response === "object"
      ? (response as { status?: unknown }).status
      : undefined;
  const normalizedStatus = typeof responseStatus === "string" ? responseStatus : null;
  if (
    normalizedStatus &&
    normalizedStatus !== "completed" &&
    normalizedStatus !== "failed" &&
    normalizedStatus !== "cancelled"
  ) {
    await scheduleWebhookRetry({
      db,
      eventId: event.id,
      error: "Response not completed",
      clock,
      config,
    });
    return false;
  }

  const run = (await db.findFirst("ai_run", (b) =>
    b.whereIndex("idx_ai_run_openaiResponseId", (eb) =>
      eb("openaiResponseId", "=", event.responseId),
    ),
  )) as AiRunRecord | null;

  if (!run) {
    await scheduleWebhookRetry({
      db,
      eventId: event.id,
      error: "RUN_NOT_FOUND",
      clock,
      config,
    });
    return false;
  }

  if (TERMINAL_STATUSES.has(run.status)) {
    await db.update("ai_openai_webhook_event", event.id, (b) =>
      b.set({
        processedAt: now,
        processingError: null,
        processingAt: null,
        nextAttemptAt: null,
      }),
    );
    return true;
  }

  if (run.type !== "deep_research") {
    await db.update("ai_openai_webhook_event", event.id, (b) =>
      b.set({
        processedAt: now,
        processingError: "UNSUPPORTED_RUN_TYPE",
        processingAt: null,
        nextAttemptAt: null,
      }),
    );
    return true;
  }

  const uow = db.createUnitOfWork("ai-webhook-process");
  const schema = uow.forSchema(aiSchema);
  const responseId = event.responseId;

  if (normalizedStatus === "failed" || normalizedStatus === "cancelled") {
    schema.update("ai_run", run.id, (b) => {
      const builder = b.set({
        status: normalizedStatus === "cancelled" ? "cancelled" : "failed",
        error: "OpenAI response failed",
        completedAt: now,
        updatedAt: now,
      });
      if (run.id instanceof FragnoId) {
        builder.check();
      }
      return builder;
    });

    schema.update("ai_openai_webhook_event", event.id, (b) =>
      b.set({
        processedAt: now,
        processingError: null,
        processingAt: null,
        nextAttemptAt: null,
      }),
    );

    const { success } = await uow.executeMutations();
    return success;
  }

  const reportMarkdown = resolveOpenAIResponseText(response) ?? "";
  const usage = extractOpenAIUsage(response);
  const artifactData = {
    type: DEEP_RESEARCH_ARTIFACT_TYPE,
    formatVersion: 1,
    modelId: run.modelId,
    openaiResponseId: responseId,
    reportMarkdown,
    ...(usage ? { usage } : {}),
    ...(config.storage?.persistOpenAIRawResponses ? { rawResponse: response } : {}),
  };
  const maxArtifactBytes = resolveMaxArtifactBytes(config);
  const artifactBytes = estimateArtifactSizeBytes(artifactData, reportMarkdown);
  if (artifactBytes > maxArtifactBytes) {
    schema.update("ai_run", run.id, (b) => {
      const builder = b.set({
        status: "failed",
        error: "ARTIFACT_TOO_LARGE",
        completedAt: now,
        updatedAt: now,
        openaiResponseId: responseId,
      });
      if (run.id instanceof FragnoId) {
        builder.check();
      }
      return builder;
    });

    schema.update("ai_openai_webhook_event", event.id, (b) =>
      b.set({ processedAt: now, processingError: null, processingAt: null, nextAttemptAt: null }),
    );

    const { success } = await uow.executeMutations();
    return success;
  }

  const artifactId = schema.create("ai_artifact", {
    runId: run.id.toString(),
    threadId: run.threadId,
    type: DEEP_RESEARCH_ARTIFACT_TYPE,
    title: "Deep research report",
    mimeType: "text/markdown",
    data: artifactData,
    text: reportMarkdown || null,
    createdAt: now,
    updatedAt: now,
  });

  schema.create("ai_message", {
    threadId: run.threadId,
    role: "assistant",
    content: { type: "artifactRef", artifactId: artifactId.toString() },
    text: null,
    runId: run.id.toString(),
    createdAt: now,
  });

  schema.update("ai_run", run.id, (b) => {
    const builder = b.set({
      status: "succeeded",
      error: null,
      completedAt: now,
      updatedAt: now,
      openaiResponseId: responseId,
    });
    if (run.id instanceof FragnoId) {
      builder.check();
    }
    return builder;
  });

  schema.update("ai_openai_webhook_event", event.id, (b) =>
    b.set({ processedAt: now, processingError: null, processingAt: null, nextAttemptAt: null }),
  );

  const { success } = await uow.executeMutations();
  return success;
};

export const runExecutor = async ({
  db,
  config,
  runId,
  clock,
}: {
  db: SimpleQueryInterface<typeof aiSchema>;
  config: AiFragmentConfig;
  runId: string;
  clock?: Clock;
}) => {
  const effectiveClock = clock ?? { now: () => new Date() };
  const { run, messages, thread } = await fetchRunData(db, runId);

  if (TERMINAL_STATUSES.has(run.status)) {
    return {
      runId: run.id.toString(),
      status: run.status,
      openaiResponseId: run.openaiResponseId,
    };
  }

  let status: "succeeded" | "failed" | "cancelled" = "succeeded";
  let error: string | null = null;
  let openaiResponseId: string | null = run.openaiResponseId;
  let assistantText: string | null = null;
  let retryable = true;
  const abortController = new AbortController();
  const unregisterAbort = registerRunAbortController(run.id.toString(), abortController);

  try {
    const client = await createOpenAIClient(config);
    const responseOptions = buildOpenAIResponseOptions({
      config,
      modelId: run.modelId,
      input: buildOpenAIInput(run, messages),
      thinkingLevel: run.thinkingLevel,
      openaiToolConfig: run.openaiToolConfig ?? thread.openaiToolConfig,
      stream: false,
    });
    const response = await client.responses.create(responseOptions, {
      idempotencyKey: buildOpenAIIdempotencyKey(String(run.id), run.attempt),
      signal: abortController.signal,
    });
    if (response && typeof response === "object" && "id" in response) {
      const responseId = (response as { id?: unknown }).id;
      if (typeof responseId === "string") {
        openaiResponseId = responseId;
      }
    }
    assistantText = resolveOpenAIResponseText(response);
  } catch (err) {
    if (abortController.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
      status = "cancelled";
      error = null;
      assistantText = null;
    } else {
      status = "failed";
      error = err instanceof Error ? err.message : "OpenAI request failed";
    }
  } finally {
    unregisterAbort();
  }

  if (assistantText) {
    const maxMessageBytes = resolveMaxMessageBytes(config);
    const messageBytes = estimateMessageSizeBytes(
      { type: "text", text: assistantText },
      assistantText,
    );
    if (messageBytes > maxMessageBytes) {
      status = "failed";
      error = "MESSAGE_TOO_LARGE";
      assistantText = null;
      retryable = false;
    }
  }

  await finalizeRun({
    db,
    run,
    status,
    error,
    openaiResponseId,
    assistantText,
    clock: effectiveClock,
  });

  let retryScheduledAt: Date | null = null;
  if (status === "failed" && retryable && run.executionMode === "background") {
    retryScheduledAt = await scheduleRetry({
      db,
      run,
      error,
      clock: effectiveClock,
      config,
    });
  }

  return {
    runId: run.id.toString(),
    status: retryScheduledAt ? "queued" : status,
    openaiResponseId,
    error,
    retryScheduledAt,
  };
};

const claimNextRuns = async ({
  db,
  maxRuns,
  clock,
}: {
  db: SimpleQueryInterface<typeof aiSchema>;
  maxRuns: number;
  clock: Clock;
}) => {
  const now = clock.now();
  const candidates = await db.find("ai_run", (b) =>
    b
      .whereIndex("idx_ai_run_status_nextAttemptAt_updatedAt", (eb) =>
        eb.and(
          eb("status", "=", "queued"),
          eb.or(eb.isNull("nextAttemptAt"), eb("nextAttemptAt", "<=", now)),
        ),
      )
      .orderByIndex("idx_ai_run_status_nextAttemptAt_updatedAt", "asc")
      .pageSize(maxRuns),
  );

  const claimed: AiRunRecord[] = [];
  const allowedExecutionModes = new Set(["background", "foreground_stream"]);
  for (const run of candidates) {
    if (!run || !allowedExecutionModes.has(run.executionMode)) {
      continue;
    }

    const uow = db.createUnitOfWork("ai-run-claim");
    const schema = uow.forSchema(aiSchema);
    const startedAt = run.startedAt ?? now;
    schema.update("ai_run", run.id, (b) => {
      const builder = b.set({
        status: "running",
        startedAt,
        updatedAt: now,
        nextAttemptAt: null,
      });
      if (run.id instanceof FragnoId) {
        builder.check();
      }
      return builder;
    });

    const { success } = await uow.executeMutations();
    if (success) {
      claimed.push(run);
    }
  }

  return claimed;
};

const claimNextWebhookEvents = async ({
  db,
  maxEvents,
  clock,
}: {
  db: SimpleQueryInterface<typeof aiSchema>;
  maxEvents: number;
  clock: Clock;
}) => {
  const events = (await db.find("ai_openai_webhook_event", (b) =>
    b
      .whereIndex("idx_ai_openai_webhook_event_processedAt", (eb) => eb.isNull("processedAt"))
      .orderByIndex("idx_ai_openai_webhook_event_processedAt", "asc")
      .pageSize(maxEvents),
  )) as Array<{
    id: FragnoId;
    responseId: string;
    processingAt: Date | null;
    nextAttemptAt: Date | null;
  }>;

  const claimed: Array<{ id: FragnoId; responseId: string }> = [];
  const now = clock.now();
  for (const event of events) {
    if (event.processingAt) {
      continue;
    }
    if (event.nextAttemptAt && event.nextAttemptAt > now) {
      continue;
    }

    const uow = db.createUnitOfWork("ai-webhook-claim");
    const schema = uow.forSchema(aiSchema);
    schema.update("ai_openai_webhook_event", event.id, (b) => {
      const builder = b.set({ processingAt: now, nextAttemptAt: null });
      if (event.id instanceof FragnoId) {
        builder.check();
      }
      return builder;
    });

    const { success } = await uow.executeMutations();
    if (success) {
      claimed.push({ id: event.id, responseId: event.responseId });
    }
  }

  return claimed;
};

export const createAiRunner = ({ db, config, clock }: AiRunnerOptions) => {
  const effectiveClock = clock ?? { now: () => new Date() };

  const tick = async (options: AiRunnerTickOptions = {}): Promise<AiRunnerTickResult> => {
    const maxRuns = options.maxRuns ?? config.runner?.maxWorkPerTick ?? 1;
    const runs = await claimNextRuns({ db, maxRuns, clock: effectiveClock });

    let processedRuns = 0;
    for (const run of runs) {
      if (run.type === "deep_research") {
        await submitDeepResearchRun({
          db,
          config,
          runId: run.id.toString(),
          clock: effectiveClock,
        });
      } else {
        await runExecutor({ db, config, runId: run.id.toString(), clock: effectiveClock });
      }
      processedRuns += 1;
    }

    const maxWebhookEvents = options.maxWebhookEvents ?? config.runner?.maxWorkPerTick ?? 1;
    const webhookEvents = await claimNextWebhookEvents({
      db,
      maxEvents: maxWebhookEvents,
      clock: effectiveClock,
    });

    let processedWebhookEvents = 0;
    for (const event of webhookEvents) {
      const processed = await processWebhookEvent({
        db,
        config,
        event: { id: event.id, responseId: event.responseId },
        clock: effectiveClock,
      });
      if (processed) {
        processedWebhookEvents += 1;
      }
    }

    return { processedRuns, processedWebhookEvents };
  };

  return { tick };
};
