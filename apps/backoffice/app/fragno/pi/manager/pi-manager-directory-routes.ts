import {
  piAgentDefinitionCreateSchema,
  piAgentDefinitionSchema,
  piAgentDefinitionUpdateSchema,
  piManagerAgentDirectorySchema,
  piManagerAgentSchema,
} from "@fragno-dev/backoffice-api/v0/pi";
import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import { builtInPiAgentDefinition } from "@/fragno/pi/agent/agent-definitions";
import { piAvailableModelSchema } from "@/fragno/pi/agent/pi-agent-contract";

import { piManagerDefinition } from "./pi-manager-definition";

function builtInResponse<T>(
  agentName: string,
  error: (body: { code: "AGENT_BUILT_IN"; message: string }, status: 409) => T,
): T {
  return error(
    { code: "AGENT_BUILT_IN", message: `Pi agent '${agentName}' is built in and cannot change.` },
    409,
  );
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
          provisioned: agent !== null,
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
  ],
);
