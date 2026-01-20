import type { SimpleQueryInterface } from "@fragno-dev/db/query";
import type { AiFragmentConfig, AiRunnerTickOptions, AiRunnerTickResult } from "./index";
import { aiSchema } from "./schema";
import { createOpenAIClient, resolveMessageText, resolveOpenAIResponseText } from "./openai";
import { FragnoId } from "@fragno-dev/db/schema";

type Clock = {
  now: () => Date;
};

type AiRunRecord = {
  id: FragnoId;
  threadId: string;
  systemPrompt: string | null;
  modelId: string;
  executionMode: string;
  status: string;
  openaiResponseId: string | null;
  startedAt: Date | null;
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
): Promise<{ run: AiRunRecord; messages: AiMessageRecord[] }> => {
  const run = (await db.findFirst("ai_run", (b) =>
    b.whereIndex("primary", (eb) => eb("id", "=", runId)),
  )) as AiRunRecord | null;

  if (!run) {
    throw new Error("RUN_NOT_FOUND");
  }

  const thread = await db.findFirst("ai_thread", (b) =>
    b.whereIndex("primary", (eb) => eb("id", "=", run.threadId)),
  );

  if (!thread) {
    throw new Error("THREAD_NOT_FOUND");
  }

  const messages = (await db.find("ai_message", (b) =>
    b
      .whereIndex("idx_ai_message_thread_createdAt", (eb) => eb("threadId", "=", run.threadId))
      .orderByIndex("idx_ai_message_thread_createdAt", "asc"),
  )) as AiMessageRecord[];

  return { run, messages };
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
  status: "succeeded" | "failed";
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
  const { run, messages } = await fetchRunData(db, runId);

  if (TERMINAL_STATUSES.has(run.status)) {
    return {
      runId: run.id.toString(),
      status: run.status,
      openaiResponseId: run.openaiResponseId,
    };
  }

  let status: "succeeded" | "failed" = "succeeded";
  let error: string | null = null;
  let openaiResponseId: string | null = run.openaiResponseId;
  let assistantText: string | null = null;

  try {
    const client = await createOpenAIClient(config);
    const response = await client.responses.create({
      model: run.modelId,
      input: buildOpenAIInput(run, messages),
    });
    if (response && typeof response === "object" && "id" in response) {
      const responseId = (response as { id?: unknown }).id;
      if (typeof responseId === "string") {
        openaiResponseId = responseId;
      }
    }
    assistantText = resolveOpenAIResponseText(response);
  } catch (err) {
    status = "failed";
    error = err instanceof Error ? err.message : "OpenAI request failed";
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

  return { runId: run.id.toString(), status, openaiResponseId, error };
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
  for (const run of candidates) {
    if (!run || run.executionMode !== "background") {
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

export const createAiRunner = ({ db, config, clock }: AiRunnerOptions) => {
  const effectiveClock = clock ?? { now: () => new Date() };

  const tick = async (options: AiRunnerTickOptions = {}): Promise<AiRunnerTickResult> => {
    const maxRuns = options.maxRuns ?? config.runner?.maxWorkPerTick ?? 1;
    const runs = await claimNextRuns({ db, maxRuns, clock: effectiveClock });

    let processedRuns = 0;
    for (const run of runs) {
      await runExecutor({ db, config, runId: run.id.toString(), clock: effectiveClock });
      processedRuns += 1;
    }

    return { processedRuns, processedWebhookEvents: 0 };
  };

  return { tick };
};
