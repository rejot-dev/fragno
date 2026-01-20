import type { SimpleQueryInterface } from "@fragno-dev/db/query";
import type { AiFragmentConfig, AiRunnerTickOptions, AiRunnerTickResult } from "./index";
import { aiSchema } from "./schema";
import {
  buildOpenAIIdempotencyKey,
  buildOpenAIResponseOptions,
  createOpenAIClient,
  resolveOpenAIModelRef,
  resolveOpenAIResponseText,
} from "./openai";
import { FragnoId } from "@fragno-dev/db/schema";
import { registerRunAbortController } from "./run-abort";
import { applyToolPolicy } from "./tool-policy";
import {
  estimateArtifactSizeBytes,
  estimateMessageSizeBytes,
  resolveMaxArtifactBytes,
  resolveMaxMessageBytes,
} from "./limits";
import { logWithLogger } from "./logging";
import { buildOpenAIInput } from "./history";
import {
  buildPiAiContext,
  buildPiAiStreamOptions,
  completeWithPiAi,
  resolvePiAiModel,
  resolvePiAiResponseText,
  resolvePiAiToolCalls,
} from "./pi-ai";

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
  threadId: string;
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

const resolveMaxHistoryMessages = (config: AiFragmentConfig) => {
  const maxMessages = config.history?.maxMessages;
  if (typeof maxMessages !== "number" || !Number.isFinite(maxMessages) || maxMessages <= 0) {
    return null;
  }
  return Math.floor(maxMessages);
};

