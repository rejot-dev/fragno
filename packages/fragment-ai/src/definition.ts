import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import type { Cursor } from "@fragno-dev/db/cursor";
import type { FragnoId } from "@fragno-dev/db/schema";
import { aiSchema } from "./schema";
import type { AiFragmentConfig } from "./index";
import { abortRunInProcess } from "./run-abort";
import { estimateMessageSizeBytes, resolveMaxMessageBytes } from "./limits";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const DEFAULT_MODEL_ID = "gpt-4o-mini";
const DEFAULT_THINKING_LEVEL = "off";
const DEFAULT_MAX_ATTEMPTS = 4;

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

const resolvePageSize = (pageSize: number | undefined, cursor?: Cursor) => {
  const raw = cursor?.pageSize ?? pageSize ?? DEFAULT_PAGE_SIZE;
  const normalized = Number.isFinite(raw) ? raw : DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, normalized));
};

export type AiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type AiRunStatus =
  | "queued"
  | "running"
  | "waiting_webhook"
  | "processing_webhook"
  | "succeeded"
  | "failed"
  | "cancelled";

export type AiRunType = "agent" | "deep_research";

export type AiRunExecutionMode = "foreground_stream" | "background";

export type AiToolCallStatus =
  | "in_progress"
  | "searching"
  | "interpreting"
  | "generating"
  | "completed"
  | "failed";

export type AiRunLiveEvent =
  | { type: "run.meta"; runId: string; threadId: string }
  | { type: "run.status"; runId: string; status: "running" | "cancelled" | "failed" | "succeeded" }
  | { type: "output.text.delta"; runId: string; delta: string }
  | { type: "output.text.done"; runId: string; text: string }
  | {
      type: "tool.call.started";
      runId: string;
      toolCallId: string;
      toolType: string;
      toolName?: string;
    }
  | {
      type: "tool.call.status";
      runId: string;
      toolCallId: string;
      toolType: string;
      status: AiToolCallStatus;
    }
  | { type: "tool.call.arguments.delta"; runId: string; toolCallId: string; delta: string }
  | { type: "tool.call.arguments.done"; runId: string; toolCallId: string; arguments: string }
  | {
      type: "tool.call.output";
      runId: string;
      toolCallId: string;
      toolType: string;
      output: unknown;
      isError?: boolean;
    }
  | { type: "run.final"; runId: string; status: AiRunStatus; run: AiRun };

