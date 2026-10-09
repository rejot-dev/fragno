import {
  piAgentConfigSchema,
  piAgentCreationSchema,
  piAgentModelSchema,
  piManagerSessionSchema,
  type PiAgentConfig,
} from "@fragno-dev/backoffice-api/v0/pi";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { column, idColumn, schema, type Column } from "@fragno-dev/db/schema";
import { z } from "zod";

import { defineFragment, defineRoutes, instantiate } from "@fragno-dev/core";
import { decodeCursor, withDatabase, type FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import {
  backofficeContextScopesEqual,
  backofficeExecutionScopeRestriction,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeForbiddenError, type BackofficeKernel } from "@/backoffice-runtime/kernel";

import {
  PiConversationViewDamagedError,
  piAgentCompactionSchema,
  piAgentCompactionStatusSchema,
  piAgentEntryPageRequestSchema,
  piAgentPromptSchema,
  piAgentSubmissionWaitRequestSchema,
  piAgentSubmissionWaitSchema,
  piAgentViewStreamFrameSchema,
  piAvailableModelSchema,
  type PiAgent,
  type PiAvailableModel,
} from "./pi-agent-contract";

const SESSION_ORDER_INDEX = "idx_pi_manager_session_created";
const createSessionRequestSchema = piAgentCreationSchema.extend({
  requestId: z.string().trim().min(1).max(256).optional(),
});
// Middleware resolves identity and overwrites provenance before route validation.
const createSessionSchema = piAgentCreationSchema.extend({
  requestId: z.string().trim().min(1).max(256),
  actors: piAgentConfigSchema.shape.actors,
  scopeRestriction: piAgentConfigSchema.shape.scopeRestriction,
});
const provisionSessionSchema = createSessionSchema.extend({ model: piAgentModelSchema });
const sessionSchema = piManagerSessionSchema;

type PiManagerConfig = {
  scope: BackofficeContextScope;
  agent: (config: PiAgentConfig) => PiAgent;
  supportedAvailableModels: () => Promise<readonly PiAvailableModel[]>;
};

type PiManagerRequestContext = {
  execution: BackofficeExecutionContext;
};

/** Only the session directory lives here; transcripts and tasks belong to agent objects. */
const piManagerSchema = schema("pi_manager", (s) =>
  s
    .addTable("session", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("name", column("string").nullable())
        .addColumn(
          "model",
          column("json") as Column<"json", PiAgentConfig["model"], PiAgentConfig["model"]>,
        )
        .addColumn("instructions", column("text"))
        .addColumn("billingOrganizationId", column("string").nullable())
        .addColumn(
          "actors",
          column("json") as Column<"json", PiAgentConfig["actors"], PiAgentConfig["actors"]>,
        )
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex(SESSION_ORDER_INDEX, ["createdAt", "id"]),
    )
    .alterTable("session", (t) =>
      t.addColumn(
        "scopeRestriction",
        (
          column("json") as Column<"json", BackofficeContextScope, BackofficeContextScope>
        ).nullable(),
      ),
    ),
);

/** Execution scope is supplied by the object address, never by a session request body. */
const piManagerDefinition = defineFragment<PiManagerConfig>("pi-manager")
  .extend(withDatabase(piManagerSchema))
  .providesBaseService(({ defineService, config }) =>
    defineService({
      createSession: function (input: z.infer<typeof provisionSessionSchema>) {
        return this.serviceTx(piManagerSchema)
          .retrieve((uow) =>
            uow.findFirst("session", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", input.requestId)),
            ),
          )
          .mutate(({ uow, retrieveResult: [existing] }) => {
            if (existing) {
              return {
                created: false,
                session: {
                  scope: config.scope,
                  sessionId: existing.id.valueOf(),
                  name: existing.name,
                  model: existing.model,
                  instructions: existing.instructions,
                  actors: existing.actors,
                  scopeRestriction: existing.scopeRestriction,
                  billingOrganizationId: existing.billingOrganizationId,
                },
              } as const;
            }

            const { requestId, ...sessionConfig } = input;
            const id = uow.create("session", { id: requestId, ...sessionConfig });
            return {
              created: true,
              session: { scope: config.scope, sessionId: id.valueOf(), ...sessionConfig },
            } as const;
          })
          .build();
      },
      getSession: function (sessionId: string) {
        return this.serviceTx(piManagerSchema)
          .retrieve((uow) =>
            uow.findFirst("session", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", sessionId)),
            ),
          )
          .transformRetrieve(([session]) =>
            session
              ? {
                  scope: config.scope,
                  sessionId: session.id.valueOf(),
                  name: session.name,
                  model: session.model,
                  instructions: session.instructions,
                  actors: session.actors,
                  scopeRestriction: session.scopeRestriction,
                  billingOrganizationId: session.billingOrganizationId,
                  createdAt: session.createdAt.toISOString(),
                }
              : null,
          )
          .build();
      },
    }),
  )
  .build();

/** Minimal directory routes hand off agent operations only after finding an owned session. */
const piManagerRoutes = defineRoutes(piManagerDefinition).create(
  ({ defineRoute, services, config }) => [
    defineRoute({
      method: "GET",
      path: "/models",
      outputSchema: z.array(piAvailableModelSchema),
      handler: async function (_request, { json }) {
        return json([...(await config.supportedAvailableModels())]);
      },
    }),
    defineRoute({
      method: "POST",
      path: "/sessions",
      inputSchema: createSessionSchema,
      outputSchema: piAgentConfigSchema,
      errorCodes: ["MODEL_UNAVAILABLE"],
      handler: async function ({ input }, { json, error }) {
        const values = await input.valid();
        const availableModels = await config.supportedAvailableModels();
        const requestedModel = values.model;
        const model = requestedModel
          ? availableModels.find(
              (candidate) =>
                candidate.provider === requestedModel.provider &&
                candidate.modelId === requestedModel.modelId,
            )
          : (availableModels[0] ?? null);
        if (!model) {
          const message = requestedModel
            ? `Pi model ${requestedModel.provider}/${requestedModel.modelId} is not available.`
            : "No configured Pi model is available.";
          return error({ code: "MODEL_UNAVAILABLE", message }, 400);
        }
        const result = await this.handlerTx()
          .withServiceCalls(() => [
            services.createSession({
              ...values,
              model: { provider: model.provider, modelId: model.modelId },
            }),
          ])
          .transform(({ serviceResult: [result] }) => result)
          .execute();
        // Agent initialization is lazy: directory creation cannot strand an undiscoverable agent.
        return json(result.session, result.created ? 201 : 200);
      },
    }),
    defineRoute({
      method: "GET",
      path: "/sessions",
      queryParameters: ["cursor", "pageSize"],
      outputSchema: z.object({
        sessions: z.array(sessionSchema),
        cursor: z.string().nullable(),
        hasNextPage: z.boolean(),
      }),
      errorCodes: ["INVALID_CURSOR", "INVALID_PAGE_SIZE"],
      handler: async function ({ query }, { json, error }) {
        let cursor;
        try {
          const encoded = query.get("cursor");
          cursor = encoded ? decodeCursor(encoded) : null;
          if (
            cursor &&
            (cursor.indexName !== SESSION_ORDER_INDEX ||
              cursor.orderDirection !== "desc" ||
              cursor.pageSize < 1 ||
              cursor.pageSize > 100 ||
              !z
                .object({ createdAt: z.coerce.date(), id: z.string().min(1) })
                .safeParse(cursor.indexValues).success)
          ) {
            return error({ code: "INVALID_CURSOR", message: "Invalid Pi session cursor." }, 400);
          }
        } catch {
          return error({ code: "INVALID_CURSOR", message: "Invalid Pi session cursor." }, 400);
        }
        const pageSize = z.coerce
          .number()
          .int()
          .min(1)
          .max(100)
          .safeParse(query.get("pageSize") ?? 20);
        if (!pageSize.success) {
          return error(
            {
              code: "INVALID_PAGE_SIZE",
              message: "Pi session page size must be between 1 and 100.",
            },
            400,
          );
        }
        const page = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(piManagerSchema).findWithCursor("session", (b) => {
              const ordered = b
                .whereIndex(SESSION_ORDER_INDEX)
                .orderByIndex(SESSION_ORDER_INDEX, "desc")
                .pageSize(cursor?.pageSize ?? pageSize.data);
              return cursor ? ordered.after(cursor) : ordered;
            }),
          )
          .transformRetrieve(([page]) => page)
          .execute();
        return json({
          sessions: page.items.map((session) => ({
            scope: config.scope,
            sessionId: session.id.valueOf(),
            name: session.name,
            model: session.model,
            instructions: session.instructions,
            actors: session.actors,
            scopeRestriction: session.scopeRestriction,
            billingOrganizationId: session.billingOrganizationId,
            createdAt: session.createdAt.toISOString(),
          })),
          cursor: page.cursor?.encode() ?? null,
          hasNextPage: page.hasNextPage,
        });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/sessions/:sessionId",
      outputSchema: sessionSchema,
      errorCodes: ["SESSION_NOT_FOUND"],
      handler: async function ({ pathParams }, { json, error }) {
        const session = await this.handlerTx()
          .withServiceCalls(() => [services.getSession(pathParams.sessionId)])
          .transform(({ serviceResult: [session] }) => session)
          .execute();
        return session
          ? json(session)
          : error({ code: "SESSION_NOT_FOUND", message: "Pi session was not found." }, 404);
      },
    }),
    defineRoute({
      method: "POST",
      path: "/sessions/:sessionId/prompts",
      inputSchema: piAgentPromptSchema,
      outputSchema: z.object({ submissionId: z.number(), requestId: z.string() }),
      errorCodes: ["SESSION_NOT_FOUND"],
      handler: async function ({ pathParams, input }, { json, error }) {
        const prompt = await input.valid();
        const session = await this.handlerTx()
          .withServiceCalls(() => [services.getSession(pathParams.sessionId)])
          .transform(({ serviceResult: [session] }) => session)
          .execute();
        if (!session) {
          return error({ code: "SESSION_NOT_FOUND", message: "Pi session was not found." }, 404);
        }
        return json(await config.agent(session).submit(session, prompt), 202);
      },
    }),
    defineRoute({
      method: "GET",
      path: "/sessions/:sessionId/view",
      // Pi owns this experimental structural view; the manager deliberately keeps it opaque.
      outputSchema: z.unknown(),
      errorCodes: ["SESSION_NOT_FOUND", PiConversationViewDamagedError.code],
      handler: async function ({ pathParams }, { json, error }) {
        const session = await this.handlerTx()
          .withServiceCalls(() => [services.getSession(pathParams.sessionId)])
          .transform(({ serviceResult: [session] }) => session)
          .execute();
        if (!session) {
          return error({ code: "SESSION_NOT_FOUND", message: "Pi session was not found." }, 404);
        }
        try {
          return json(await config.agent(session).getView(session));
        } catch (cause) {
          if (PiConversationViewDamagedError.is(cause)) {
            return error(
              {
                code: PiConversationViewDamagedError.code,
                message: PiConversationViewDamagedError.publicMessage,
              },
              409,
            );
          }
          throw cause;
        }
      },
    }),
    defineRoute({
      method: "GET",
      path: "/sessions/:sessionId/view-stream",
      outputSchema: z.array(piAgentViewStreamFrameSchema),
      errorCodes: ["SESSION_NOT_FOUND", PiConversationViewDamagedError.code],
      handler: async function ({ pathParams }, { error }) {
        const session = await this.handlerTx()
          .withServiceCalls(() => [services.getSession(pathParams.sessionId)])
          .transform(({ serviceResult: [session] }) => session)
          .execute();
        if (!session) {
          return error({ code: "SESSION_NOT_FOUND", message: "Pi session was not found." }, 404);
        }
        try {
          return new Response(await config.agent(session).watchView(session), {
            headers: {
              "cache-control": "no-cache",
              "content-type": "application/x-ndjson; charset=utf-8",
              "x-content-type-options": "nosniff",
            },
          });
        } catch (cause) {
          if (PiConversationViewDamagedError.is(cause)) {
            return error(
              {
                code: PiConversationViewDamagedError.code,
                message: PiConversationViewDamagedError.publicMessage,
              },
              409,
            );
          }
          throw cause;
        }
      },
    }),
    defineRoute({
      method: "GET",
      path: "/sessions/:sessionId/entries",
      queryParameters: ["cursor", "pageSize"],
      outputSchema: z.object({
        entries: z.array(z.unknown()),
        cursor: z.string().nullable(),
        hasNextPage: z.boolean(),
      }),
      errorCodes: ["SESSION_NOT_FOUND", "INVALID_CURSOR", "INVALID_PAGE_SIZE"],
      handler: async function ({ pathParams, query }, { json, error }) {
        const pageSize = z.coerce
          .number()
          .int()
          .min(1)
          .max(256)
          .safeParse(query.get("pageSize") ?? 100);
        if (!pageSize.success) {
          return error(
            {
              code: "INVALID_PAGE_SIZE",
              message: "Pi entry page size must be between 1 and 256.",
            },
            400,
          );
        }
        let cursor: z.infer<typeof piAgentEntryPageRequestSchema>["cursor"] = null;
        const encodedCursor = query.get("cursor");
        if (encodedCursor) {
          try {
            cursor = piAgentEntryPageRequestSchema.shape.cursor.parse(
              JSON.parse(encodedCursor) as unknown,
            );
          } catch {
            return error({ code: "INVALID_CURSOR", message: "Invalid Pi entry cursor." }, 400);
          }
        }
        const session = await this.handlerTx()
          .withServiceCalls(() => [services.getSession(pathParams.sessionId)])
          .transform(({ serviceResult: [session] }) => session)
          .execute();
        if (!session) {
          return error({ code: "SESSION_NOT_FOUND", message: "Pi session was not found." }, 404);
        }
        const page = await config.agent(session).listEntries(session, {
          pageSize: pageSize.data,
          cursor,
        });
        return json({
          entries: [...page.entries],
          cursor: page.cursor === null ? null : JSON.stringify(page.cursor),
          hasNextPage: page.cursor !== null,
        });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/sessions/:sessionId/export",
      errorCodes: ["SESSION_NOT_FOUND"],
      handler: async function ({ pathParams }, { error }) {
        const session = await this.handlerTx()
          .withServiceCalls(() => [services.getSession(pathParams.sessionId)])
          .transform(({ serviceResult: [session] }) => session)
          .execute();
        if (!session) {
          return error({ code: "SESSION_NOT_FOUND", message: "Pi session was not found." }, 404);
        }
        const filenameSessionId = session.sessionId.replaceAll(/[^a-zA-Z0-9._-]/g, "-");
        return new Response(await config.agent(session).exportEntries(session), {
          headers: {
            "cache-control": "no-store",
            "content-disposition": `attachment; filename="pi-session-${filenameSessionId}.jsonl"`,
            "content-type": "application/x-ndjson; charset=utf-8",
            "x-content-type-options": "nosniff",
          },
        });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/sessions/:sessionId/compact",
      inputSchema: piAgentCompactionSchema,
      outputSchema: z.object({ taskId: z.number().int().positive() }),
      errorCodes: ["SESSION_NOT_FOUND"],
      handler: async function ({ pathParams, input }, { json, error }) {
        const request = await input.valid();
        const session = await this.handlerTx()
          .withServiceCalls(() => [services.getSession(pathParams.sessionId)])
          .transform(({ serviceResult: [session] }) => session)
          .execute();
        if (!session) {
          return error({ code: "SESSION_NOT_FOUND", message: "Pi session was not found." }, 404);
        }
        return json(await config.agent(session).compact(session, request), 202);
      },
    }),
    defineRoute({
      method: "GET",
      path: "/sessions/:sessionId/compactions/:taskId",
      outputSchema: piAgentCompactionStatusSchema,
      errorCodes: ["SESSION_NOT_FOUND", "COMPACTION_NOT_FOUND"],
      handler: async function ({ pathParams }, { json, error }) {
        const session = await this.handlerTx()
          .withServiceCalls(() => [services.getSession(pathParams.sessionId)])
          .transform(({ serviceResult: [session] }) => session)
          .execute();
        if (!session) {
          return error({ code: "SESSION_NOT_FOUND", message: "Pi session was not found." }, 404);
        }
        const taskId = z.coerce.number().int().positive().safeParse(pathParams.taskId);
        const compaction = taskId.success
          ? await config.agent(session).getCompaction(session, taskId.data)
          : null;
        return compaction
          ? json(compaction)
          : error({ code: "COMPACTION_NOT_FOUND", message: "Pi compaction was not found." }, 404);
      },
    }),
    defineRoute({
      method: "GET",
      path: "/sessions/:sessionId/submissions/:requestId/wait",
      queryParameters: ["waitMs"],
      outputSchema: piAgentSubmissionWaitSchema,
      errorCodes: ["SESSION_NOT_FOUND", "SUBMISSION_NOT_FOUND", "INVALID_WAIT_DURATION"],
      handler: async function ({ pathParams, query }, { json, error }) {
        const wait = piAgentSubmissionWaitRequestSchema.safeParse({
          waitMs: Number(query.get("waitMs")),
        });
        if (!wait.success) {
          return error(
            {
              code: "INVALID_WAIT_DURATION",
              message: "Pi submission wait duration is invalid.",
            },
            400,
          );
        }
        const session = await this.handlerTx()
          .withServiceCalls(() => [services.getSession(pathParams.sessionId)])
          .transform(({ serviceResult: [session] }) => session)
          .execute();
        if (!session) {
          return error({ code: "SESSION_NOT_FOUND", message: "Pi session was not found." }, 404);
        }
        const result = await config
          .agent(session)
          .waitForSubmission(session, pathParams.requestId, wait.data);
        return result
          ? json(result)
          : error({ code: "SUBMISSION_NOT_FOUND", message: "Pi submission was not found." }, 404);
      },
    }),
    defineRoute({
      method: "GET",
      path: "/sessions/:sessionId/submissions/:requestId",
      outputSchema: z.unknown(),
      errorCodes: ["SESSION_NOT_FOUND", "SUBMISSION_NOT_FOUND"],
      handler: async function ({ pathParams }, { json, error }) {
        const session = await this.handlerTx()
          .withServiceCalls(() => [services.getSession(pathParams.sessionId)])
          .transform(({ serviceResult: [session] }) => session)
          .execute();
        if (!session) {
          return error({ code: "SESSION_NOT_FOUND", message: "Pi session was not found." }, 404);
        }
        const submission = await config.agent(session).getSubmission(session, pathParams.requestId);
        return submission
          ? json(submission)
          : error({ code: "SUBMISSION_NOT_FOUND", message: "Pi submission was not found." }, 404);
      },
    }),
    defineRoute({
      method: "POST",
      path: "/sessions/:sessionId/abort",
      errorCodes: ["SESSION_NOT_FOUND"],
      handler: async function ({ pathParams }, { empty, error }) {
        const session = await this.handlerTx()
          .withServiceCalls(() => [services.getSession(pathParams.sessionId)])
          .transform(({ serviceResult: [session] }) => session)
          .execute();
        if (!session) {
          return error({ code: "SESSION_NOT_FOUND", message: "Pi session was not found." }, 404);
        }
        await config.agent(session).abort(session);
        return empty(204);
      },
    }),
  ],
);

/** Authorizes every scoped directory request with trusted execution context and Pi permissions. */
export function createPiManagerFragment(
  config: PiManagerConfig,
  options: FragnoPublicConfigWithDatabase,
  kernel: BackofficeKernel,
) {
  return instantiate(piManagerDefinition)
    .withConfig(config)
    .withRoutes([piManagerRoutes])
    .withRequestContext<PiManagerRequestContext>()
    .withOptions(options)
    .build()
    .withMiddleware(async function authorizePiManager(
      { requestContext, method, ifMatchesRoute, requestState },
      { error },
    ) {
      if (
        !requestContext ||
        !backofficeContextScopesEqual(requestContext.execution.scope, config.scope)
      ) {
        return error(
          {
            code: "context-access-denied",
            message: "Pi manager requires matching scope action context.",
          },
          403,
        );
      }
      try {
        await kernel.assertAuthorized({
          execution: requestContext.execution,
          operation:
            method === "GET" ? BACKOFFICE_PERMISSION.pi.read : BACKOFFICE_PERMISSION.pi.modify,
          resource: { kind: "pi-session-directory", scope: config.scope },
        });
      } catch (cause) {
        if (cause instanceof BackofficeForbiddenError) {
          return error(
            { code: cause.reason, message: cause.message },
            cause.reason === "authority-unavailable" ? 503 : 403,
          );
        }
        throw cause;
      }
      return await ifMatchesRoute("POST", "/sessions", async () => {
        const parsed = createSessionRequestSchema.safeParse(requestState.body);
        if (!parsed.success) {
          return error({ code: "INVALID_SESSION", message: parsed.error.message }, 400);
        }
        const values = parsed.data;
        const billingOrganizationId =
          config.scope.kind === "org" || config.scope.kind === "project"
            ? config.scope.orgId
            : values.billingOrganizationId;
        if (config.scope.kind === "user" && billingOrganizationId === null) {
          return error(
            {
              code: "PI_BILLING_OWNER_REQUIRED",
              message: "User-scoped Pi sessions require a billing organization.",
            },
            400,
          );
        }
        if (
          billingOrganizationId !== null &&
          (config.scope.kind === "user" || config.scope.kind === "system")
        ) {
          try {
            await kernel.assertAuthorized({
              execution: {
                ...requestContext.execution,
                scope: { kind: "org", orgId: billingOrganizationId },
              },
              operation: BACKOFFICE_PERMISSION.pi.modify,
              resource: { kind: "pi-session-billing" },
            });
          } catch (cause) {
            if (cause instanceof BackofficeForbiddenError) {
              return error(
                { code: cause.reason, message: cause.message },
                cause.reason === "authority-unavailable" ? 503 : 403,
              );
            }
            throw cause;
          }
        }
        requestState.setBody({
          ...values,
          requestId: values.requestId ?? crypto.randomUUID(),
          billingOrganizationId,
          actors: requestContext.execution.actors,
          scopeRestriction: backofficeExecutionScopeRestriction(requestContext.execution),
        });
        return undefined;
      });
    });
}
