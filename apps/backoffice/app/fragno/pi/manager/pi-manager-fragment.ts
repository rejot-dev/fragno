import type { AutomationRouteManagedBy } from "@fragno-dev/backoffice-api/v0/automation";
import {
  piAgentDefinitionCreateSchema,
  piAgentDefinitionSchema,
  piAgentDefinitionUpdateSchema,
  piBillingOrganizationIdSchema,
  piManagerAgentDirectorySchema,
  piManagerAgentSchema,
  piPromptReceiptOutputSchema,
  piPromptWhenBusySchema,
  type PiAgentConfig,
  type PiAgentDefinition,
  type PiAgentDefinitionCreate,
} from "@fragno-dev/backoffice-api/v0/pi";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import {
  type BackofficeContextScope,
  backofficeContextScopesEqual,
  backofficeScopeOrganization,
  backofficeScopeRootOwner,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { column, idColumn, schema, type Column } from "@fragno-dev/db/schema";
import { z } from "zod";

import { defineFragment, defineRoutes, instantiate } from "@fragno-dev/core";
import { withDatabase, type FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import {
  backofficeExecutionScopeRestriction,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeForbiddenError, type BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  BUILT_IN_PI_AGENT_DEFINITIONS,
  builtInPiAgentDefinition,
  expandPiAgentPermissions,
  resolvePiAgentModel,
} from "@/fragno/pi/agent/agent-definitions";
import {
  PiConversationViewDamagedError,
  piAgentCompactionSchema,
  piAgentCompactionStatusSchema,
  piAgentEntryPageRequestSchema,
  piAgentNotificationSchema,
  piAgentPromptSchema,
  piAgentSubmissionWaitRequestSchema,
  piAgentSubmissionWaitSchema,
  piAgentTurnSchema,
  piAgentViewStreamFrameSchema,
  piAvailableModelSchema,
  type PiAgent,
  type PiAgentTurn,
  type PiAvailableModel,
} from "@/fragno/pi/agent/pi-agent-contract";

// Middleware resolves identity and overwrites provenance before route validation.
const turnProvenanceSchema = piAgentTurnSchema.pick({ actors: true, scopeRestriction: true });
const promptRequestSchema = z.object({
  requestId: z.string().trim().min(1).max(256).optional(),
  content: piAgentPromptSchema.shape.content,
  whenBusy: piPromptWhenBusySchema.default("followUp"),
  billingOrganizationId: piBillingOrganizationIdSchema.default(null),
});
const promptSchema = piAgentPromptSchema.extend({
  billingOrganizationId: piBillingOrganizationIdSchema,
  provenance: turnProvenanceSchema,
});
const compactionSchema = piAgentCompactionSchema.extend({ provenance: turnProvenanceSchema });
const notificationSchema = z.lazy(() =>
  piAgentNotificationSchema._zod.innerType.extend({ provenance: turnProvenanceSchema }),
);

type PiManagerConfig = {
  scope: BackofficeContextScope;
  agent: (config: PiAgentConfig) => PiAgent;
  supportedAvailableModels: () => Promise<readonly PiAvailableModel[]>;
};

type PiManagerRequestContext = {
  execution: BackofficeExecutionContext;
};

const jsonColumn = <T>() => column("json") as Column<"json", T, T>;

/**
 * A scope's agent definitions, keyed by agent name, and the agents that have been provisioned. A
 * provisioning outlives its definition, so a deleted agent's conversation resumes if it returns.
 */
const piAgentDirectorySchema = schema("pi_manager", (s) =>
  s
    .noOp("removed obsolete session addTable history")
    .noOp("removed obsolete session scopeRestriction alterTable history")
    .addTable("agent", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("billingOrganizationId", column("string").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        ),
    )
    .addTable("agent_definition", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("description", column("text"))
        .addColumn("model", column("string").nullable())
        .addColumn("permissions", jsonColumn<string[]>())
        .addColumn("instructions", column("text"))
        .addColumn("managedBy", jsonColumn<AutomationRouteManagedBy>().nullable()),
    ),
);

type AgentDefinitionRow = {
  id: { valueOf(): string };
  description: string;
  model: string | null;
  permissions: string[];
  instructions: string;
  managedBy: AutomationRouteManagedBy | null;
};

function definitionFromRow(row: AgentDefinitionRow): PiAgentDefinition {
  return {
    agentName: row.id.valueOf(),
    description: row.description,
    model: row.model,
    permissions: row.permissions,
    instructions: row.instructions,
    managedBy: row.managedBy,
  };
}

type AgentProvisioning =
  | { type: "provisioned"; config: PiAgentConfig }
  | { type: "billing-owner-required" };

/** Execution scope is supplied by the object address, never by a request body. */
const piManagerDefinition = defineFragment<PiManagerConfig>("pi-manager")
  .extend(withDatabase(piAgentDirectorySchema))
  .providesBaseService(({ defineService, config }) =>
    defineService({
      /** A user-scoped agent's first turn chooses its billing owner; later turns reuse it. */
      provisionAgent: function (input: {
        agentName: string;
        billingOrganizationId: string | null;
      }) {
        return this.serviceTx(piAgentDirectorySchema)
          .retrieve((uow) =>
            uow.findFirst("agent", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", input.agentName)),
            ),
          )
          .mutate(({ uow, retrieveResult: [existing] }): AgentProvisioning => {
            if (existing) {
              return {
                type: "provisioned",
                config: {
                  scope: config.scope,
                  agentName: input.agentName,
                  billingOrganizationId: existing.billingOrganizationId,
                },
              };
            }
            // Work a user answers for has no organization to bill unless the user picks one.
            if (
              backofficeScopeRootOwner(config.scope)?.kind === "user" &&
              input.billingOrganizationId === null
            ) {
              return { type: "billing-owner-required" };
            }
            uow.create("agent", {
              id: input.agentName,
              billingOrganizationId: input.billingOrganizationId,
            });
            return {
              type: "provisioned",
              config: {
                scope: config.scope,
                agentName: input.agentName,
                billingOrganizationId: input.billingOrganizationId,
              },
            };
          })
          .build();
      },
      /** Built-in definitions shadow nothing: their names cannot be defined in a scope. */
      getAgent: function (agentName: string) {
        return this.serviceTx(piAgentDirectorySchema)
          .retrieve((uow) =>
            uow
              .findFirst("agent_definition", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", agentName)),
              )
              .findFirst("agent", (b) => b.whereIndex("primary", (eb) => eb("id", "=", agentName))),
          )
          .transformRetrieve(([definition, agent]) => ({
            definition:
              builtInPiAgentDefinition(agentName) ??
              (definition ? definitionFromRow(definition) : null),
            config: agent
              ? {
                  scope: config.scope,
                  agentName,
                  billingOrganizationId: agent.billingOrganizationId,
                }
              : null,
          }))
          .build();
      },
      listAgents: function () {
        return this.serviceTx(piAgentDirectorySchema)
          .retrieve((uow) =>
            uow
              .find("agent_definition", (b) => b.whereIndex("primary"))
              .find("agent", (b) => b.whereIndex("primary")),
          )
          .transformRetrieve(([definitions, agents]) => {
            const provisioned = new Map(
              agents.map((agent) => [agent.id.valueOf(), agent.billingOrganizationId]),
            );
            return [...BUILT_IN_PI_AGENT_DEFINITIONS, ...definitions.map(definitionFromRow)]
              .sort((left, right) => left.agentName.localeCompare(right.agentName))
              .map((definition) => ({
                ...definition,
                provisioning: provisioned.has(definition.agentName)
                  ? { billingOrganizationId: provisioned.get(definition.agentName) ?? null }
                  : null,
              }));
          })
          .build();
      },
      /** Null when the name is taken. */
      createAgentDefinition: function (definition: PiAgentDefinitionCreate) {
        return this.serviceTx(piAgentDirectorySchema)
          .retrieve((uow) =>
            uow.findFirst("agent_definition", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", definition.agentName)),
            ),
          )
          .mutate(({ uow, retrieveResult: [existing] }): PiAgentDefinition | null => {
            if (existing) {
              return null;
            }
            const { agentName, ...fields } = definition;
            uow.create("agent_definition", { id: agentName, ...fields });
            return definition;
          })
          .build();
      },
      /** Null when no definition has the name. */
      replaceAgentDefinition: function (definition: PiAgentDefinitionCreate) {
        return this.serviceTx(piAgentDirectorySchema)
          .retrieve((uow) =>
            uow.findFirst("agent_definition", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", definition.agentName)),
            ),
          )
          .mutate(({ uow, retrieveResult: [existing] }): PiAgentDefinition | null => {
            if (!existing) {
              return null;
            }
            const { agentName: _agentName, ...fields } = definition;
            uow.update("agent_definition", existing.id, (b) => b.set(fields).check());
            return definition;
          })
          .build();
      },
      deleteAgentDefinition: function (agentName: string) {
        return this.serviceTx(piAgentDirectorySchema)
          .retrieve((uow) =>
            uow.findFirst("agent_definition", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", agentName)),
            ),
          )
          .mutate(({ uow, retrieveResult: [existing] }) => {
            if (existing) {
              uow.delete("agent_definition", existing.id, (b) => b.check());
            }
          })
          .build();
      },
      getAgents: function (agentNames: readonly string[]) {
        return this.serviceTx(piAgentDirectorySchema)
          .retrieve((uow) =>
            uow.find("agent", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "in", [...agentNames])),
            ),
          )
          .transformRetrieve(
            ([agents]) =>
              new Map(
                agents.map((agent): [string, PiAgentConfig] => [
                  agent.id.valueOf(),
                  {
                    scope: config.scope,
                    agentName: agent.id.valueOf(),
                    billingOrganizationId: agent.billingOrganizationId,
                  },
                ]),
              ),
          )
          .build();
      },
    }),
  )
  .build();

