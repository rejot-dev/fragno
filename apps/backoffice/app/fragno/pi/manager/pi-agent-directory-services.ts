import {
  type PiAgentConfig,
  type PiAgentDefinition,
  type PiAgentDefinitionCreate,
} from "@fragno-dev/backoffice-api/v0/pi";
import {
  type BackofficeContextScope,
  backofficeScopeRootOwner,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { DatabaseServiceContext } from "@fragno-dev/db";

import {
  BUILT_IN_PI_AGENT_DEFINITIONS,
  builtInPiAgentDefinition,
} from "@/fragno/pi/agent/agent-definitions";

import { definitionFromRow, piAgentDirectorySchema } from "./pi-manager-schema";

type AgentProvisioning =
  | { type: "provisioned"; config: PiAgentConfig }
  | { type: "billing-owner-required" };

/** A scope's agent definitions and the agents provisioned in it. */
export function piAgentDirectoryServices(
  defineService: <TService>(
    service: TService & ThisType<DatabaseServiceContext<Record<never, never>>>,
  ) => TService,
  config: { scope: BackofficeContextScope },
) {
  return defineService({
    /** A user-scoped agent's first turn chooses its billing owner; later turns reuse it. */
    provisionAgent: function (input: { agentName: string; billingOrganizationId: string | null }) {
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
  });
}