export interface AiThread {
  id: string;
  title: string | null;
  defaultModelId: string;
  defaultThinkingLevel: AiThinkingLevel | string;
  systemPrompt: string | null;
  openaiToolConfig: unknown | null;
  metadata: unknown | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AiMessage {
  id: string;
  threadId: string;
  role: string;
  content: unknown;
  text: string | null;
  runId: string | null;
  createdAt: Date;
}

export interface AiRun {
  id: string;
  threadId: string;
  type: AiRunType | string;
  executionMode: AiRunExecutionMode | string;
  status: AiRunStatus | string;
  modelId: string;
  thinkingLevel: AiThinkingLevel | string;
  systemPrompt: string | null;
  inputMessageId: string | null;
  openaiToolConfig: unknown | null;
  openaiResponseId: string | null;
  error: string | null;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface AiRunEvent {
  id: string;
  runId: string;
  seq: number;
  type: string;
  payload: unknown | null;
  createdAt: Date;
}

export interface AiArtifact {
  id: string;
  runId: string;
  threadId: string;
  type: string;
  title: string | null;
  mimeType: string;
  storageKey: string | null;
  storageMeta: unknown | null;
  data: unknown;
  text: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AiWebhookEvent {
  id: string;
  openaiEventId: string;
  type: string;
  responseId: string;
  payload: unknown;
  receivedAt: Date;
  nextAttemptAt: Date | null;
  processedAt: Date | null;
  processingError: string | null;
}

type AiThreadRecord = {
  id: FragnoId;
  title: string | null;
  defaultModelId: string;
  defaultThinkingLevel: string;
  systemPrompt: string | null;
  openaiToolConfig: unknown | null;
  metadata: unknown | null;
  createdAt: Date;
  updatedAt: Date;
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

type AiRunRecord = {
  id: FragnoId;
  threadId: string;
  type: string;
  executionMode: string;
  status: string;
  modelId: string;
  thinkingLevel: string;
  systemPrompt: string | null;
  inputMessageId: string | null;
  openaiToolConfig: unknown | null;
  openaiResponseId: string | null;
  error: string | null;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
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

type AiToolCallRecord = {
  id: FragnoId;
  runId: string;
  threadId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  status: string;
  result: unknown | null;
  isError: number;
  createdAt: Date;
  updatedAt: Date;
};

type AiArtifactRecord = {
  id: FragnoId;
  runId: string;
  threadId: string;
  type: string;
  title: string | null;
  mimeType: string;
  storageKey: string | null;
  storageMeta: unknown | null;
  data: unknown;
  text: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type AiWebhookEventRecord = {
  id: FragnoId;
  openaiEventId: string;
  type: string;
  responseId: string;
  payload: unknown;
  receivedAt: Date;
  processingAt: Date | null;
  nextAttemptAt: Date | null;
  processedAt: Date | null;
  processingError: string | null;
};

type ListThreadsParams = {
  pageSize?: number;
  cursor?: Cursor;
  order?: "asc" | "desc";
};

type UpdateThreadParams = {
  title?: string | null;
  systemPrompt?: string | null;
  defaultModelId?: string;
  defaultThinkingLevel?: string;
  openaiToolConfig?: unknown | null;
  metadata?: unknown | null;
};

type ListMessagesParams = {
  threadId: string;
  pageSize?: number;
  cursor?: Cursor;
  order?: "asc" | "desc";
};

type AppendMessageParams = {
  threadId: string;
  role: string;
  content: unknown;
  text?: string | null;
  runId?: string | null;
};

type CreateRunParams = {
  threadId: string;
  type?: AiRunType | string;
  executionMode?: AiRunExecutionMode | string;
  inputMessageId?: string;
  modelId?: string;
  thinkingLevel?: string;
  systemPrompt?: string | null;
};

type ListRunsParams = {
  threadId: string;
  pageSize?: number;
  cursor?: Cursor;
  order?: "asc" | "desc";
};

type ListRunEventsParams = {
  runId: string;
  pageSize?: number;
  cursor?: Cursor;
  order?: "asc" | "desc";
};

type ClaimRunsParams = {
  maxRuns?: number;
  now?: Date;
};

type RecordWebhookEventParams = {
  openaiEventId: string;
  type: string;
  responseId: string;
  payload: unknown;
};

type ClaimWebhookEventsParams = {
  maxEvents?: number;
};

function buildThread(thread: AiThreadRecord): AiThread {
  return {
    id: thread.id.toString(),
    title: thread.title,
    defaultModelId: thread.defaultModelId,
    defaultThinkingLevel: thread.defaultThinkingLevel,
    systemPrompt: thread.systemPrompt,
    openaiToolConfig: thread.openaiToolConfig,
    metadata: thread.metadata,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

function buildMessage(message: AiMessageRecord): AiMessage {
  return {
    id: message.id.toString(),
    threadId: message.threadId,
    role: message.role,
    content: message.content,
    text: message.text,
    runId: message.runId,
    createdAt: message.createdAt,
  };
}

function buildRun(run: AiRunRecord): AiRun {
  return {
    id: run.id.toString(),
    threadId: run.threadId,
    type: run.type,
    executionMode: run.executionMode,
    status: run.status,
    modelId: run.modelId,
    thinkingLevel: run.thinkingLevel,
    systemPrompt: run.systemPrompt,
    inputMessageId: run.inputMessageId,
    openaiToolConfig: run.openaiToolConfig ?? null,
    openaiResponseId: run.openaiResponseId,
    error: run.error,
    attempt: run.attempt,
    maxAttempts: run.maxAttempts,
    nextAttemptAt: run.nextAttemptAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

function buildRunEvent(event: AiRunEventRecord): AiRunEvent {
  return {
    id: event.id.toString(),
    runId: event.runId,
    seq: event.seq,
    type: event.type,
    payload: event.payload,
    createdAt: event.createdAt,
  };
}

function buildArtifact(artifact: AiArtifactRecord): AiArtifact {
  return {
    id: artifact.id.toString(),
    runId: artifact.runId,
    threadId: artifact.threadId,
    type: artifact.type,
    title: artifact.title,
    mimeType: artifact.mimeType,
    storageKey: artifact.storageKey ?? null,
    storageMeta: artifact.storageMeta ?? null,
    data: artifact.data,
    text: artifact.text,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

function buildWebhookEvent(event: AiWebhookEventRecord): AiWebhookEvent {
  return {
    id: event.id.toString(),
    openaiEventId: event.openaiEventId,
    type: event.type,
    responseId: event.responseId,
    payload: event.payload,
    receivedAt: event.receivedAt,
    nextAttemptAt: event.nextAttemptAt,
    processedAt: event.processedAt,
    processingError: event.processingError,
  };
}

function resolveDefaultModelId(config: AiFragmentConfig) {
  return config.defaultModel?.id ?? DEFAULT_MODEL_ID;
}

function resolveDefaultThinkingLevel(config: AiFragmentConfig) {
  return config.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
}

export const aiFragmentDefinition = defineFragment<AiFragmentConfig>("ai")
  .extend(withDatabase(aiSchema))
  .provideHooks(({ defineHook, config }) => ({
    onRunQueued: defineHook(async function (payload: { runId: string }) {
      await config.dispatcher?.wake?.({ type: "run.queued", runId: payload.runId });
    }),
    onOpenAIWebhookReceived: defineHook(async function (payload: {
      openaiEventId: string;
      responseId: string;
    }) {
      await config.dispatcher?.wake?.({
        type: "openai.webhook.received",
        openaiEventId: payload.openaiEventId,
        responseId: payload.responseId,
      });
    }),
  }))
  .providesBaseService(({ defineService, config }) => {
    const getNow = () => new Date();

    return defineService({
      createThread: function (params?: {
        title?: string | null;
        systemPrompt?: string | null;
        defaultModelId?: string;
        defaultThinkingLevel?: string;
        openaiToolConfig?: unknown | null;
        metadata?: unknown | null;
      }) {
        const now = getNow();
        const defaultModelId = params?.defaultModelId ?? resolveDefaultModelId(config);
        const defaultThinkingLevel =
          params?.defaultThinkingLevel ?? resolveDefaultThinkingLevel(config);

        return this.serviceTx(aiSchema)
          .mutate(({ uow }) => {
            const id = uow.create("ai_thread", {
              title: params?.title ?? null,
              defaultModelId,
              defaultThinkingLevel,
              systemPrompt: params?.systemPrompt ?? null,
              openaiToolConfig: params?.openaiToolConfig ?? null,
              metadata: params?.metadata ?? null,
              createdAt: now,
              updatedAt: now,
            });

            return buildThread({
              id,
              title: params?.title ?? null,
              defaultModelId,
              defaultThinkingLevel,
              systemPrompt: params?.systemPrompt ?? null,
              openaiToolConfig: params?.openaiToolConfig ?? null,
              metadata: params?.metadata ?? null,
              createdAt: now,
              updatedAt: now,
            });
          })
          .build();
      },
      listThreads: function ({
        pageSize = DEFAULT_PAGE_SIZE,
        cursor,
        order = "desc",
      }: ListThreadsParams = {}) {
        const effectiveOrder = cursor?.orderDirection ?? order;
        const effectivePageSize = resolvePageSize(pageSize, cursor);

        return this.serviceTx(aiSchema)
          .retrieve((uow) =>
            uow.findWithCursor("ai_thread", (b) => {
              const query = b
                .whereIndex("idx_ai_thread_updatedAt")
                .orderByIndex("idx_ai_thread_updatedAt", effectiveOrder)
                .pageSize(effectivePageSize);
              return cursor ? query.after(cursor) : query;
            }),
          )
          .transformRetrieve(([threads]) => {
            return {
              threads: threads.items.map(buildThread),
              cursor: threads.cursor,
              hasNextPage: threads.hasNextPage,
            };
          })
          .build();
      },
      getThread: function (threadId: string) {
        return this.serviceTx(aiSchema)
          .retrieve((uow) =>
            uow.findFirst("ai_thread", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", threadId)),
            ),
          )
          .transformRetrieve(([thread]) => {
            if (!thread) {
              throw new Error("THREAD_NOT_FOUND");
            }
            return buildThread(thread);
          })
          .build();
      },
      updateThread: function (threadId: string, params: UpdateThreadParams) {
        const now = getNow();

        return this.serviceTx(aiSchema)
          .retrieve((uow) =>
            uow.findFirst("ai_thread", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", threadId)),
            ),
          )
          .mutate(({ uow, retrieveResult: [thread] }) => {
            if (!thread) {
              throw new Error("THREAD_NOT_FOUND");
            }

            const updates: Partial<
              Pick<
                AiThreadRecord,
                | "title"
                | "systemPrompt"
                | "defaultModelId"
                | "defaultThinkingLevel"
                | "openaiToolConfig"
                | "metadata"
              >
            > & { updatedAt: Date } = {
              updatedAt: now,
            };

            if (params.title !== undefined) {
              updates.title = params.title;
            }
            if (params.systemPrompt !== undefined) {
              updates.systemPrompt = params.systemPrompt;
            }
            if (params.defaultModelId !== undefined) {
              updates.defaultModelId = params.defaultModelId;
            }
            if (params.defaultThinkingLevel !== undefined) {
              updates.defaultThinkingLevel = params.defaultThinkingLevel;
            }
            if (params.openaiToolConfig !== undefined) {
              updates.openaiToolConfig = params.openaiToolConfig;
            }
            if (params.metadata !== undefined) {
              updates.metadata = params.metadata;
            }

            uow.update("ai_thread", thread.id, (b) => b.set(updates).check());

            return buildThread({
              id: thread.id,
              title: params.title !== undefined ? params.title : thread.title,
              defaultModelId:
                params.defaultModelId !== undefined ? params.defaultModelId : thread.defaultModelId,
              defaultThinkingLevel:
                params.defaultThinkingLevel !== undefined
                  ? params.defaultThinkingLevel
                  : thread.defaultThinkingLevel,
              systemPrompt:
                params.systemPrompt !== undefined ? params.systemPrompt : thread.systemPrompt,
              openaiToolConfig:
                params.openaiToolConfig !== undefined
                  ? params.openaiToolConfig
                  : thread.openaiToolConfig,
              metadata: params.metadata !== undefined ? params.metadata : thread.metadata,
              createdAt: thread.createdAt,
              updatedAt: now,
            });
          })
          .build();
      },
      deleteThread: function (threadId: string) {
        return this.serviceTx(aiSchema)
          .retrieve((uow) =>
            uow
              .findFirst("ai_thread", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", threadId)),
              )
              .find("ai_message", (b) =>
                b.whereIndex("idx_ai_message_thread_createdAt", (eb) =>
                  eb("threadId", "=", threadId),
                ),
              )
              .find("ai_run", (b) =>
                b.whereIndex("idx_ai_run_thread_createdAt", (eb) => eb("threadId", "=", threadId)),
              )
              .find("ai_run_event", (b) =>
                b.whereIndex("idx_ai_run_event_thread_createdAt", (eb) =>
                  eb("threadId", "=", threadId),
                ),
              )
              .find("ai_tool_call", (b) =>
                b.whereIndex("idx_ai_tool_call_thread_createdAt", (eb) =>
                  eb("threadId", "=", threadId),
                ),
              )
              .find("ai_artifact", (b) =>
                b.whereIndex("idx_ai_artifact_thread_createdAt", (eb) =>
                  eb("threadId", "=", threadId),
                ),
              ),
          )
          .mutate(({ uow, retrieveResult }) => {
            const [thread, messages, runs, runEvents, toolCalls, artifacts] = retrieveResult as [
              AiThreadRecord | null,
              AiMessageRecord[],
              AiRunRecord[],
              AiRunEventRecord[],
              AiToolCallRecord[],
              AiArtifactRecord[],
            ];

            if (!thread) {
              throw new Error("THREAD_NOT_FOUND");
            }

            for (const message of messages) {
              uow.delete("ai_message", message.id);
            }

            for (const runEvent of runEvents) {
              uow.delete("ai_run_event", runEvent.id);
            }

            for (const toolCall of toolCalls) {
              uow.delete("ai_tool_call", toolCall.id);
            }

            for (const run of runs) {
              uow.delete("ai_run", run.id);
            }

            for (const artifact of artifacts) {
              uow.delete("ai_artifact", artifact.id);
            }

            uow.delete("ai_thread", thread.id);
            return { ok: true };
          })
          .build();
      },
      deleteRun: function (runId: string) {
        return this.serviceTx(aiSchema)
          .retrieve((uow) =>
            uow
              .findFirst("ai_run", (b) => b.whereIndex("primary", (eb) => eb("id", "=", runId)))
              .find("ai_message", (b) =>
                b.whereIndex("idx_ai_message_run_createdAt", (eb) => eb("runId", "=", runId)),
              )
              .find("ai_run_event", (b) =>
                b.whereIndex("idx_ai_run_event_run_seq", (eb) => eb("runId", "=", runId)),
              )
              .find("ai_tool_call", (b) =>
                b.whereIndex("idx_ai_tool_call_run_toolCallId", (eb) => eb("runId", "=", runId)),
              )
              .find("ai_artifact", (b) =>
                b.whereIndex("idx_ai_artifact_run_createdAt", (eb) => eb("runId", "=", runId)),
              ),
          )
          .mutate(({ uow, retrieveResult }) => {
            const [run, messages, events, toolCalls, artifacts] = retrieveResult as [
              AiRunRecord | null,
              AiMessageRecord[],
              AiRunEventRecord[],
              AiToolCallRecord[],
              AiArtifactRecord[],
            ];

            if (!run) {
              throw new Error("RUN_NOT_FOUND");
            }

            for (const message of messages) {
              uow.delete("ai_message", message.id);
            }

            for (const event of events) {
              uow.delete("ai_run_event", event.id);
            }

            for (const toolCall of toolCalls) {
              uow.delete("ai_tool_call", toolCall.id);
            }

            for (const artifact of artifacts) {
              uow.delete("ai_artifact", artifact.id);
            }

            uow.delete("ai_run", run.id);
            return { ok: true };
          })
          .build();
      },
      appendMessage: function (params: AppendMessageParams) {
        const now = getNow();

        return this.serviceTx(aiSchema)
          .retrieve((uow) =>
            uow.findFirst("ai_thread", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", params.threadId)),
            ),
          )
          .mutate(({ uow, retrieveResult: [thread] }) => {
            if (!thread) {
              throw new Error("THREAD_NOT_FOUND");
            }

            const messageBytes = estimateMessageSizeBytes(params.content, params.text ?? null);
            const maxMessageBytes = resolveMaxMessageBytes(config);
            if (messageBytes > maxMessageBytes) {
              throw new Error("MESSAGE_TOO_LARGE");
            }

            const id = uow.create("ai_message", {
              threadId: params.threadId,
              role: params.role,
              content: params.content,
              text: params.text ?? null,
              runId: params.runId ?? null,
              createdAt: now,
            });

            return buildMessage({
              id,
              threadId: params.threadId,
              role: params.role,
              content: params.content,
              text: params.text ?? null,
              runId: params.runId ?? null,
              createdAt: now,
            });
          })
          .build();
      },
      listMessages: function ({
        threadId,
        pageSize = DEFAULT_PAGE_SIZE,
        cursor,
        order = "asc",
      }: ListMessagesParams) {
        const effectiveOrder = cursor?.orderDirection ?? order;
        const effectivePageSize = resolvePageSize(pageSize, cursor);

        return this.serviceTx(aiSchema)
          .retrieve((uow) =>
            uow
              .findFirst("ai_thread", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", threadId)),
              )
              .findWithCursor("ai_message", (b) => {
                const query = b
                  .whereIndex("idx_ai_message_thread_createdAt", (eb) =>
                    eb("threadId", "=", threadId),
                  )
                  .orderByIndex("idx_ai_message_thread_createdAt", effectiveOrder)
                  .pageSize(effectivePageSize);

                return cursor ? query.after(cursor) : query;
              }),
          )
          .mutate(({ retrieveResult }) => {
            const [thread, messages] = retrieveResult as [
              AiThreadRecord | undefined,
              { items: AiMessageRecord[]; cursor?: Cursor; hasNextPage: boolean },
            ];

            if (!thread) {
              throw new Error("THREAD_NOT_FOUND");
            }

            return {
              messages: messages.items.map(buildMessage),
              cursor: messages.cursor,
              hasNextPage: messages.hasNextPage,
            };
          })
          .build();
      },
      createRun: function ({
        threadId,
        type = "agent",
        executionMode = "background",
        inputMessageId,
        modelId,
        thinkingLevel,
        systemPrompt,
      }: CreateRunParams) {
        const now = getNow();
        const resolvedType = type ?? "agent";
        const resolvedExecutionMode = executionMode ?? "background";
        const allowedTypes = new Set(["agent", "deep_research"]);
        const allowedExecutionModes = new Set(["background", "foreground_stream"]);

        if (!allowedTypes.has(resolvedType)) {
          throw new Error("INVALID_RUN_TYPE");
        }

        if (!allowedExecutionModes.has(resolvedExecutionMode)) {
          throw new Error("INVALID_EXECUTION_MODE");
        }

        if (resolvedType === "deep_research" && resolvedExecutionMode !== "background") {
          throw new Error("INVALID_EXECUTION_MODE");
        }

        return this.serviceTx(aiSchema)
          .retrieve((uow) => {
            return uow
              .findFirst("ai_thread", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", threadId)),
              )
              .findFirst("ai_message", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", inputMessageId ?? "__missing__")),
              )
              .findFirst("ai_message", (b) =>
                b
                  .whereIndex("idx_ai_message_thread_role_createdAt", (eb) =>
                    eb.and(eb("threadId", "=", threadId), eb("role", "=", "user")),
                  )
                  .orderByIndex("idx_ai_message_thread_role_createdAt", "desc"),
              )
              .findWithCursor("ai_message", (b) => {
                const query = b
                  .whereIndex("idx_ai_message_thread_createdAt", (eb) =>
                    eb("threadId", "=", threadId),
                  )
                  .orderByIndex("idx_ai_message_thread_createdAt", "desc")
                  .pageSize(50);

                return query;
              });
          })
          .mutate(({ uow, retrieveResult }) => {
            const [thread, messageById, latestUserMessage, messagePage] = retrieveResult as [
              AiThreadRecord | undefined,
              AiMessageRecord | undefined,
              AiMessageRecord | undefined,
              { items: AiMessageRecord[] },
            ];

            if (!thread) {
              throw new Error("THREAD_NOT_FOUND");
            }

            let selectedMessage: AiMessageRecord | undefined;

            if (inputMessageId) {
              selectedMessage =
                messageById ??
                latestUserMessage ??
                messagePage.items.find((message) => message.id.toString() === inputMessageId) ??
                messagePage.items.find((message) => message.role === "user");
            } else {
              selectedMessage =
                latestUserMessage ?? messagePage.items.find((message) => message.role === "user");
            }

            if (
              !selectedMessage ||
              selectedMessage.role !== "user" ||
              selectedMessage.threadId !== threadId
            ) {
              throw new Error("NO_USER_MESSAGE");
            }

            const resolvedModelId =
              modelId ??
              (resolvedType === "deep_research"
                ? config.defaultDeepResearchModel?.id
                : undefined) ??
              thread.defaultModelId ??
              resolveDefaultModelId(config);
            const resolvedThinkingLevel =
              thinkingLevel ?? thread.defaultThinkingLevel ?? resolveDefaultThinkingLevel(config);
            const resolvedSystemPrompt = systemPrompt ?? thread.systemPrompt ?? null;
            const status = resolvedExecutionMode === "foreground_stream" ? "running" : "queued";
            const startedAt = status === "running" ? now : null;
            const openaiToolConfig = thread.openaiToolConfig ?? null;

            const id = uow.create("ai_run", {
              threadId,
              type: resolvedType,
              executionMode: resolvedExecutionMode,
              status,
              modelId: resolvedModelId,
              thinkingLevel: resolvedThinkingLevel,
              systemPrompt: resolvedSystemPrompt,
              inputMessageId: selectedMessage.id.toString(),
              openaiToolConfig,
              error: null,
              attempt: 1,
              maxAttempts: config.retries?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
              nextAttemptAt: null,
              openaiResponseId: null,
              openaiLastWebhookEventId: null,
              startedAt,
              completedAt: null,
              createdAt: now,
              updatedAt: now,
            });

            if (status === "queued") {
              uow.triggerHook("onRunQueued", { runId: id.toString() });
            }

            return buildRun({
              id,
              threadId,
              type: resolvedType,
              executionMode: resolvedExecutionMode,
              status,
              modelId: resolvedModelId,
              thinkingLevel: resolvedThinkingLevel,
              systemPrompt: resolvedSystemPrompt,
              inputMessageId: selectedMessage.id.toString(),
              openaiToolConfig,
              openaiResponseId: null,
              error: null,
              attempt: 1,
              maxAttempts: config.retries?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
              nextAttemptAt: null,
              createdAt: now,
              updatedAt: now,
              startedAt,
              completedAt: null,
            });
          })
          .build();
      },
      listRuns: function ({
        threadId,
        pageSize = DEFAULT_PAGE_SIZE,
        cursor,
        order = "desc",
      }: ListRunsParams) {
        const effectiveOrder = cursor?.orderDirection ?? order;
        const effectivePageSize = resolvePageSize(pageSize, cursor);

        return this.serviceTx(aiSchema)
          .retrieve((uow) =>
            uow
              .findFirst("ai_thread", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", threadId)),
              )
              .findWithCursor("ai_run", (b) => {
                const query = b
                  .whereIndex("idx_ai_run_thread_createdAt", (eb) => eb("threadId", "=", threadId))
                  .orderByIndex("idx_ai_run_thread_createdAt", effectiveOrder)
                  .pageSize(effectivePageSize);

                return cursor ? query.after(cursor) : query;
              }),
          )
          .mutate(({ retrieveResult }) => {
            const [thread, runs] = retrieveResult as [
              AiThreadRecord | undefined,
              { items: AiRunRecord[]; cursor?: Cursor; hasNextPage: boolean },
            ];

            if (!thread) {
              throw new Error("THREAD_NOT_FOUND");
            }

            return {
              runs: runs.items.map(buildRun),
              cursor: runs.cursor,
              hasNextPage: runs.hasNextPage,
            };
          })
          .build();
      },
      listRunEvents: function ({
        runId,
        pageSize = DEFAULT_PAGE_SIZE,
        cursor,
        order = "asc",
      }: ListRunEventsParams) {
        const effectiveOrder = cursor?.orderDirection ?? order;
        const effectivePageSize = resolvePageSize(pageSize, cursor);

        return this.serviceTx(aiSchema)
          .retrieve((uow) =>
            uow
              .findFirst("ai_run", (b) => b.whereIndex("primary", (eb) => eb("id", "=", runId)))
              .findWithCursor("ai_run_event", (b) => {
                const query = b
                  .whereIndex("idx_ai_run_event_run_seq", (eb) => eb("runId", "=", runId))
                  .orderByIndex("idx_ai_run_event_run_seq", effectiveOrder)
                  .pageSize(effectivePageSize);

                return cursor ? query.after(cursor) : query;
              }),
          )
          .mutate(({ retrieveResult }) => {
            const [run, events] = retrieveResult as [
              AiRunRecord | undefined,
              { items: AiRunEventRecord[]; cursor?: Cursor; hasNextPage: boolean },
            ];

            if (!run) {
              throw new Error("RUN_NOT_FOUND");
            }

            return {
              events: events.items.map(buildRunEvent),
              cursor: events.cursor,
              hasNextPage: events.hasNextPage,
            };
          })
          .build();
      },
      claimNextRuns: function ({ maxRuns = 1, now }: ClaimRunsParams = {}) {
        const effectiveNow = now ?? getNow();

        return this.serviceTx(aiSchema)
          .retrieve((uow) =>
            uow.find("ai_run", (b) => {
              const query = b
                .whereIndex("idx_ai_run_status_nextAttemptAt_updatedAt", (eb) =>
                  eb.and(
                    eb("status", "=", "queued"),
                    eb.or(eb.isNull("nextAttemptAt"), eb("nextAttemptAt", "<=", effectiveNow)),
                  ),
                )
                .orderByIndex("idx_ai_run_status_nextAttemptAt_updatedAt", "asc")
                .pageSize(maxRuns);

              return query;
            }),
          )
          .mutate(({ uow, retrieveResult: [runs] }) => {
            const claimed: AiRun[] = [];

            for (const run of runs as AiRunRecord[]) {
              const startedAt = run.startedAt ?? effectiveNow;

              uow.update("ai_run", run.id, (b) =>
                b
                  .set({
                    status: "running",
                    startedAt,
                    updatedAt: effectiveNow,
                    nextAttemptAt: null,
                  })
                  .check(),
              );

              claimed.push(
                buildRun({
                  ...run,
                  status: "running",
                  startedAt,
                  updatedAt: effectiveNow,
                  nextAttemptAt: null,
                }),
              );
            }

            return { runs: claimed };
          })
          .build();
      },
      getRun: function (runId: string) {
        return this.serviceTx(aiSchema)
          .retrieve((uow) =>
            uow.findFirst("ai_run", (b) => b.whereIndex("primary", (eb) => eb("id", "=", runId))),
          )
          .transformRetrieve(([run]) => {
            if (!run) {
              throw new Error("RUN_NOT_FOUND");
            }
            return buildRun(run);
          })
          .build();
      },
      cancelRun: function (runId: string) {
        const now = getNow();

        return this.serviceTx(aiSchema)
          .retrieve((uow) =>
            uow.findFirst("ai_run", (b) => b.whereIndex("primary", (eb) => eb("id", "=", runId))),
          )
          .mutate(({ uow, retrieveResult: [run] }) => {
            if (!run) {
              throw new Error("RUN_NOT_FOUND");
            }

            if (TERMINAL_RUN_STATUSES.has(run.status)) {
              throw new Error("RUN_TERMINAL");
            }

            uow.update("ai_run", run.id, (b) =>
              b
                .set({
                  status: "cancelled",
                  updatedAt: now,
                  completedAt: now,
                })
                .check(),
            );

            abortRunInProcess(run.id.toString());

            return buildRun({
              ...run,
              status: "cancelled",
              updatedAt: now,
              completedAt: now,
            });
          })
          .build();
      },
      listArtifacts: function (runId: string) {
        return this.serviceTx(aiSchema)
          .retrieve((uow) =>
            uow
              .findFirst("ai_run", (b) => b.whereIndex("primary", (eb) => eb("id", "=", runId)))
              .find("ai_artifact", (b) =>
                b.whereIndex("idx_ai_artifact_run_createdAt", (eb) => eb("runId", "=", runId)),
              ),
          )
          .mutate(({ retrieveResult }) => {
            const [run, artifacts] = retrieveResult as [
              AiRunRecord | undefined,
              AiArtifactRecord[],
            ];

            if (!run) {
              throw new Error("RUN_NOT_FOUND");
            }

            return {
              artifacts: artifacts.map(buildArtifact),
            };
          })
          .build();
      },
      getArtifact: function (artifactId: string) {
        return this.serviceTx(aiSchema)
          .retrieve((uow) =>
            uow.findFirst("ai_artifact", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", artifactId)),
            ),
          )
          .transformRetrieve(([artifact]) => {
            if (!artifact) {
              throw new Error("ARTIFACT_NOT_FOUND");
            }
            return buildArtifact(artifact);
          })
          .build();
      },
      claimNextWebhookEvents: function ({ maxEvents = 1 }: ClaimWebhookEventsParams = {}) {
        const now = getNow();

        return this.serviceTx(aiSchema)
          .retrieve((uow) =>
            uow.find("ai_openai_webhook_event", (b) =>
              b
                .whereIndex(
                  "idx_ai_openai_webhook_event_processedAt_processingAt_nextAttemptAt",
                  (eb) =>
                    eb.and(
                      eb.isNull("processedAt"),
                      eb.isNull("processingAt"),
                      eb.or(eb.isNull("nextAttemptAt"), eb("nextAttemptAt", "<=", now)),
                    ),
                )
                .orderByIndex(
                  "idx_ai_openai_webhook_event_processedAt_processingAt_nextAttemptAt",
                  "asc",
                )
                .pageSize(maxEvents),
            ),
          )
          .mutate(({ uow, retrieveResult: [events] }) => {
            const claimedEvents = (events as AiWebhookEventRecord[]).map((event) => {
              uow.update("ai_openai_webhook_event", event.id, (b) =>
                b.set({
                  processingAt: now,
                }),
              );

              return {
                ...event,
                processingAt: now,
              };
            });

            return {
              events: claimedEvents.map(buildWebhookEvent),
            };
          })
          .build();
      },
      recordOpenAIWebhookEvent: function (params: RecordWebhookEventParams) {
        const now = getNow();

        return this.serviceTx(aiSchema)
          .retrieve((uow) =>
            uow
              .findFirst("ai_openai_webhook_event", (b) =>
                b.whereIndex("idx_ai_openai_webhook_event_openaiEventId", (eb) =>
                  eb("openaiEventId", "=", params.openaiEventId),
                ),
              )
              .findFirst("ai_run", (b) =>
                b.whereIndex("idx_ai_run_openaiResponseId", (eb) =>
                  eb("openaiResponseId", "=", params.responseId),
                ),
              ),
          )
          .mutate(({ uow, retrieveResult: [existing, run] }) => {
            if (existing) {
              if (run && run.openaiLastWebhookEventId !== existing.id.toString()) {
                uow.update("ai_run", run.id, (b) =>
                  b
                    .set({
                      openaiLastWebhookEventId: existing.id.toString(),
                      updatedAt: now,
                    })
                    .check(),
                );
              }

              const shouldWake =
                existing.processedAt == null &&
                existing.processingAt == null &&
                (existing.nextAttemptAt == null || existing.nextAttemptAt <= now);
              if (shouldWake) {
                uow.triggerHook("onOpenAIWebhookReceived", {
                  openaiEventId: existing.openaiEventId,
                  responseId: existing.responseId,
                });
              }

              return { event: buildWebhookEvent(existing), created: false };
            }

            const id = uow.create("ai_openai_webhook_event", {
              openaiEventId: params.openaiEventId,
              type: params.type,
              responseId: params.responseId,
              payload: params.payload,
              receivedAt: now,
              processingAt: null,
              nextAttemptAt: null,
              processedAt: null,
              processingError: null,
            });

            if (run) {
              uow.update("ai_run", run.id, (b) =>
                b
                  .set({
                    openaiLastWebhookEventId: id.toString(),
                    updatedAt: now,
                  })
                  .check(),
              );
            }

            uow.triggerHook("onOpenAIWebhookReceived", {
              openaiEventId: params.openaiEventId,
              responseId: params.responseId,
            });

            return {
              event: buildWebhookEvent({
                id,
                openaiEventId: params.openaiEventId,
                type: params.type,
                responseId: params.responseId,
                payload: params.payload,
                receivedAt: now,
                processingAt: null,
                nextAttemptAt: null,
                processedAt: null,
                processingError: null,
              }),
              created: true,
            };
          })
          .build();
      },
    });
  })
  .build();
