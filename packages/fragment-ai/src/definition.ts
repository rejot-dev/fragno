import { defineFragment } from "@fragno-dev/core";
import { withDatabase, type Cursor } from "@fragno-dev/db";
import type { FragnoId } from "@fragno-dev/db/schema";
import { aiSchema } from "./schema";
import type { AiFragmentConfig } from "./index";

const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_MODEL_ID = "gpt-4o-mini";
const DEFAULT_THINKING_LEVEL = "off";
const DEFAULT_MAX_ATTEMPTS = 4;

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

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

export interface AiArtifact {
  id: string;
  runId: string;
  threadId: string;
  type: string;
  title: string | null;
  mimeType: string;
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

type AiArtifactRecord = {
  id: FragnoId;
  runId: string;
  threadId: string;
  type: string;
  title: string | null;
  mimeType: string;
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

type RecordWebhookEventParams = {
  openaiEventId: string;
  type: string;
  responseId: string;
  payload: unknown;
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

function buildArtifact(artifact: AiArtifactRecord): AiArtifact {
  return {
    id: artifact.id.toString(),
    runId: artifact.runId,
    threadId: artifact.threadId,
    type: artifact.type,
    title: artifact.title,
    mimeType: artifact.mimeType,
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
        const effectivePageSize = cursor?.pageSize ?? pageSize;

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
            uow.findFirst("ai_thread", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", threadId)),
            ),
          )
          .mutate(({ uow, retrieveResult: [thread] }) => {
            if (!thread) {
              throw new Error("THREAD_NOT_FOUND");
            }

            uow.delete("ai_thread", thread.id);
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
        const effectivePageSize = cursor?.pageSize ?? pageSize;

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

        return this.serviceTx(aiSchema)
          .retrieve((uow) => {
            return uow
              .findFirst("ai_thread", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", threadId)),
              )
              .findFirst("ai_message", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", inputMessageId ?? "__missing__")),
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
            const [thread, messageById, messagePage] = retrieveResult as [
              AiThreadRecord | undefined,
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
                messagePage.items.find((message) => message.id.toString() === inputMessageId);
            } else {
              selectedMessage = messagePage.items.find((message) => message.role === "user");
            }

            if (
              !selectedMessage ||
              selectedMessage.role !== "user" ||
              selectedMessage.threadId !== threadId
            ) {
              throw new Error("NO_USER_MESSAGE");
            }

            const resolvedModelId =
              modelId ?? thread.defaultModelId ?? resolveDefaultModelId(config);
            const resolvedThinkingLevel =
              thinkingLevel ?? thread.defaultThinkingLevel ?? resolveDefaultThinkingLevel(config);
            const resolvedSystemPrompt = systemPrompt ?? thread.systemPrompt ?? null;
            const status = executionMode === "foreground_stream" ? "running" : "queued";
            const startedAt = status === "running" ? now : null;

            const id = uow.create("ai_run", {
              threadId,
              type,
              executionMode,
              status,
              modelId: resolvedModelId,
              thinkingLevel: resolvedThinkingLevel,
              systemPrompt: resolvedSystemPrompt,
              inputMessageId: selectedMessage.id.toString(),
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

            return buildRun({
              id,
              threadId,
              type,
              executionMode,
              status,
              modelId: resolvedModelId,
              thinkingLevel: resolvedThinkingLevel,
              systemPrompt: resolvedSystemPrompt,
              inputMessageId: selectedMessage.id.toString(),
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
        const effectivePageSize = cursor?.pageSize ?? pageSize;

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
      recordOpenAIWebhookEvent: function (params: RecordWebhookEventParams) {
        const now = getNow();

        return this.serviceTx(aiSchema)
          .retrieve((uow) =>
            uow.findFirst("ai_openai_webhook_event", (b) =>
              b.whereIndex("idx_ai_openai_webhook_event_openaiEventId", (eb) =>
                eb("openaiEventId", "=", params.openaiEventId),
              ),
            ),
          )
          .mutate(({ uow, retrieveResult: [existing] }) => {
            if (existing) {
              return { event: buildWebhookEvent(existing), created: false };
            }

            const id = uow.create("ai_openai_webhook_event", {
              openaiEventId: params.openaiEventId,
              type: params.type,
              responseId: params.responseId,
              payload: params.payload,
              receivedAt: now,
              processedAt: null,
              processingError: null,
            });

            return {
              event: buildWebhookEvent({
                id,
                openaiEventId: params.openaiEventId,
                type: params.type,
                responseId: params.responseId,
                payload: params.payload,
                receivedAt: now,
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