const resolveRetentionCutoff = (config: AiFragmentConfig, clock: Clock) => {
  const retentionDays = config.storage?.retentionDays;
  if (retentionDays == null) {
    return null;
  }

  const normalized = Number(retentionDays);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return null;
  }

  return new Date(clock.now().getTime() - normalized * 24 * 60 * 60 * 1000);
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
  toolCalls,
  clock,
}: {
  db: SimpleQueryInterface<typeof aiSchema>;
  run: AiRunRecord;
  status: "succeeded" | "failed" | "cancelled";
  error: string | null;
  openaiResponseId: string | null;
  assistantText: string | null;
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
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

  if (toolCalls && toolCalls.length > 0) {
    const toolError = error ?? "TOOL_CALL_UNSUPPORTED";
    for (const toolCall of toolCalls) {
      schema.create("ai_tool_call", {
        runId: run.id.toString(),
        threadId: run.threadId,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        args: toolCall.args,
        status: "failed",
        result: { error: toolError },
        isError: 1,
        createdAt: completedAt,
        updatedAt: completedAt,
      });
    }
  }

  let seq = nextSeq;
  for (const event of runEvents) {
    schema.create("ai_run_event", {
      runId: run.id.toString(),
      threadId: run.threadId,
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

  logWithLogger(config.logger, "info", {
    event: "ai.run.deep_research.submission.started",
    runId: run.id.toString(),
    threadId: run.threadId,
    attempt: run.attempt,
  });

  let status: "waiting_webhook" | "failed" = "waiting_webhook";
  let error: string | null = null;
  let openaiResponseId: string | null = run.openaiResponseId;
  let retryable = true;

  const baseToolConfig = run.openaiToolConfig ?? thread.openaiToolConfig;
  const toolPolicyResult = await applyToolPolicy({
    policy: config.toolPolicy,
    context: {
      threadId: run.threadId,
      runId: run.id.toString(),
      runType: run.type as "agent" | "deep_research",
      executionMode: run.executionMode as "foreground_stream" | "background",
      modelId: run.modelId,
      openaiToolConfig: baseToolConfig ?? null,
    },
  });

  if (toolPolicyResult.deniedReason) {
    status = "failed";
    error = toolPolicyResult.deniedReason;
    retryable = false;
    logWithLogger(config.logger, "warn", {
      event: "ai.run.tool_policy.denied",
      runId: run.id.toString(),
      threadId: run.threadId,
      type: run.type,
      executionMode: run.executionMode,
      reason: toolPolicyResult.deniedReason,
    });
  }

  if (!toolPolicyResult.deniedReason) {
    try {
      const modelRef = resolveOpenAIModelRef({
        config,
        modelId: run.modelId,
        runType: run.type,
      });
      const client = await createOpenAIClient({ ...config, modelRef });
      const openaiInput = await buildOpenAIInput({
        run,
        messages,
        maxMessages: resolveMaxHistoryMessages(config),
        compactor: config.history?.compactor,
        logger: config.logger,
      });
      const responseOptions = buildOpenAIResponseOptions({
        config,
        modelId: run.modelId,
        input: openaiInput,
        thinkingLevel: run.thinkingLevel,
        openaiToolConfig: toolPolicyResult.openaiToolConfig,
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
  if (status === "failed" && retryable) {
    retryScheduledAt = await scheduleRetry({ db, run, error, clock, config });
  }

  const finalStatus = retryScheduledAt ? "queued" : status;
  logWithLogger(config.logger, status === "failed" ? "error" : "info", {
    event: "ai.run.deep_research.submission.completed",
    runId: run.id.toString(),
    threadId: run.threadId,
    status: finalStatus,
    error,
    openaiResponseId,
    ...(retryScheduledAt ? { retryScheduledAt: retryScheduledAt.toISOString() } : {}),
  });

  return {
    runId: run.id.toString(),
    status: finalStatus,
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

  const scheduleAndLogRetry = async (error: string) => {
    const nextAttemptAt = await scheduleWebhookRetry({
      db,
      eventId: event.id,
      error,
      clock,
      config,
    });
    logWithLogger(config.logger, "warn", {
      event: "ai.webhook.retry_scheduled",
      responseId: event.responseId,
      error,
      nextAttemptAt: nextAttemptAt.toISOString(),
    });
    return false;
  };

  const run = (await db.findFirst("ai_run", (b) =>
    b.whereIndex("idx_ai_run_openaiResponseId", (eb) =>
      eb("openaiResponseId", "=", event.responseId),
    ),
  )) as AiRunRecord | null;

  if (!run) {
    return scheduleAndLogRetry("RUN_NOT_FOUND");
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
    logWithLogger(config.logger, "info", {
      event: "ai.webhook.processed",
      responseId: event.responseId,
      runId: run.id.toString(),
      status: run.status,
      note: "run already terminal",
    });
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
    logWithLogger(config.logger, "warn", {
      event: "ai.webhook.processed",
      responseId: event.responseId,
      runId: run.id.toString(),
      status: "skipped",
      error: "UNSUPPORTED_RUN_TYPE",
    });
    return true;
  }

  try {
    const modelRef = resolveOpenAIModelRef({
      config,
      modelId: run.modelId,
      runType: run.type,
    });
    const client = await createOpenAIClient({ ...config, modelRef });
    response = await client.responses.retrieve(event.responseId);
  } catch (err) {
    const error = err instanceof Error ? err.message : "OpenAI retrieve failed";
    return scheduleAndLogRetry(error);
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
    return scheduleAndLogRetry("Response not completed");
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
    if (success) {
      logWithLogger(config.logger, "info", {
        event: "ai.webhook.processed",
        responseId: responseId,
        runId: run.id.toString(),
        status: normalizedStatus === "cancelled" ? "cancelled" : "failed",
      });
    }
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
    if (success) {
      logWithLogger(config.logger, "warn", {
        event: "ai.webhook.processed",
        responseId,
        runId: run.id.toString(),
        status: "failed",
        error: "ARTIFACT_TOO_LARGE",
      });
    }
    return success;
  }

  let storageKey: string | null = null;
  let storageMeta: unknown | null = null;
  const artifactStore = config.storage?.artifactStore;
  if (artifactStore) {
    try {
      const stored = await artifactStore.put({
        runId: run.id.toString(),
        threadId: run.threadId,
        type: DEEP_RESEARCH_ARTIFACT_TYPE,
        title: "Deep research report",
        mimeType: "text/markdown",
        data: artifactData,
        text: reportMarkdown || null,
      });

      if (!stored || typeof stored.key !== "string" || !stored.key) {
        return scheduleAndLogRetry("ARTIFACT_STORE_FAILED");
      }

      storageKey = stored.key;
      storageMeta = stored.metadata ?? null;
    } catch (err) {
      const error = err instanceof Error ? err.message : "ARTIFACT_STORE_FAILED";
      return scheduleAndLogRetry(error);
    }
  }

  const artifactId = schema.create("ai_artifact", {
    runId: run.id.toString(),
    threadId: run.threadId,
    type: DEEP_RESEARCH_ARTIFACT_TYPE,
    title: "Deep research report",
    mimeType: "text/markdown",
    storageKey,
    storageMeta,
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
  if (success) {
    logWithLogger(config.logger, "info", {
      event: "ai.webhook.processed",
      responseId,
      runId: run.id.toString(),
      status: "succeeded",
      artifactId: artifactId.toString(),
    });
  }
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

  logWithLogger(config.logger, "info", {
    event: "ai.run.started",
    runId: run.id.toString(),
    threadId: run.threadId,
    type: run.type,
    executionMode: run.executionMode,
    attempt: run.attempt,
  });

  let status: "succeeded" | "failed" | "cancelled" = "succeeded";
  let error: string | null = null;
  let openaiResponseId: string | null = run.openaiResponseId;
  let assistantText: string | null = null;
  let toolCalls: ReturnType<typeof resolvePiAiToolCalls> | null = null;
  let retryable = true;
  const abortController = new AbortController();
  const unregisterAbort = registerRunAbortController(run.id.toString(), abortController);

  const baseToolConfig = run.openaiToolConfig ?? thread.openaiToolConfig;
  const toolPolicyResult = await applyToolPolicy({
    policy: config.toolPolicy,
    context: {
      threadId: run.threadId,
      runId: run.id.toString(),
      runType: run.type as "agent" | "deep_research",
      executionMode: run.executionMode as "foreground_stream" | "background",
      modelId: run.modelId,
      openaiToolConfig: baseToolConfig ?? null,
    },
  });

  if (toolPolicyResult.deniedReason) {
    status = "failed";
    error = toolPolicyResult.deniedReason;
    retryable = false;
    logWithLogger(config.logger, "warn", {
      event: "ai.run.tool_policy.denied",
      runId: run.id.toString(),
      threadId: run.threadId,
      type: run.type,
      executionMode: run.executionMode,
      reason: toolPolicyResult.deniedReason,
    });
  } else {
    const modelRef = resolveOpenAIModelRef({
      config,
      modelId: run.modelId,
      runType: run.type,
    });
    const modelProvider = modelRef?.provider ?? "openai";

    if (modelProvider !== "openai" && run.type === "deep_research") {
      status = "failed";
      error = "PROVIDER_UNSUPPORTED_FOR_DEEP_RESEARCH";
      retryable = false;
    } else {
      try {
        if (modelProvider === "openai") {
          const client = await createOpenAIClient({ ...config, modelRef });
          const openaiInput = await buildOpenAIInput({
            run,
            messages,
            maxMessages: resolveMaxHistoryMessages(config),
            compactor: config.history?.compactor,
            logger: config.logger,
          });
          const responseOptions = buildOpenAIResponseOptions({
            config,
            modelId: run.modelId,
            input: openaiInput,
            thinkingLevel: run.thinkingLevel,
            openaiToolConfig: toolPolicyResult.openaiToolConfig,
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
        } else {
          if (!modelRef) {
            throw new Error("MODEL_PROVIDER_MISSING");
          }

          const model = await resolvePiAiModel({ modelId: run.modelId, modelRef });
          const openaiInput = await buildOpenAIInput({
            run,
            messages,
            maxMessages: resolveMaxHistoryMessages(config),
            compactor: config.history?.compactor,
            logger: config.logger,
          });
          const context = buildPiAiContext({ input: openaiInput, model });
          const { apiKey, options } = await buildPiAiStreamOptions({
            config,
            provider: model.provider,
            thinkingLevel: run.thinkingLevel,
            signal: abortController.signal,
          });

          if (!apiKey) {
            throw new Error("AI_API_KEY_MISSING");
          }

          const response = await completeWithPiAi(model, context, options);
          if (response.stopReason === "aborted") {
            status = "cancelled";
            error = null;
            assistantText = null;
          } else if (response.stopReason === "error") {
            status = "failed";
            error = response.errorMessage ?? "AI request failed";
          } else if (response.stopReason === "toolUse") {
            status = "failed";
            error = "TOOL_CALL_UNSUPPORTED";
            retryable = false;
            toolCalls = resolvePiAiToolCalls(response);
          } else {
            assistantText = resolvePiAiResponseText(response);
          }
        }
      } catch (err) {
        if (abortController.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          status = "cancelled";
          error = null;
          assistantText = null;
        } else {
          status = "failed";
          error = err instanceof Error ? err.message : "AI request failed";
        }
      }
    }
  }

  unregisterAbort();

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
    toolCalls: toolCalls
      ? toolCalls.map((toolCall) => ({
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args: toolCall.arguments,
        }))
      : undefined,
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

  const finalStatus = retryScheduledAt ? "queued" : status;
  if (retryScheduledAt) {
    logWithLogger(config.logger, "warn", {
      event: "ai.run.retry_scheduled",
      runId: run.id.toString(),
      threadId: run.threadId,
      attempt: run.attempt + 1,
      error,
      retryScheduledAt: retryScheduledAt.toISOString(),
    });
  }

  logWithLogger(config.logger, status === "failed" && !retryScheduledAt ? "error" : "info", {
    event: "ai.run.completed",
    runId: run.id.toString(),
    threadId: run.threadId,
    status: finalStatus,
    error,
    openaiResponseId,
    ...(retryScheduledAt ? { retryScheduledAt: retryScheduledAt.toISOString() } : {}),
  });

  return {
    runId: run.id.toString(),
    status: finalStatus,
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

const cleanupRetentionData = async ({
  db,
  config,
  clock,
}: {
  db: SimpleQueryInterface<typeof aiSchema>;
  config: AiFragmentConfig;
  clock: Clock;
}) => {
  const cutoff = resolveRetentionCutoff(config, clock);
  if (!cutoff) {
    return;
  }

  const batchSize = 200;

  while (true) {
    const events = (await db.find("ai_run_event", (b) =>
      b
        .whereIndex("idx_ai_run_event_createdAt", (eb) => eb("createdAt", "<", cutoff))
        .orderByIndex("idx_ai_run_event_createdAt", "asc")
        .pageSize(batchSize),
    )) as Array<{ id: FragnoId }>;

    if (events.length === 0) {
      break;
    }

    const uow = db.createUnitOfWork("ai-retention-run-events");
    const schema = uow.forSchema(aiSchema);
    for (const event of events) {
      schema.delete("ai_run_event", event.id);
    }
    await uow.executeMutations();
  }

  while (true) {
    const events = (await db.find("ai_openai_webhook_event", (b) =>
      b
        .whereIndex("idx_ai_openai_webhook_event_receivedAt", (eb) => eb("receivedAt", "<", cutoff))
        .orderByIndex("idx_ai_openai_webhook_event_receivedAt", "asc")
        .pageSize(batchSize),
    )) as Array<{ id: FragnoId; processedAt: Date | null; processingAt: Date | null }>;

    if (events.length === 0) {
      break;
    }

    const deletable = events.filter((event) => !event.processingAt && event.processedAt);
    if (deletable.length === 0) {
      break;
    }

    const uow = db.createUnitOfWork("ai-retention-webhook-events");
    const schema = uow.forSchema(aiSchema);
    for (const event of deletable) {
      schema.delete("ai_openai_webhook_event", event.id);
    }
    await uow.executeMutations();
  }
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

    await cleanupRetentionData({ db, config, clock: effectiveClock });

    return { processedRuns, processedWebhookEvents };
  };

  return { tick };
};