function damagedViewResponse<T>(
  cause: unknown,
  error: (body: { code: string; message: string }, status: 409) => T,
): T {
  if (!PiConversationViewDamagedError.is(cause)) {
    throw cause;
  }
  return error(
    {
      code: PiConversationViewDamagedError.code,
      message: PiConversationViewDamagedError.publicMessage,
    },
    409,
  );
}

function builtInResponse<T>(
  agentName: string,
  error: (body: { code: "AGENT_BUILT_IN"; message: string }, status: 409) => T,
): T {
  return error(
    { code: "AGENT_BUILT_IN", message: `Pi agent '${agentName}' is built in and cannot change.` },
    409,
  );
}

/** Agent routes hand off to an agent object only after finding its provisioned directory record. */
const piManagerRoutes = defineRoutes(piManagerDefinition).create(
  ({ defineRoute, services, config }) => {
    // A turn runs with its agent's definition as it is when the turn is admitted.
    async function admitTurn(
      definition: PiAgentDefinition | null,
      agentName: string,
      provenance: z.infer<typeof turnProvenanceSchema>,
    ): Promise<
      | { type: "turn"; turn: PiAgentTurn }
      | {
          type: "error";
          status: 400 | 404;
          code: "AGENT_NOT_FOUND" | "MODEL_UNAVAILABLE";
          message: string;
        }
    > {
      if (!definition) {
        return {
          type: "error",
          status: 404,
          code: "AGENT_NOT_FOUND",
          message: `Pi agent '${agentName}' is not defined.`,
        };
      }
      const model = resolvePiAgentModel(definition, await config.supportedAvailableModels());
      if (!model) {
        return {
          type: "error",
          status: 400,
          code: "MODEL_UNAVAILABLE",
          message: definition.model
            ? `Pi model ${definition.model} is not available.`
            : "No configured Pi model is available.",
        };
      }
      return {
        type: "turn",
        turn: {
          ...provenance,
          agent: {
            model: { provider: model.provider, modelId: model.modelId },
            instructions: definition.instructions,
            permissions: expandPiAgentPermissions(definition.permissions),
          },
        },
      };
    }

    return [
      defineRoute({
        method: "GET",
        path: "/models",
        outputSchema: z.array(piAvailableModelSchema),
        handler: async function (_request, { json }) {
          return json([...(await config.supportedAvailableModels())]);
        },
      }),
      defineRoute({
        method: "GET",
        path: "/agents",
        outputSchema: piManagerAgentDirectorySchema,
        handler: async function (_request, { json }) {
          const agents = await this.handlerTx()
            .withServiceCalls(() => [services.listAgents()])
            .transform(({ serviceResult: [agents] }) => agents)
            .execute();
          return json({ agents });
        },
      }),
      defineRoute({
        method: "POST",
        path: "/agents",
        inputSchema: piAgentDefinitionCreateSchema,
        outputSchema: piAgentDefinitionSchema,
        errorCodes: ["AGENT_EXISTS"],
        handler: async function ({ input }, { json, error }) {
          const definition = await input.valid();
          const conflict = error(
            { code: "AGENT_EXISTS", message: `Pi agent '${definition.agentName}' already exists.` },
            409,
          );
          if (builtInPiAgentDefinition(definition.agentName)) {
            return conflict;
          }
          const created = await this.handlerTx()
            .withServiceCalls(() => [services.createAgentDefinition(definition)])
            .transform(({ serviceResult: [created] }) => created)
            .execute();
          return created ? json(created, 201) : conflict;
        },
      }),
      defineRoute({
        method: "GET",
        path: "/agents/:agentName",
        outputSchema: piManagerAgentSchema,
        errorCodes: ["AGENT_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          const { definition, config: agent } = await this.handlerTx()
            .withServiceCalls(() => [services.getAgent(pathParams.agentName)])
            .transform(({ serviceResult: [agent] }) => agent)
            .execute();
          if (!definition) {
            return error({ code: "AGENT_NOT_FOUND", message: "Pi agent is not defined." }, 404);
          }
          return json({
            ...definition,
            provisioning: agent ? { billingOrganizationId: agent.billingOrganizationId } : null,
          });
        },
      }),
      defineRoute({
        method: "PUT",
        path: "/agents/:agentName",
        inputSchema: piAgentDefinitionUpdateSchema,
        outputSchema: piAgentDefinitionSchema,
        errorCodes: ["AGENT_NOT_FOUND", "AGENT_BUILT_IN"],
        handler: async function ({ pathParams, input }, { json, error }) {
          const { agentName } = pathParams;
          if (builtInPiAgentDefinition(agentName)) {
            return builtInResponse(agentName, error);
          }
          const definition = { agentName, ...(await input.valid()) };
          const replaced = await this.handlerTx()
            .withServiceCalls(() => [services.replaceAgentDefinition(definition)])
            .transform(({ serviceResult: [replaced] }) => replaced)
            .execute();
          return replaced
            ? json(replaced)
            : error({ code: "AGENT_NOT_FOUND", message: "Pi agent is not defined." }, 404);
        },
      }),
      defineRoute({
        method: "DELETE",
        path: "/agents/:agentName",
        errorCodes: ["AGENT_BUILT_IN"],
        handler: async function ({ pathParams }, { empty, error }) {
          if (builtInPiAgentDefinition(pathParams.agentName)) {
            return builtInResponse(pathParams.agentName, error);
          }
          await this.handlerTx()
            .withServiceCalls(() => [services.deleteAgentDefinition(pathParams.agentName)])
            .execute();
          return empty(204);
        },
      }),
      defineRoute({
        method: "POST",
        path: "/agents/:agentName/prompts",
        inputSchema: promptSchema,
        outputSchema: piPromptReceiptOutputSchema,
        errorCodes: [
          "AGENT_NOT_FOUND",
          "MODEL_UNAVAILABLE",
          "PI_BILLING_OWNER_REQUIRED",
          "AGENT_BUSY",
        ],
        handler: async function ({ pathParams, input }, { json, error }) {
          const { provenance, billingOrganizationId, ...prompt } = await input.valid();
          const { definition } = await this.handlerTx()
            .withServiceCalls(() => [services.getAgent(pathParams.agentName)])
            .transform(({ serviceResult: [agent] }) => agent)
            .execute();
          const admitted = await admitTurn(definition, pathParams.agentName, provenance);
          if (admitted.type === "error") {
            return error({ code: admitted.code, message: admitted.message }, admitted.status);
          }
          const provisioning = await this.handlerTx()
            .withServiceCalls(() => [
              services.provisionAgent({ agentName: pathParams.agentName, billingOrganizationId }),
            ])
            .transform(({ serviceResult: [result] }) => result)
            .execute();
          if (provisioning.type === "billing-owner-required") {
            return error(
              {
                code: "PI_BILLING_OWNER_REQUIRED",
                message: "A user-scoped Pi agent's first turn requires a billing organization.",
              },
              400,
            );
          }
          const { config: agentConfig } = provisioning;
          const submitted = await config
            .agent(agentConfig)
            .submit(agentConfig, admitted.turn, prompt);
          if (submitted.type === "busy") {
            return error(
              {
                code: "AGENT_BUSY",
                message: `Agent "${pathParams.agentName}" is running a turn; the prompt was not queued.`,
              },
              409,
            );
          }
          return json(
            {
              submissionId: submitted.submissionId,
              requestId: submitted.requestId,
              whenBusy: submitted.whenBusy,
            },
            202,
          );
        },
      }),
      defineRoute({
        method: "POST",
        path: "/agents/:agentName/notifications",
        inputSchema: notificationSchema,
        errorCodes: ["AGENT_NOT_STARTED", "AGENT_NOT_FOUND", "MODEL_UNAVAILABLE"],
        handler: async function ({ pathParams, input }, { empty, error }) {
          const { provenance, ...notification } = await input.valid();
          const { definition, config: agentConfig } = await this.handlerTx()
            .withServiceCalls(() => [services.getAgent(pathParams.agentName)])
            .transform(({ serviceResult: [agent] }) => agent)
            .execute();
          // A notification never starts an agent: a personal agent has no billing owner to pick.
          if (!agentConfig) {
            return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
          }
          const admitted = await admitTurn(definition, pathParams.agentName, provenance);
          if (admitted.type === "error") {
            return error({ code: admitted.code, message: admitted.message }, admitted.status);
          }
          await config.agent(agentConfig).notify(agentConfig, admitted.turn, notification);
          return empty(204);
        },
      }),
      defineRoute({
        method: "GET",
        path: "/agents/:agentName/view",
        // Pi owns this experimental structural view; the manager deliberately keeps it opaque.
        outputSchema: z.unknown(),
        errorCodes: ["AGENT_NOT_STARTED", PiConversationViewDamagedError.code],
        handler: async function ({ pathParams }, { json, error }) {
          const agent = await this.handlerTx()
            .withServiceCalls(() => [services.getAgents([pathParams.agentName])])
            .transform(({ serviceResult: [agents] }) => agents.get(pathParams.agentName))
            .execute();
          if (!agent) {
            return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
          }
          try {
            return json(await config.agent(agent).getView(agent));
          } catch (cause) {
            return damagedViewResponse(cause, error);
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/agents/:agentName/view-stream",
        outputSchema: z.array(piAgentViewStreamFrameSchema),
        errorCodes: ["AGENT_NOT_STARTED", PiConversationViewDamagedError.code],
        handler: async function ({ pathParams }, { error }) {
          const agent = await this.handlerTx()
            .withServiceCalls(() => [services.getAgents([pathParams.agentName])])
            .transform(({ serviceResult: [agents] }) => agents.get(pathParams.agentName))
            .execute();
          if (!agent) {
            return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
          }
          try {
            return new Response(await config.agent(agent).watchView(agent), {
              headers: {
                "cache-control": "no-cache",
                "content-type": "application/x-ndjson; charset=utf-8",
                "x-content-type-options": "nosniff",
              },
            });
          } catch (cause) {
            return damagedViewResponse(cause, error);
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/agents/:agentName/entries",
        queryParameters: ["before", "cursor", "pageSize"],
        outputSchema: z.object({
          entries: z.array(z.unknown()),
          cursor: z.string().nullable(),
          hasNextPage: z.boolean(),
        }),
        errorCodes: ["AGENT_NOT_STARTED", "INVALID_BEFORE", "INVALID_CURSOR", "INVALID_PAGE_SIZE"],
        handler: async function ({ pathParams, query }, { json, error }) {
          const before = piAgentEntryPageRequestSchema.shape.before.safeParse(
            Number(query.get("before")),
          );
          if (!before.success) {
            return error(
              { code: "INVALID_BEFORE", message: "Pi entry history requires a `before` entry ID." },
              400,
            );
          }
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
          const agent = await this.handlerTx()
            .withServiceCalls(() => [services.getAgents([pathParams.agentName])])
            .transform(({ serviceResult: [agents] }) => agents.get(pathParams.agentName))
            .execute();
          if (!agent) {
            return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
          }
          const page = await config.agent(agent).listEntries(agent, {
            before: before.data,
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
        path: "/agents/:agentName/export",
        errorCodes: ["AGENT_NOT_STARTED"],
        handler: async function ({ pathParams }, { error }) {
          const agent = await this.handlerTx()
            .withServiceCalls(() => [services.getAgents([pathParams.agentName])])
            .transform(({ serviceResult: [agents] }) => agents.get(pathParams.agentName))
            .execute();
          if (!agent) {
            return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
          }
          return new Response(await config.agent(agent).exportEntries(agent), {
            headers: {
              "cache-control": "no-store",
              "content-disposition": `attachment; filename="pi-agent-${agent.agentName}.jsonl"`,
              "content-type": "application/x-ndjson; charset=utf-8",
              "x-content-type-options": "nosniff",
            },
          });
        },
      }),
      defineRoute({
        method: "POST",
        path: "/agents/:agentName/compact",
        inputSchema: compactionSchema,
        outputSchema: z.object({ taskId: z.number().int().positive() }),
        errorCodes: ["AGENT_NOT_STARTED", "AGENT_NOT_FOUND", "MODEL_UNAVAILABLE"],
        handler: async function ({ pathParams, input }, { json, error }) {
          const { provenance, ...request } = await input.valid();
          const { definition, config: agent } = await this.handlerTx()
            .withServiceCalls(() => [services.getAgent(pathParams.agentName)])
            .transform(({ serviceResult: [agent] }) => agent)
            .execute();
          if (!agent) {
            return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
          }
          const admitted = await admitTurn(definition, pathParams.agentName, provenance);
          if (admitted.type === "error") {
            return error({ code: admitted.code, message: admitted.message }, admitted.status);
          }
          return json(await config.agent(agent).compact(agent, admitted.turn, request), 202);
        },
      }),
      defineRoute({
        method: "GET",
        path: "/agents/:agentName/compactions/:taskId",
        outputSchema: piAgentCompactionStatusSchema,
        errorCodes: ["AGENT_NOT_STARTED", "COMPACTION_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          const agent = await this.handlerTx()
            .withServiceCalls(() => [services.getAgents([pathParams.agentName])])
            .transform(({ serviceResult: [agents] }) => agents.get(pathParams.agentName))
            .execute();
          if (!agent) {
            return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
          }
          const taskId = z.coerce.number().int().positive().safeParse(pathParams.taskId);
          const compaction = taskId.success
            ? await config.agent(agent).getCompaction(agent, taskId.data)
            : null;
          return compaction
            ? json(compaction)
            : error({ code: "COMPACTION_NOT_FOUND", message: "Pi compaction was not found." }, 404);
        },
      }),
      defineRoute({
        method: "GET",
        path: "/agents/:agentName/submissions/:requestId/wait",
        queryParameters: ["waitMs"],
        outputSchema: piAgentSubmissionWaitSchema,
        errorCodes: ["AGENT_NOT_STARTED", "SUBMISSION_NOT_FOUND", "INVALID_WAIT_DURATION"],
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
          const agent = await this.handlerTx()
            .withServiceCalls(() => [services.getAgents([pathParams.agentName])])
            .transform(({ serviceResult: [agents] }) => agents.get(pathParams.agentName))
            .execute();
          if (!agent) {
            return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
          }
          const result = await config
            .agent(agent)
            .waitForSubmission(agent, pathParams.requestId, wait.data);
          return result
            ? json(result)
            : error({ code: "SUBMISSION_NOT_FOUND", message: "Pi submission was not found." }, 404);
        },
      }),
      defineRoute({
        method: "GET",
        path: "/agents/:agentName/submissions/:requestId",
        outputSchema: z.unknown(),
        errorCodes: ["AGENT_NOT_STARTED", "SUBMISSION_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          const agent = await this.handlerTx()
            .withServiceCalls(() => [services.getAgents([pathParams.agentName])])
            .transform(({ serviceResult: [agents] }) => agents.get(pathParams.agentName))
            .execute();
          if (!agent) {
            return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
          }
          const submission = await config.agent(agent).getSubmission(agent, pathParams.requestId);
          return submission
            ? json(submission)
            : error({ code: "SUBMISSION_NOT_FOUND", message: "Pi submission was not found." }, 404);
        },
      }),
      defineRoute({
        method: "POST",
        path: "/agents/:agentName/abort",
        errorCodes: ["AGENT_NOT_STARTED"],
        handler: async function ({ pathParams }, { empty, error }) {
          const agent = await this.handlerTx()
            .withServiceCalls(() => [services.getAgents([pathParams.agentName])])
            .transform(({ serviceResult: [agents] }) => agents.get(pathParams.agentName))
            .execute();
          if (!agent) {
            return error({ code: "AGENT_NOT_STARTED", message: "Pi agent has no turns yet." }, 404);
          }
          await config.agent(agent).abort(agent);
          return empty(204);
        },
      }),
    ];
  },
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
      { requestContext, method, path, ifMatchesRoute, requestState },
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
      async function authorize(
        execution: BackofficeExecutionContext,
        operation: (typeof BACKOFFICE_PERMISSION.pi)[keyof typeof BACKOFFICE_PERMISSION.pi],
        resource: Record<string, unknown>,
      ) {
        try {
          await kernel.assertAuthorized({ execution, operation, resource });
          return undefined;
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
      const changesDefinitions =
        (method === "POST" && path === "/agents") ||
        ((method === "PUT" || method === "DELETE") && path === "/agents/:agentName");
      const denied = await authorize(
        requestContext.execution,
        method === "GET"
          ? BACKOFFICE_PERMISSION.pi.read
          : changesDefinitions
            ? BACKOFFICE_PERMISSION.pi.manage
            : BACKOFFICE_PERMISSION.pi.modify,
        { kind: "pi-agent-directory", scope: config.scope },
      );
      if (denied) {
        return denied;
      }
      // Persisted turn authority is identity only; temporary request authority never leaves here.
      const provenance = {
        actors: requestContext.execution.actors,
        scopeRestriction: backofficeExecutionScopeRestriction(requestContext.execution),
      };
      const prompted = await ifMatchesRoute("POST", "/agents/:agentName/prompts", async () => {
        const parsed = promptRequestSchema.safeParse(requestState.body);
        if (!parsed.success) {
          return error({ code: "INVALID_PROMPT", message: parsed.error.message }, 400);
        }
        const values = parsed.data;
        const billingOrganizationId =
          backofficeScopeOrganization(config.scope)?.orgId ?? values.billingOrganizationId;
        if (billingOrganizationId !== null && !backofficeScopeOrganization(config.scope)) {
          const billingDenied = await authorize(
            { ...requestContext.execution, scope: { kind: "org", orgId: billingOrganizationId } },
            BACKOFFICE_PERMISSION.pi.modify,
            { kind: "pi-agent-billing" },
          );
          if (billingDenied) {
            return billingDenied;
          }
        }
        requestState.setBody({
          ...values,
          requestId: values.requestId ?? crypto.randomUUID(),
          billingOrganizationId,
          provenance,
        });
        return undefined;
      });
      if (prompted) {
        return prompted;
      }
      const notified = await ifMatchesRoute(
        "POST",
        "/agents/:agentName/notifications",
        async () => {
          const parsed = piAgentNotificationSchema.safeParse(requestState.body);
          if (!parsed.success) {
            return error({ code: "INVALID_NOTIFICATION", message: parsed.error.message }, 400);
          }
          requestState.setBody({ ...parsed.data, provenance });
          return undefined;
        },
      );
      if (notified) {
        return notified;
      }
      return await ifMatchesRoute("POST", "/agents/:agentName/compact", async () => {
        const parsed = piAgentCompactionSchema.safeParse(requestState.body);
        if (!parsed.success) {
          return error({ code: "INVALID_COMPACTION", message: parsed.error.message }, 400);
        }
        requestState.setBody({ ...parsed.data, provenance });
        return undefined;
      });
    });
}
