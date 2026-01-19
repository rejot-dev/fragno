import { defineRoutes } from "@fragno-dev/core";
import { decodeCursor } from "@fragno-dev/db";
import type { FragnoId } from "@fragno-dev/db/schema";
import OpenAI from "openai";
import { z } from "zod";
import { aiFragmentDefinition } from "./definition";
import { aiSchema } from "./schema";

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

const createRunSchema = z.object({
  type: z.string().optional(),
  executionMode: z.string().optional(),
  inputMessageId: z.string().optional(),
  modelId: z.string().optional(),
  thinkingLevel: z.string().optional(),
  systemPrompt: z.string().optional().nullable(),
});

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

  throw err;
};

const resolveMessageText = (message: { text: string | null; content: unknown }) => {
  if (message.text) {
    return message.text;
  }

  if (typeof message.content === "string") {
    return message.content;
  }

  if (message.content && typeof message.content === "object" && "text" in message.content) {
    const text = (message.content as { text?: unknown }).text;
    if (typeof text === "string") {
      return text;
    }
  }

  return null;
};

const resolveOpenAIApiKey = async (config: {
  apiKey?: string;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
}) => {
  return (
    config.apiKey ??
    (typeof config.getApiKey === "function" ? await config.getApiKey("openai") : undefined)
  );
};

const createOpenAIClient = async (config: {
  apiKey?: string;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  baseUrl?: string;
  defaultModel?: { baseUrl?: string; headers?: Record<string, string> };
}) => {
  const apiKey = await resolveOpenAIApiKey(config);

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY_MISSING");
  }

  const baseURL = config.baseUrl ?? config.defaultModel?.baseUrl;
  const defaultHeaders = config.defaultModel?.headers;

  return new OpenAI({ apiKey, baseURL, defaultHeaders });
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
    return [
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
        errorCodes: ["THREAD_NOT_FOUND"],
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
                  executionMode: payload.executionMode,
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
        inputSchema: createRunSchema,
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
                  type: payload.type,
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

          const messageHistory = await this.handlerTx()
            .withServiceCalls(() => [
              services.listMessages({
                threadId: pathParams.threadId,
                order: "asc",
                pageSize: 100,
              }),
            ])
            .transform(({ serviceResult: [value] }) => value)
            .execute();

          const openaiInput: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];

          if (run.systemPrompt) {
            openaiInput.push({ role: "system", content: run.systemPrompt });
          }

          for (const message of messageHistory.messages) {
            if (message.role !== "user" && message.role !== "assistant") {
              continue;
            }

            const text = resolveMessageText(message);
            if (!text) {
              continue;
            }

            openaiInput.push({ role: message.role as "user" | "assistant", content: text });
          }

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
            let finalStatus: "succeeded" | "failed" = "succeeded";
            let errorMessage: string | null = null;
            let textBuffer = "";

            await stream.write({ type: "run.meta", runId: run.id, threadId: run.threadId });
            await stream.write({ type: "run.status", runId: run.id, status: "running" });

            try {
              const responseStream = await openaiClient.responses.create({
                model: run.modelId,
                input: openaiInput,
                stream: true,
              });

              for await (const event of responseStream) {
                if (event.type === "response.output_text.delta") {
                  textBuffer += event.delta;
                  await stream.write({
                    type: "output.text.delta",
                    runId: run.id,
                    delta: event.delta,
                  });
                } else if (event.type === "response.output_text.done") {
                  textBuffer = event.text;
                  await stream.write({
                    type: "output.text.done",
                    runId: run.id,
                    text: event.text,
                  });
                }
              }
            } catch (err) {
              finalStatus = "failed";
              errorMessage = err instanceof Error ? err.message : "OpenAI request failed";
            }

            const completedAt = new Date();
            const assistantText = textBuffer || null;
            const finalRun = {
              ...run,
              status: finalStatus,
              error: errorMessage,
              updatedAt: completedAt,
              completedAt,
            };

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
                        updatedAt: completedAt,
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
                      createdAt: completedAt,
                    });
                  }
                })
                .execute();
            } catch (err) {
              if (!errorMessage) {
                finalStatus = "failed";
                errorMessage = err instanceof Error ? err.message : "Failed to finalize run";
              }
            }

            try {
              await stream.write({
                type: "run.final",
                runId: run.id,
                status: finalStatus,
                run: { ...finalRun, status: finalStatus, error: errorMessage },
              });
            } catch {
              // Ignore stream errors if the client disconnected.
            }
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
        errorCodes: ["WEBHOOK_NOT_CONFIGURED", "INVALID_SIGNATURE", "VALIDATION_ERROR"],
        handler: async function ({ headers, rawBody }, { json, error }) {
          if (!config.webhookSecret) {
            return error(
              { message: "OpenAI webhook secret not configured", code: "WEBHOOK_NOT_CONFIGURED" },
              400,
            );
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

          await this.handlerTx()
            .withServiceCalls(() => [
              services.recordOpenAIWebhookEvent({
                openaiEventId: parsed.openaiEventId,
                type: parsed.type,
                responseId: parsed.responseId,
                payload: event,
              }),
            ])
            .execute();

          return json({ ok: true });
        },
      }),
    ];
  },
);
