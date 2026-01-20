import { defineRoutes } from "@fragno-dev/core";
import { decodeCursor } from "@fragno-dev/db";
import type { FragnoId } from "@fragno-dev/db/schema";
import OpenAI from "openai";
import { z } from "zod";
import { aiFragmentDefinition, type AiRunLiveEvent } from "./definition";
import { aiSchema } from "./schema";
import type { AiRateLimitScope } from "./index";
import {
  buildOpenAIIdempotencyKey,
  buildOpenAIResponseOptions,
  createOpenAIClient,
  resolveMessageText,
  resolveOpenAIApiKey,
  resolveOpenAIResponseId,
  resolveOpenAIResponseText,
} from "./openai";
import { registerRunAbortController } from "./run-abort";
import { estimateMessageSizeBytes, resolveMaxMessageBytes } from "./limits";
import { logWithLogger } from "./logging";
import { applyToolPolicy } from "./tool-policy";

type ErrorResponder<Code extends string = string> = (
  details: { message: string; code: Code },
  initOrStatus?: unknown,
  headers?: HeadersInit,
) => Response;

const listQuerySchema = z.object({
  pageSize: z.coerce.number().min(1).max(100).catch(25),
  cursor: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
});

const DEFAULT_RETRY_BASE_DELAY_MS = 2000;
const resolveRetryDelayMs = (attempt: number, baseDelayMs: number) =>
  baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));

const resolveMaxHistoryMessages = (config: { history?: { maxMessages?: number } }) => {
  const maxMessages = config.history?.maxMessages;
  if (typeof maxMessages !== "number" || !Number.isFinite(maxMessages) || maxMessages <= 0) {
    return null;
  }
  return Math.floor(maxMessages);
};

const enforceRateLimit = async (
  config: {
    rateLimiter?: (context: {
      scope: AiRateLimitScope;
      headers: Headers;
    }) => boolean | Promise<boolean>;
  },
  scope: AiRateLimitScope,
  headers: Headers,
  error: ErrorResponder<"RATE_LIMITED">,
) => {
  if (!config.rateLimiter) {
    return null;
  }

  const allowed = await config.rateLimiter({ scope, headers });
  if (!allowed) {
    return error({ message: "Rate limit exceeded", code: "RATE_LIMITED" }, 429);
  }

  return null;
};

const threadSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  defaultModelId: z.string(),
  defaultThinkingLevel: z.string(),
  systemPrompt: z.string().nullable(),
  openaiToolConfig: z.unknown().nullable(),
  metadata: z.unknown().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const messageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  role: z.string(),
  content: z.unknown(),
  text: z.string().nullable(),
  runId: z.string().nullable(),
  createdAt: z.date(),
});

const runSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  type: z.string(),
  executionMode: z.string(),
  status: z.string(),
  modelId: z.string(),
  thinkingLevel: z.string(),
  systemPrompt: z.string().nullable(),
  inputMessageId: z.string().nullable(),
  openaiToolConfig: z.unknown().nullable(),
  openaiResponseId: z.string().nullable(),
  error: z.string().nullable(),
  attempt: z.number(),
  maxAttempts: z.number(),
  nextAttemptAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  startedAt: z.date().nullable(),
  completedAt: z.date().nullable(),
});

const runEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  seq: z.number(),
  type: z.string(),
  payload: z.unknown().nullable(),
  createdAt: z.date(),
});

