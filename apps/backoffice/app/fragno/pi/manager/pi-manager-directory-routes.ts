import {
  piAgentCreatedSchema,
  piAgentDefinitionCreateSchema,
  piAgentDefinitionSchema,
  piAgentDefinitionUpdateSchema,
  piManagerAgentDirectorySchema,
  piManagerAgentSchema,
} from "@fragno-dev/backoffice-api/v0/pi";
import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import { AutomationStewardError, MEMBERS_STEWARD } from "@/fragno/automation/stewards";
import {
  builtInPiAgentDefinition,
  piAgentModelRef,
  piDefinedAgentModel,
} from "@/fragno/pi/agent/agent-definitions";
import { piAvailableModelSchema } from "@/fragno/pi/agent/pi-agent-contract";

import { piManagerDefinition } from "./pi-manager-definition";
import { turnProvenanceSchema } from "./pi-manager-turn-routes";

function stewardedResponse<T>(
  cause: AutomationStewardError,
  error: (body: { code: "AGENT_STEWARDED"; message: string }, status: 409) => T,
): T {
  return error({ code: "AGENT_STEWARDED", message: cause.message }, 409);
}

/** The models agents may use, and the scope's agent definitions. */
export const piManagerDirectoryRoutes = defineRoutes(piManagerDefinition).create(
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
      inputSchema: piAgentDefinitionCreateSchema._zod.innerType.extend({
        provenance: turnProvenanceSchema,
      }),
      outputSchema: piAgentCreatedSchema,
      errorCodes: ["AGENT_EXISTS"],
      handler: async function ({ input }, { json, error }) {
        const { provenance, ...definition } = await input.valid();
        const conflict = error(
          { code: "AGENT_EXISTS", message: `Pi agent '${definition.agentName}' already exists.` },
          409,
        );
        if (builtInPiAgentDefinition(definition.agentName)) {
          return conflict;
        }
        const created = await this.handlerTx()
          .withServiceCalls(() => [services.createAgentDefinition(definition, provenance)])
          .transform(({ serviceResult: [created] }) => created)
          .execute();
        if (!created) {
          return conflict;
        }
        const model = piDefinedAgentModel(created, await config.supportedAvailableModels());
        return json({ ...created, resolvedModel: model ? piAgentModelRef(model) : null }, 201);
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
          provisioned: agent !== null,
        });
      },
    }),
    defineRoute({
      method: "PUT",
      path: "/agents/:agentName",
      inputSchema: piAgentDefinitionUpdateSchema._zod.innerType.extend({
        provenance: turnProvenanceSchema,
      }),
      outputSchema: piAgentDefinitionSchema,
      errorCodes: ["AGENT_NOT_FOUND", "AGENT_STEWARDED"],
      handler: async function ({ pathParams, input }, { json, error }) {
        const { provenance, ...fields } = await input.valid();
        const definition = { agentName: pathParams.agentName, ...fields };
        let replaced;
        try {
          replaced = await this.handlerTx()
            .withServiceCalls(() => [
              services.replaceAgentDefinition(definition, MEMBERS_STEWARD, provenance),
            ])
            .transform(({ serviceResult: [replaced] }) => replaced)
            .execute();
        } catch (cause) {
          if (cause instanceof AutomationStewardError) {
            return stewardedResponse(cause, error);
          }
          throw cause;
        }
        return replaced
          ? json(replaced)
          : error({ code: "AGENT_NOT_FOUND", message: "Pi agent is not defined." }, 404);
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/agents/:agentName",
      inputSchema: z.object({ provenance: turnProvenanceSchema }),
      errorCodes: ["AGENT_STEWARDED"],
      handler: async function ({ pathParams, input }, { empty, error }) {
        const { provenance } = await input.valid();
        try {
          await this.handlerTx()
            .withServiceCalls(() => [
              services.deleteAgentDefinition(pathParams.agentName, MEMBERS_STEWARD, provenance),
            ])
            .execute();
        } catch (cause) {
          if (cause instanceof AutomationStewardError) {
            return stewardedResponse(cause, error);
          }
          throw cause;
        }
        return empty(204);
      },
    }),
  ],
);
