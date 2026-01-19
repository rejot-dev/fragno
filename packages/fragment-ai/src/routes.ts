import { defineRoutes } from "@fragno-dev/core";
import { decodeCursor } from "@fragno-dev/db";
import { z } from "zod";
import { aiFragmentDefinition } from "./definition";

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

const webhookEventSchema = z.object({
  id: z.string(),
  openaiEventId: z.string(),
  type: z.string(),
  responseId: z.string(),
  payload: z.unknown(),
  receivedAt: z.date(),
  processedAt: z.date().nullable(),
  processingError: z.string().nullable(),
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

const listEventsQuerySchema = listQuerySchema;

const webhookInputSchema = z.object({
  openaiEventId: z.string(),
  type: z.string(),
  responseId: z.string(),
  payload: z.unknown(),
});

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

export const aiRoutesFactory = defineRoutes(aiFragmentDefinition).create(
  ({ defineRoute, services }) => {
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
        inputSchema: webhookInputSchema,
        outputSchema: z.object({
          event: webhookEventSchema,
          created: z.boolean(),
        }),
        handler: async function ({ input }, { json }) {
          const payload = await input.valid();

          const result = await this.handlerTx()
            .withServiceCalls(() => [services.recordOpenAIWebhookEvent(payload)])
            .transform(({ serviceResult: [value] }) => value)
            .execute();

          return json(result);
        },
      }),
    ];
  },
);