const artifactSchema = z.object({
  id: z.string(),
  runId: z.string(),
  threadId: z.string(),
  type: z.string(),
  title: z.string().nullable(),
  mimeType: z.string(),
  storageKey: z.string().nullable(),
  storageMeta: z.unknown().nullable(),
  data: z.unknown(),
  text: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const createThreadSchema = z.object({
  title: z.string().optional().nullable(),
  systemPrompt: z.string().optional().nullable(),
  defaultModelId: z.string().optional(),
  defaultThinkingLevel: z.string().optional(),
  openaiToolConfig: z.unknown().optional().nullable(),
  metadata: z.unknown().optional().nullable(),
});

const updateThreadSchema = z.object({
  title: z.string().optional().nullable(),
  systemPrompt: z.string().optional().nullable(),
  defaultModelId: z.string().optional(),
  defaultThinkingLevel: z.string().optional(),
  openaiToolConfig: z.unknown().optional().nullable(),
  metadata: z.unknown().optional().nullable(),
});

const appendMessageSchema = z.object({
  role: z.string().min(1),
  content: z.unknown(),
  text: z.string().optional().nullable(),
  runId: z.string().optional().nullable(),
});

const runTypeSchema = z.enum(["agent", "deep_research"]);
const createRunSchema = z.object({
  type: runTypeSchema.optional(),
  executionMode: z.literal("background").optional(),
  inputMessageId: z.string().optional(),
  modelId: z.string().optional(),
  thinkingLevel: z.string().optional(),
  systemPrompt: z.string().optional().nullable(),
});

const createRunStreamSchema = z.object({
  type: z.literal("agent").optional(),
  executionMode: z.literal("foreground_stream").optional(),
  inputMessageId: z.string().optional(),
  modelId: z.string().optional(),
  thinkingLevel: z.string().optional(),
  systemPrompt: z.string().optional().nullable(),
});

const runnerTickSchema = z
  .object({
    maxRuns: z.coerce.number().int().positive().optional(),
    maxWebhookEvents: z.coerce.number().int().positive().optional(),
  })
  .default({});

const toolCallStatusSchema = z.enum([
  "in_progress",
  "searching",
  "interpreting",
  "generating",
  "completed",
  "failed",
]);

const runMetaEventSchema = z.object({
  type: z.literal("run.meta"),
  runId: z.string(),
  threadId: z.string(),
});

const runStatusEventSchema = z.object({
  type: z.literal("run.status"),
  runId: z.string(),
  status: z.enum(["running", "cancelled", "failed", "succeeded"]),
});

const outputTextDeltaEventSchema = z.object({
  type: z.literal("output.text.delta"),
  runId: z.string(),
  delta: z.string(),
});

const outputTextDoneEventSchema = z.object({
  type: z.literal("output.text.done"),
  runId: z.string(),
  text: z.string(),
});

const toolCallStartedEventSchema = z.object({
  type: z.literal("tool.call.started"),
  runId: z.string(),
  toolCallId: z.string(),
  toolType: z.string(),
  toolName: z.string().optional(),
});

const toolCallStatusEventSchema = z.object({
  type: z.literal("tool.call.status"),
  runId: z.string(),
  toolCallId: z.string(),
  toolType: z.string(),
  status: toolCallStatusSchema,
});

const toolCallArgumentsDeltaEventSchema = z.object({
  type: z.literal("tool.call.arguments.delta"),
  runId: z.string(),
  toolCallId: z.string(),
  delta: z.string(),
});

const toolCallArgumentsDoneEventSchema = z.object({
  type: z.literal("tool.call.arguments.done"),
  runId: z.string(),
  toolCallId: z.string(),
  arguments: z.string(),
});

const toolCallOutputEventSchema = z.object({
  type: z.literal("tool.call.output"),
  runId: z.string(),
  toolCallId: z.string(),
  toolType: z.string(),
  output: z.unknown(),
  isError: z.boolean().optional(),
});

const runFinalEventSchema = z.object({
  type: z.literal("run.final"),
  runId: z.string(),
  status: z.string(),
  run: runSchema,
});

const runLiveEventSchema = z.discriminatedUnion("type", [
  runMetaEventSchema,
  runStatusEventSchema,
  outputTextDeltaEventSchema,
  outputTextDoneEventSchema,
  toolCallStartedEventSchema,
  toolCallStatusEventSchema,
  toolCallArgumentsDeltaEventSchema,
  toolCallArgumentsDoneEventSchema,
  toolCallOutputEventSchema,
  runFinalEventSchema,
]);

type ToolCallStatus = z.infer<typeof toolCallStatusSchema>;

const toolCallStatuses = new Set([
  "in_progress",
  "searching",
  "interpreting",
  "generating",
  "completed",
  "failed",
]);

const isToolCallType = (value: unknown): value is string => {
  return typeof value === "string" && (value === "function_call" || value.endsWith("_call"));
};

const resolveToolName = (item: Record<string, unknown>) => {
  if (typeof item["name"] === "string") {
    return item["name"];
  }

  const fn = item["function"] as { name?: unknown } | undefined;
  if (fn && typeof fn.name === "string") {
    return fn.name;
  }

  return undefined;
};

const resolveToolCallIdFromEvent = (
  event: Record<string, unknown>,
  toolCallIdByCallId: Map<string, string>,
) => {
  const itemId = typeof event["item_id"] === "string" ? event["item_id"] : null;
  const callId = typeof event["call_id"] === "string" ? event["call_id"] : null;

  if (callId && toolCallIdByCallId.has(callId)) {
    return toolCallIdByCallId.get(callId) ?? callId;
  }

  return itemId ?? callId ?? null;
};

const resolveToolCallIdFromItem = (
  item: Record<string, unknown>,
  event: Record<string, unknown>,
  toolCallIdByCallId: Map<string, string>,
) => {
  const itemId = typeof item["id"] === "string" ? item["id"] : null;
  const callId =
    typeof item["call_id"] === "string"
      ? item["call_id"]
      : typeof event["call_id"] === "string"
        ? event["call_id"]
        : null;

  if (callId) {
    const existing = toolCallIdByCallId.get(callId);
    if (existing) {
      return existing;
    }

    if (itemId && callId !== itemId && item["type"] === "function_call") {
      const combined = `${callId}|${itemId}`;
      toolCallIdByCallId.set(callId, combined);
      return combined;
    }

    toolCallIdByCallId.set(callId, itemId ?? callId);
  }

  return itemId ?? callId ?? null;
};

const resolveToolCallStatus = (status: unknown, fallback: ToolCallStatus): ToolCallStatus => {
  if (typeof status === "string" && toolCallStatuses.has(status)) {
    return status as ToolCallStatus;
  }

  return fallback;
};

const resolveToolOutput = (item: Record<string, unknown>) => {
  if ("output" in item) {
    return item["output"];
  }
  if ("result" in item) {
    return item["result"];
  }
  if ("results" in item) {
    return item["results"];
  }
  if ("content" in item) {
    return item["content"];
  }

  return undefined;
};

const listEventsQuerySchema = listQuerySchema;

const parseCursor = (cursorParam: string | undefined) => {
  if (!cursorParam) {
    return undefined;
  }
  try {
    return decodeCursor(cursorParam);
  } catch {
    return undefined;
  }
};

const handleServiceError = <Code extends string>(err: unknown, error: ErrorResponder<Code>) => {
  if (!(err instanceof Error)) {
    throw err;
  }

  if (err.message === "THREAD_NOT_FOUND") {
    return error({ message: "Thread not found", code: "THREAD_NOT_FOUND" as Code }, 404);
  }

  if (err.message === "RUN_NOT_FOUND") {
    return error({ message: "Run not found", code: "RUN_NOT_FOUND" as Code }, 404);
  }

  if (err.message === "ARTIFACT_NOT_FOUND") {
    return error({ message: "Artifact not found", code: "ARTIFACT_NOT_FOUND" as Code }, 404);
  }

  if (err.message === "RUN_TERMINAL") {
    return error({ message: "Run is terminal", code: "RUN_TERMINAL" as Code }, 409);
  }

  if (err.message === "NO_USER_MESSAGE") {
    return error({ message: "No user message found", code: "NO_USER_MESSAGE" as Code }, 400);
  }

  if (err.message === "MESSAGE_TOO_LARGE") {
    return error({ message: "Message exceeds size limit", code: "MESSAGE_TOO_LARGE" as Code }, 413);
  }

  throw err;
};

const parseWebhookEvent = (payload: unknown) => {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as { id?: unknown; type?: unknown; data?: { id?: unknown } };
  if (typeof record.id !== "string" || typeof record.type !== "string") {
    return null;
  }

  const responseId = typeof record.data?.id === "string" ? record.data.id : null;
  if (!responseId) {
    return null;
  }

  return { openaiEventId: record.id, type: record.type, responseId };
};

export const aiRoutesFactory = defineRoutes(aiFragmentDefinition).create(
  ({ defineRoute, services, config }) => {
    const baseRoutes = [
      defineRoute({
        method: "POST",
        path: "/threads",
        inputSchema: createThreadSchema,
        outputSchema: threadSchema,
        handler: async function (context, { json }) {
          const payload = await context.input.valid();

          const thread = await this.handlerTx()
            .withServiceCalls(() => [services.createThread(payload)])
            .transform(({ serviceResult: [result] }) => result)
            .execute();

          return json(thread);
        },
      }),
      defineRoute({
        method: "GET",
        path: "/threads",
        queryParameters: ["pageSize", "cursor", "order"],
        outputSchema: z.object({
          threads: z.array(threadSchema),
          cursor: z.string().optional(),
          hasNextPage: z.boolean(),
        }),
        handler: async function ({ query }, { json }) {
          const params = listQuerySchema.parse({
            pageSize: query.get("pageSize"),
            cursor: query.get("cursor") || undefined,
            order: query.get("order") || undefined,
          });
          const cursor = parseCursor(params.cursor);

          const result = await this.handlerTx()
            .withServiceCalls(() => [
              services.listThreads({
                pageSize: params.pageSize,
                cursor,
                order: params.order,
              }),
            ])
            .transform(({ serviceResult: [value] }) => value)
            .execute();

          return json({
            threads: result.threads,
            cursor: result.cursor?.encode(),
            hasNextPage: result.hasNextPage,
          });
        },
      }),
      defineRoute({
        method: "GET",
        path: "/threads/:threadId",
        outputSchema: threadSchema,
        errorCodes: ["THREAD_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          try {
            const thread = await this.handlerTx()
              .withServiceCalls(() => [services.getThread(pathParams.threadId)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            return json(thread);
          } catch (err) {
            return handleServiceError(err, error as ErrorResponder);
          }
        },
      }),
      defineRoute({
        method: "PATCH",
        path: "/threads/:threadId",
        inputSchema: updateThreadSchema,
        outputSchema: threadSchema,
        errorCodes: ["THREAD_NOT_FOUND"],
        handler: async function ({ pathParams, input }, { json, error }) {
          const payload = await input.valid();

          try {
            const thread = await this.handlerTx()
              .withServiceCalls(() => [services.updateThread(pathParams.threadId, payload)])
              .transform(({ serviceResult: [result] }) => result)
              .execute();

            return json(thread);
          } catch (err) {
            return handleServiceError(err, error as ErrorResponder);
          }
        },
      }),
      defineRoute({
        method: "DELETE",
        path: "/admin/threads/:threadId",
        outputSchema: z.object({ ok: z.boolean() }),
        errorCodes: ["THREAD_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          try {
            const result = await this.handlerTx()
              .withServiceCalls(() => [services.deleteThread(pathParams.threadId)])
              .transform(({ serviceResult: [value] }) => value)
              .execute();

            return json(result);
          } catch (err) {
            return handleServiceError(err, error as ErrorResponder);
          }
        },
      }),
      defineRoute({
        method: "POST",
        path: "/threads/:threadId/messages",
        inputSchema: appendMessageSchema,
        outputSchema: messageSchema,
        errorCodes: ["THREAD_NOT_FOUND", "MESSAGE_TOO_LARGE"],
        handler: async function ({ pathParams, input }, { json, error }) {
          const payload = await input.valid();

          try {
            const message = await this.handlerTx()
              .withServiceCalls(() => [
                services.appendMessage({
                  threadId: pathParams.threadId,
                  role: payload.role,
                  content: payload.content,
                  text: payload.text,
                  runId: payload.runId,
                }),
              ])
              .transform(({ serviceResult: [value] }) => value)
              .execute();

            return json(message);
          } catch (err) {
            return handleServiceError(err, error as ErrorResponder);
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/threads/:threadId/messages",
        queryParameters: ["pageSize", "cursor", "order"],
        outputSchema: z.object({
          messages: z.array(messageSchema),
          cursor: z.string().optional(),
          hasNextPage: z.boolean(),
        }),
        errorCodes: ["THREAD_NOT_FOUND"],
        handler: async function ({ pathParams, query }, { json, error }) {
          const params = listQuerySchema.parse({
            pageSize: query.get("pageSize"),
            cursor: query.get("cursor") || undefined,
            order: query.get("order") || undefined,
          });
          const cursor = parseCursor(params.cursor);

          try {
            const result = await this.handlerTx()
              .withServiceCalls(() => [
                services.listMessages({
                  threadId: pathParams.threadId,
                  pageSize: params.pageSize,
                  cursor,
                  order: params.order,
                }),
              ])
              .transform(({ serviceResult: [value] }) => value)
              .execute();

            return json({
              messages: result.messages,
              cursor: result.cursor?.encode(),
              hasNextPage: result.hasNextPage,
            });
          } catch (err) {
            return handleServiceError(err, error as ErrorResponder);
          }
        },
      }),
      defineRoute({
        method: "POST",
        path: "/threads/:threadId/runs",
        inputSchema: createRunSchema,
        outputSchema: runSchema,
        errorCodes: ["THREAD_NOT_FOUND", "NO_USER_MESSAGE"],
        handler: async function ({ pathParams, input }, { json, error }) {
          const payload = await input.valid();

          try {
            const run = await this.handlerTx()
              .withServiceCalls(() => [
                services.createRun({
                  threadId: pathParams.threadId,
                  type: payload.type,
                  executionMode: "background",
                  inputMessageId: payload.inputMessageId,
                  modelId: payload.modelId,
                  thinkingLevel: payload.thinkingLevel,
                  systemPrompt: payload.systemPrompt ?? null,
                }),
              ])
              .transform(({ serviceResult: [value] }) => value)
              .execute();

            return json(run);
          } catch (err) {
            return handleServiceError(err, error as ErrorResponder);
          }
        },
      }),
      defineRoute({
        method: "POST",
        path: "/threads/:threadId/runs:stream",
        inputSchema: createRunStreamSchema,
        outputSchema: z.array(runLiveEventSchema),
        errorCodes: ["THREAD_NOT_FOUND", "NO_USER_MESSAGE", "OPENAI_API_KEY_MISSING"],
        handler: async function ({ pathParams, input }, { jsonStream, error }) {
          const payload = await input.valid();

          let run: z.infer<typeof runSchema>;

          try {
            run = await this.handlerTx()
              .withServiceCalls(() => [
                services.createRun({
                  threadId: pathParams.threadId,
                  type: payload.type ?? "agent",
                  executionMode: "foreground_stream",
                  inputMessageId: payload.inputMessageId,
                  modelId: payload.modelId,
                  thinkingLevel: payload.thinkingLevel,
                  systemPrompt: payload.systemPrompt ?? null,
                }),
              ])
              .transform(({ serviceResult: [value] }) => value)
              .execute();
          } catch (err) {
            return handleServiceError(err, error as ErrorResponder);
          }

          const thread = await this.handlerTx()
            .withServiceCalls(() => [services.getThread(pathParams.threadId)])
            .transform(({ serviceResult: [value] }) => value)
            .execute();

          const pageSize = Math.max(100, resolveMaxHistoryMessages(config) ?? 0);
          const collectedMessages: Array<z.infer<typeof messageSchema>> = [];
          let cursor: ReturnType<typeof decodeCursor> | undefined;
          let hasNextPage = true;

          while (hasNextPage) {
            const page = await this.handlerTx()
              .withServiceCalls(() => [
                services.listMessages({
                  threadId: pathParams.threadId,
                  order: "asc",
                  pageSize,
                  cursor,
                }),
              ])
              .transform(({ serviceResult: [value] }) => value)
              .execute();

            collectedMessages.push(...page.messages);

            if (run.inputMessageId) {
              const cutoffIndex = collectedMessages.findIndex(
                (message) => message.id === run.inputMessageId,
              );
              if (cutoffIndex >= 0) {
                collectedMessages.splice(cutoffIndex + 1);
                break;
              }
            }

            hasNextPage = page.hasNextPage;
            cursor = page.cursor;
          }

          const openaiInput: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];
          const conversation: Array<{ role: "user" | "assistant"; content: string }> = [];
          const maxMessages = resolveMaxHistoryMessages(config);

          if (run.systemPrompt) {
            openaiInput.push({ role: "system", content: run.systemPrompt });
          }

          for (const message of collectedMessages) {
            if (message.role !== "user" && message.role !== "assistant") {
              continue;
            }

            const text = resolveMessageText(message);
            if (!text) {
              continue;
            }

            conversation.push({ role: message.role as "user" | "assistant", content: text });
          }

          if (maxMessages && conversation.length > maxMessages) {
            conversation.splice(0, conversation.length - maxMessages);
          }

          openaiInput.push(...conversation);

          let openaiClient: OpenAI;
          try {
            openaiClient = await createOpenAIClient(config);
          } catch (err) {
            if (err instanceof Error && err.message === "OPENAI_API_KEY_MISSING") {
              return error(
                { message: "OpenAI API key is required", code: "OPENAI_API_KEY_MISSING" },
                400,
              );
            }
            throw err;
          }

          return jsonStream(async (stream) => {
            let finalStatus: "succeeded" | "failed" | "cancelled" | "queued" = "succeeded";
            let errorMessage: string | null = null;
            let textBuffer = "";
            let canWrite = true;
            let openaiResponseId = run.openaiResponseId;
            const runEvents: Array<{ type: string; payload: unknown | null; createdAt: Date }> = [];
            const persistDeltas = Boolean(config.storage?.persistDeltas);
            const toolCallIdByCallId = new Map<string, string>();
            const abortController = new AbortController();
            const unregisterAbort = registerRunAbortController(run.id, abortController);
            let sawOutputTextDone = false;
            let allowRetry = true;

            const baseToolConfig = run.openaiToolConfig ?? thread.openaiToolConfig;
            const toolPolicyResult = await applyToolPolicy({
              policy: config.toolPolicy,
              context: {
                threadId: run.threadId,
                runId: run.id,
                runType: run.type as "agent" | "deep_research",
                executionMode: run.executionMode as "foreground_stream" | "background",
                modelId: run.modelId,
                openaiToolConfig: baseToolConfig ?? null,
              },
            });

            if (toolPolicyResult.deniedReason) {
              finalStatus = "failed";
              errorMessage = toolPolicyResult.deniedReason;
              allowRetry = false;
              logWithLogger(config.logger, "warn", {
                event: "ai.run.tool_policy.denied",
                runId: run.id,
                threadId: run.threadId,
                type: run.type,
                executionMode: run.executionMode,
                reason: toolPolicyResult.deniedReason,
              });
            }

            const safeWrite = async (payload: AiRunLiveEvent) => {
              if (!canWrite) {
                return;
              }
              try {
                await stream.write(payload);
              } catch {
                canWrite = false;
              }
            };

            const recordRunEvent = (
              type: string,
              payload: unknown | null,
              createdAt: Date = new Date(),
            ) => {
              runEvents.push({ type, payload, createdAt });
            };

            const recordRunEventIfEnabled = (type: string, payload: unknown | null) => {
              if (persistDeltas) {
                recordRunEvent(type, payload);
              }
            };

            const persistOpenAIResponseId = async (responseId: string) => {
              if (openaiResponseId) {
                return;
              }

              openaiResponseId = responseId;
              run = { ...run, openaiResponseId: responseId };

              try {
                const runId = run.id as unknown as FragnoId;
                await this.handlerTx()
                  .mutate(({ forSchema }) => {
                    forSchema(aiSchema).update("ai_run", runId, (b) =>
                      b.set({ openaiResponseId: responseId, updatedAt: new Date() }),
                    );
                  })
                  .execute();
              } catch {
                // Best-effort update; finalization will still persist run status.
              }
            };

            await safeWrite({ type: "run.meta", runId: run.id, threadId: run.threadId });
            recordRunEvent("run.meta", { runId: run.id, threadId: run.threadId });

            if (!toolPolicyResult.deniedReason) {
              await safeWrite({ type: "run.status", runId: run.id, status: "running" });
              recordRunEvent("run.status", { status: "running" });

              logWithLogger(config.logger, "info", {
                event: "ai.run.started",
                runId: run.id,
                threadId: run.threadId,
                type: run.type,
                executionMode: run.executionMode,
                attempt: run.attempt,
              });

              try {
                const responseOptions = buildOpenAIResponseOptions({
                  config,
                  modelId: run.modelId,
                  input: openaiInput,
                  thinkingLevel: run.thinkingLevel,
                  openaiToolConfig: toolPolicyResult.openaiToolConfig,
                  stream: true,
                });
                const responseStream = (await openaiClient.responses.create(responseOptions, {
                  idempotencyKey: buildOpenAIIdempotencyKey(String(run.id), run.attempt),
                  signal: abortController.signal,
                })) as unknown as AsyncIterable<Record<string, unknown>>;

                for await (const event of responseStream) {
                  const responseId = resolveOpenAIResponseId(event);
                  if (responseId) {
                    await persistOpenAIResponseId(responseId);
                  }

                  const eventType = event["type"];
                  if (typeof eventType !== "string") {
                    continue;
                  }

                  if (eventType === "response.output_text.delta") {
                    const delta = typeof event["delta"] === "string" ? event["delta"] : null;
                    if (!delta) {
                      continue;
                    }
                    textBuffer += delta;
                    await safeWrite({
                      type: "output.text.delta",
                      runId: run.id,
                      delta,
                    });
                    recordRunEventIfEnabled("output.text.delta", { delta });
                  } else if (eventType === "response.output_text.done") {
                    const text = typeof event["text"] === "string" ? event["text"] : null;
                    if (!text) {
                      continue;
                    }
                    textBuffer = text;
                    sawOutputTextDone = true;
                    await safeWrite({
                      type: "output.text.done",
                      runId: run.id,
                      text,
                    });
                    recordRunEvent("output.text.done", { text });
                  } else if (eventType === "response.output_item.added") {
                    const item = ((event as { item?: unknown })["item"] ??
                      (event as { output_item?: unknown })["output_item"]) as
                      | Record<string, unknown>
                      | undefined;

                    if (item && isToolCallType(item["type"])) {
                      const toolCallId = resolveToolCallIdFromItem(item, event, toolCallIdByCallId);
                      if (toolCallId) {
                        const toolType = item["type"] as string;
                        const toolName = resolveToolName(item);

                        await safeWrite({
                          type: "tool.call.started",
                          runId: run.id,
                          toolCallId,
                          toolType,
                          ...(toolName ? { toolName } : {}),
                        });
                        recordRunEventIfEnabled("tool.call.started", {
                          toolCallId,
                          toolType,
                          ...(toolName ? { toolName } : {}),
                        });

                        await safeWrite({
                          type: "tool.call.status",
                          runId: run.id,
                          toolCallId,
                          toolType,
                          status: "in_progress",
                        });
                        recordRunEventIfEnabled("tool.call.status", {
                          toolCallId,
                          toolType,
                          status: "in_progress",
                        });
                      }
                    }
                  } else if (eventType === "response.function_call_arguments.delta") {
                    const toolCallId = resolveToolCallIdFromEvent(event, toolCallIdByCallId);
                    const delta = typeof event["delta"] === "string" ? event["delta"] : null;
                    if (toolCallId && delta) {
                      await safeWrite({
                        type: "tool.call.arguments.delta",
                        runId: run.id,
                        toolCallId,
                        delta,
                      });
                      recordRunEventIfEnabled("tool.call.arguments.delta", {
                        toolCallId,
                        delta,
                      });
                    }
                  } else if (eventType === "response.function_call_arguments.done") {
                    const toolCallId = resolveToolCallIdFromEvent(event, toolCallIdByCallId);
                    const args =
                      typeof event["arguments"] === "string"
                        ? event["arguments"]
                        : typeof event["args"] === "string"
                          ? event["args"]
                          : null;

                    if (toolCallId && args) {
                      await safeWrite({
                        type: "tool.call.arguments.done",
                        runId: run.id,
                        toolCallId,
                        arguments: args,
                      });
                      recordRunEventIfEnabled("tool.call.arguments.done", {
                        toolCallId,
                        arguments: args,
                      });
                    }
                  } else if (eventType === "response.function_call_arguments.completed") {
                    const toolCallId = resolveToolCallIdFromEvent(event, toolCallIdByCallId);
                    const args =
                      typeof event["arguments"] === "string"
                        ? event["arguments"]
                        : typeof event["args"] === "string"
                          ? event["args"]
                          : null;

                    if (toolCallId && args) {
                      await safeWrite({
                        type: "tool.call.arguments.done",
                        runId: run.id,
                        toolCallId,
                        arguments: args,
                      });
                      recordRunEventIfEnabled("tool.call.arguments.done", {
                        toolCallId,
                        arguments: args,
                      });
                    }
                  } else if (eventType === "response.output_item.done") {
                    const item = ((event as { item?: unknown })["item"] ??
                      (event as { output_item?: unknown })["output_item"]) as
                      | Record<string, unknown>
                      | undefined;

                    if (item && isToolCallType(item["type"])) {
                      const toolCallId = resolveToolCallIdFromItem(item, event, toolCallIdByCallId);
                      if (toolCallId) {
                        const toolType = item["type"] as string;
                        const status = resolveToolCallStatus(item["status"], "completed");
                        await safeWrite({
                          type: "tool.call.status",
                          runId: run.id,
                          toolCallId,
                          toolType,
                          status,
                        });
                        recordRunEventIfEnabled("tool.call.status", {
                          toolCallId,
                          toolType,
                          status,
                        });

                        const output = resolveToolOutput(item);
                        if (output !== undefined) {
                          await safeWrite({
                            type: "tool.call.output",
                            runId: run.id,
                            toolCallId,
                            toolType,
                            output,
                          });
                          recordRunEventIfEnabled("tool.call.output", {
                            toolCallId,
                            toolType,
                            output,
                          });
                        }
                      }
                    }
                  }
                }
              } catch (err) {
                if (
                  abortController.signal.aborted ||
                  (err instanceof Error && err.name === "AbortError")
                ) {
                  finalStatus = "cancelled";
                  errorMessage = null;
                } else if (openaiResponseId) {
                  try {
                    const recovered = await openaiClient.responses.retrieve(openaiResponseId);
                    const recoveredText = resolveOpenAIResponseText(recovered);
                    if (recoveredText) {
                      textBuffer = recoveredText;
                      if (!sawOutputTextDone) {
                        await safeWrite({
                          type: "output.text.done",
                          runId: run.id,
                          text: recoveredText,
                        });
                        recordRunEvent("output.text.done", { text: recoveredText });
                      }
                      finalStatus = "succeeded";
                      errorMessage = null;
                    } else {
                      finalStatus = "failed";
                      errorMessage = "OpenAI response missing output text";
                    }
                  } catch (retrieveError) {
                    finalStatus = "failed";
                    errorMessage =
                      retrieveError instanceof Error
                        ? retrieveError.message
                        : "OpenAI request failed";
                  }
                } else {
                  finalStatus = "failed";
                  errorMessage = err instanceof Error ? err.message : "OpenAI request failed";
                }
              } finally {
                unregisterAbort();
              }
            } else {
              await safeWrite({ type: "run.status", runId: run.id, status: "failed" });
              recordRunEvent("run.status", { status: "failed" });
              unregisterAbort();
            }

            const updatedAt = new Date();
            let completedAt: Date | null = updatedAt;
            let nextAttemptAt: Date | null = null;
            let updatedAttempt = run.attempt;

            let assistantText = finalStatus === "succeeded" ? textBuffer || null : null;
            if (assistantText) {
              const maxMessageBytes = resolveMaxMessageBytes(config);
              const messageBytes = estimateMessageSizeBytes(
                { type: "text", text: assistantText },
                assistantText,
              );
              if (messageBytes > maxMessageBytes) {
                finalStatus = "failed";
                errorMessage = "MESSAGE_TOO_LARGE";
                assistantText = null;
                allowRetry = false;
              }
            }

            if (
              finalStatus === "failed" &&
              allowRetry &&
              !openaiResponseId &&
              run.attempt < run.maxAttempts
            ) {
              const baseDelayMs = config.retries?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
              const delayMs = resolveRetryDelayMs(run.attempt, baseDelayMs);
              nextAttemptAt = new Date(updatedAt.getTime() + delayMs);
              updatedAttempt = run.attempt + 1;
              finalStatus = "queued";
              completedAt = null;
            }

            if (finalStatus !== "succeeded") {
              assistantText = null;
            }
            const finalRun = {
              ...run,
              status: finalStatus,
              error: errorMessage,
              attempt: updatedAttempt,
              nextAttemptAt,
              updatedAt,
              completedAt,
            };

            recordRunEvent("run.final", {
              status: finalStatus,
              error: errorMessage,
              completedAt: completedAt ? completedAt.toISOString() : null,
              nextAttemptAt: nextAttemptAt ? nextAttemptAt.toISOString() : null,
            });

            try {
              await this.handlerTx()
                .retrieve(({ forSchema }) =>
                  forSchema(aiSchema).findFirst("ai_run", (b) =>
                    b.whereIndex("primary", (eb) => eb("id", "=", run.id)),
                  ),
                )
                .mutate(({ forSchema, retrieveResult }) => {
                  const [runRecord] = retrieveResult as [
                    { id: unknown; threadId: string } | undefined,
                  ];

                  if (!runRecord) {
                    throw new Error("RUN_NOT_FOUND");
                  }

                  const schema = forSchema(aiSchema);
                  schema.update("ai_run", runRecord.id as FragnoId, (b) =>
                    b
                      .set({
                        status: finalStatus,
                        error: errorMessage,
                        attempt: updatedAttempt,
                        nextAttemptAt,
                        updatedAt,
                        completedAt,
                      })
                      .check(),
                  );

                  if (assistantText) {
                    schema.create("ai_message", {
                      threadId: runRecord.threadId,
                      role: "assistant",
                      content: { type: "text", text: assistantText },
                      text: assistantText,
                      runId: run.id,
                      createdAt: updatedAt,
                    });
                  }

                  let seq = 1;
                  for (const event of runEvents) {
                    schema.create("ai_run_event", {
                      runId: run.id,
                      threadId: runRecord.threadId,
                      seq,
                      type: event.type,
                      payload: event.payload,
                      createdAt: event.createdAt,
                    });
                    seq += 1;
                  }
                })
                .execute();
            } catch (err) {
              if (!errorMessage) {
                finalStatus = "failed";
                errorMessage = err instanceof Error ? err.message : "Failed to finalize run";
              }
            }

            if (finalStatus === "queued") {
              try {
                await config.dispatcher?.wake?.({ type: "run.queued", runId: run.id });
              } catch {
                // Best-effort wake; stream response should still complete.
              }
            }

            if (finalStatus === "queued" && nextAttemptAt) {
              logWithLogger(config.logger, "warn", {
                event: "ai.run.retry_scheduled",
                runId: run.id,
                threadId: run.threadId,
                attempt: run.attempt + 1,
                error: errorMessage,
                retryScheduledAt: nextAttemptAt.toISOString(),
              });
            }

            logWithLogger(
              config.logger,
              finalStatus === "failed" ? "error" : finalStatus === "queued" ? "warn" : "info",
              {
                event: "ai.run.completed",
                runId: run.id,
                threadId: run.threadId,
                status: finalStatus,
                error: errorMessage,
                openaiResponseId,
                ...(nextAttemptAt ? { retryScheduledAt: nextAttemptAt.toISOString() } : {}),
              },
            );

            await safeWrite({
              type: "run.final",
              runId: run.id,
              status: finalStatus,
              run: { ...finalRun, status: finalStatus, error: errorMessage },
            });
          });
        },
      }),
      defineRoute({
        method: "GET",
        path: "/threads/:threadId/runs",
        queryParameters: ["pageSize", "cursor", "order"],
        outputSchema: z.object({
          runs: z.array(runSchema),
          cursor: z.string().optional(),
          hasNextPage: z.boolean(),
        }),
        errorCodes: ["THREAD_NOT_FOUND"],
        handler: async function ({ pathParams, query }, { json, error }) {
          const params = listQuerySchema.parse({
            pageSize: query.get("pageSize"),
            cursor: query.get("cursor") || undefined,
            order: query.get("order") || undefined,
          });
          const cursor = parseCursor(params.cursor);

          try {
            const result = await this.handlerTx()
              .withServiceCalls(() => [
                services.listRuns({
                  threadId: pathParams.threadId,
                  pageSize: params.pageSize,
                  cursor,
                  order: params.order,
                }),
              ])
              .transform(({ serviceResult: [value] }) => value)
              .execute();

            return json({
              runs: result.runs,
              cursor: result.cursor?.encode(),
              hasNextPage: result.hasNextPage,
            });
          } catch (err) {
            return handleServiceError(err, error as ErrorResponder);
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/runs/:runId",
        outputSchema: runSchema,
        errorCodes: ["RUN_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          try {
            const run = await this.handlerTx()
              .withServiceCalls(() => [services.getRun(pathParams.runId)])
              .transform(({ serviceResult: [value] }) => value)
              .execute();

            return json(run);
          } catch (err) {
            return handleServiceError(err, error as ErrorResponder);
          }
        },
      }),
      defineRoute({
        method: "POST",
        path: "/runs/:runId/cancel",
        outputSchema: runSchema,
        errorCodes: ["RUN_NOT_FOUND", "RUN_TERMINAL"],
        handler: async function ({ pathParams }, { json, error }) {
          try {
            const run = await this.handlerTx()
              .withServiceCalls(() => [services.cancelRun(pathParams.runId)])
              .transform(({ serviceResult: [value] }) => value)
              .execute();

            return json(run);
          } catch (err) {
            return handleServiceError(err, error as ErrorResponder);
          }
        },
      }),
      defineRoute({
        method: "DELETE",
        path: "/admin/runs/:runId",
        outputSchema: z.object({ ok: z.boolean() }),
        errorCodes: ["RUN_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          try {
            const result = await this.handlerTx()
              .withServiceCalls(() => [services.deleteRun(pathParams.runId)])
              .transform(({ serviceResult: [value] }) => value)
              .execute();

            return json(result);
          } catch (err) {
            return handleServiceError(err, error as ErrorResponder);
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/runs/:runId/events",
        queryParameters: ["pageSize", "cursor", "order"],
        outputSchema: z.object({
          events: z.array(runEventSchema),
          cursor: z.string().optional(),
          hasNextPage: z.boolean(),
        }),
        errorCodes: ["RUN_NOT_FOUND"],
        handler: async function ({ pathParams, query }, { json, error }) {
          const params = listEventsQuerySchema.parse({
            pageSize: query.get("pageSize"),
            cursor: query.get("cursor") || undefined,
            order: query.get("order") || undefined,
          });
          const cursor = parseCursor(params.cursor);

          try {
            const result = await this.handlerTx()
              .withServiceCalls(() => [
                services.listRunEvents({
                  runId: pathParams.runId,
                  pageSize: params.pageSize,
                  cursor,
                  order: params.order,
                }),
              ])
              .transform(({ serviceResult: [value] }) => value)
              .execute();

            return json({
              events: result.events,
              cursor: result.cursor?.encode(),
              hasNextPage: result.hasNextPage,
            });
          } catch (err) {
            return handleServiceError(err, error as ErrorResponder);
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/runs/:runId/artifacts",
        outputSchema: z.object({
          artifacts: z.array(artifactSchema),
        }),
        errorCodes: ["RUN_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          try {
            const result = await this.handlerTx()
              .withServiceCalls(() => [services.listArtifacts(pathParams.runId)])
              .transform(({ serviceResult: [value] }) => value)
              .execute();

            return json(result);
          } catch (err) {
            return handleServiceError(err, error as ErrorResponder);
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/artifacts/:artifactId",
        outputSchema: artifactSchema,
        errorCodes: ["ARTIFACT_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          try {
            const artifact = await this.handlerTx()
              .withServiceCalls(() => [services.getArtifact(pathParams.artifactId)])
              .transform(({ serviceResult: [value] }) => value)
              .execute();

            return json(artifact);
          } catch (err) {
            return handleServiceError(err, error as ErrorResponder);
          }
        },
      }),
      defineRoute({
        method: "POST",
        path: "/webhooks/openai",
        outputSchema: z.object({ ok: z.boolean() }),
        errorCodes: [
          "WEBHOOK_NOT_CONFIGURED",
          "INVALID_SIGNATURE",
          "VALIDATION_ERROR",
          "RATE_LIMITED",
        ],
        handler: async function ({ headers, rawBody }, { json, error }) {
          if (!config.webhookSecret) {
            return error(
              { message: "OpenAI webhook secret not configured", code: "WEBHOOK_NOT_CONFIGURED" },
              400,
            );
          }

          const rateLimited = await enforceRateLimit(
            config,
            "webhook_openai",
            headers,
            error as ErrorResponder<"RATE_LIMITED">,
          );
          if (rateLimited) {
            return rateLimited;
          }

          if (!rawBody) {
            return error({ message: "Missing webhook payload", code: "VALIDATION_ERROR" }, 400);
          }

          const apiKey = (await resolveOpenAIApiKey(config)) ?? "webhook-only";
          const openaiClient = new OpenAI({
            apiKey,
            webhookSecret: config.webhookSecret,
          });

          let event: unknown;
          try {
            event = await openaiClient.webhooks.unwrap(rawBody, headers, config.webhookSecret);
          } catch (err) {
            if (err instanceof OpenAI.InvalidWebhookSignatureError) {
              return error(
                { message: "Invalid webhook signature", code: "INVALID_SIGNATURE" },
                401,
              );
            }

            return error({ message: "Invalid webhook payload", code: "VALIDATION_ERROR" }, 400);
          }

          const parsed = parseWebhookEvent(event);
          if (!parsed) {
            return error(
              { message: "Webhook payload missing response id", code: "VALIDATION_ERROR" },
              400,
            );
          }

          const shouldPersistRawPayload = Boolean(config.storage?.persistOpenAIRawResponses);
          const storedPayload = shouldPersistRawPayload ? event : { redacted: true };

          await this.handlerTx()
            .withServiceCalls(() => [
              services.recordOpenAIWebhookEvent({
                openaiEventId: parsed.openaiEventId,
                type: parsed.type,
                responseId: parsed.responseId,
                payload: storedPayload,
              }),
            ])
            .execute();

          logWithLogger(config.logger, "info", {
            event: "ai.webhook.received",
            openaiEventId: parsed.openaiEventId,
            responseId: parsed.responseId,
            type: parsed.type,
          });

          return json({ ok: true });
        },
      }),
    ] as const;

    if (!config.enableRunnerTick) {
      return baseRoutes;
    }

    const runnerTickRoute = defineRoute({
      method: "POST",
      path: "/_runner/tick",
      inputSchema: runnerTickSchema,
      outputSchema: z.object({
        processedRuns: z.number(),
        processedWebhookEvents: z.number(),
      }),
      errorCodes: ["RUNNER_NOT_AVAILABLE", "RATE_LIMITED"],
      handler: async function ({ input, headers }, { json, error }) {
        const payload = await input.valid();

        const rateLimited = await enforceRateLimit(
          config,
          "runner_tick",
          headers,
          error as ErrorResponder<"RATE_LIMITED">,
        );
        if (rateLimited) {
          return rateLimited;
        }

        if (!config.runner?.tick) {
          return error({ message: "Runner not available", code: "RUNNER_NOT_AVAILABLE" }, 503);
        }

        const result = await config.runner.tick({
          maxRuns: payload.maxRuns,
          maxWebhookEvents: payload.maxWebhookEvents,
        });

        const processedRuns =
          result && typeof result === "object" ? (result.processedRuns ?? 0) : 0;
        const processedWebhookEvents =
          result && typeof result === "object" ? (result.processedWebhookEvents ?? 0) : 0;

        return json({ processedRuns, processedWebhookEvents });
      },
    });

    return [...baseRoutes, runnerTickRoute] as const;
  },
);
