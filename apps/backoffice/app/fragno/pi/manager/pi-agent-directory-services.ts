import { isDeepStrictEqual } from "node:util";

import type { AutomationSteward } from "@fragno-dev/backoffice-api/v0/automation";
import {
  type PiAgentConfig,
  type PiAgentDefinition,
  type PiAgentDefinitionCreate,
} from "@fragno-dev/backoffice-api/v0/pi";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { DatabaseServiceContext } from "@fragno-dev/db";

import {
  assertStewardWrite,
  isStewardedByPackage,
  MEMBERS_STEWARD,
} from "@/fragno/automation/stewards";
import {
  BUILT_IN_PI_AGENT_DEFINITIONS,
  builtInPiAgentDefinition,
} from "@/fragno/pi/agent/agent-definitions";

import type { PiManagerHooks } from "./pi-agent-queue";
import {
  type AgentDefinitionRow,
  definitionFromRow,
  legacyMarketplaceAgentListingId,
  piAgentDirectorySchema,
  type PiAgentTurnProvenance,
} from "./pi-manager-schema";

function agentResource(agentName: string) {
  return `Pi agent '${agentName}'`;
}

/** Built-in agents are Backoffice's, so no write in a scope changes them. */
function assertNotBuiltIn(agentName: string) {
  const builtIn = builtInPiAgentDefinition(agentName);
  if (builtIn) {
    assertStewardWrite({
      resource: agentResource(agentName),
      steward: builtIn.steward,
      legacyListingId: null,
      writer: MEMBERS_STEWARD,
      definitionChanged: true,
      toggleable: false,
    });
  }
}

/**
 * The agent's steward once the writer replaces its definition with the next one: a package claims
 * what it writes, and members keep their own. Throws `AutomationStewardError` when the writer may
 * not make the change.
 */
function stewardAfterWrite(
  existing: AgentDefinitionRow,
  next: PiAgentDefinitionCreate,
  writer: AutomationSteward,
): AutomationSteward {
  const steward = existing.steward ?? MEMBERS_STEWARD;
  const { steward: _steward, agentName: _agentName, ...current } = definitionFromRow(existing);
  const { agentName: _nextAgentName, ...fields } = next;
  assertStewardWrite({
    resource: agentResource(next.agentName),
    steward,
    legacyListingId: legacyMarketplaceAgentListingId(existing),
    writer,
    definitionChanged: !isDeepStrictEqual(current, fields),
    toggleable: false,
  });
  return writer.kind === "package" ? writer : steward;
}

/**
 * Throws `AutomationStewardError` when the package may not define the agent: a built-in name, or
 * an existing agent it may not take over.
 */
function assertPackageMayDefine(
  existing: AgentDefinitionRow | undefined,
  agent: PiAgentDefinitionCreate,
  writer: AutomationSteward,
) {
  assertNotBuiltIn(agent.agentName);
  if (existing) {
    stewardAfterWrite(existing, agent, writer);
  }
}

/**
 * A scope's agent definitions and the agents provisioned in it; a first prompt provisions one. Each
 * change to a definition records who made it.
 */
export function piAgentDirectoryServices(
  defineService: <TService>(
    service: TService & ThisType<DatabaseServiceContext<PiManagerHooks>>,
  ) => TService,
  config: { scope: BackofficeContextScope },
) {
  return defineService({
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
          const provisioned = new Set(agents.map((agent) => agent.id.valueOf()));
          return [...BUILT_IN_PI_AGENT_DEFINITIONS, ...definitions.map(definitionFromRow)]
            .sort((left, right) => left.agentName.localeCompare(right.agentName))
            .map((definition) => ({
              ...definition,
              provisioned: provisioned.has(definition.agentName),
            }));
        })
        .build();
    },
    /** Defines a members' agent; null when the name is taken. */
    createAgentDefinition: function (
      definition: PiAgentDefinitionCreate,
      provenance: PiAgentTurnProvenance,
    ) {
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
          const created = { ...definition, steward: MEMBERS_STEWARD };
          const { agentName, ...fields } = created;
          uow.create("agent_definition", { id: agentName, ...fields, managedBy: null });
          uow.triggerHook("recordAgentChange", {
            kind: "created",
            agentName,
            definition: created,
            provenance,
          });
          return created;
        })
        .build();
    },
    /**
     * Null when no definition has the name. Throws `AutomationStewardError` when the writer may not
     * change the agent.
     */
    replaceAgentDefinition: function (
      definition: PiAgentDefinitionCreate,
      writer: AutomationSteward,
      provenance: PiAgentTurnProvenance,
    ) {
      return this.serviceTx(piAgentDirectorySchema)
        .retrieve((uow) =>
          uow.findFirst("agent_definition", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", definition.agentName)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing] }): PiAgentDefinition | null => {
          assertNotBuiltIn(definition.agentName);
          if (!existing) {
            return null;
          }
          const replaced = {
            ...definition,
            steward: stewardAfterWrite(existing, definition, writer),
          };
          const { agentName, ...fields } = replaced;
          uow.update("agent_definition", existing.id, (b) =>
            b.set({ ...fields, managedBy: null }).check(),
          );
          uow.triggerHook("recordAgentChange", {
            kind: "updated",
            agentName,
            definition: replaced,
            provenance,
          });
          return replaced;
        })
        .build();
    },
    /** Throws `AutomationStewardError` when the writer may not delete the agent. */
    deleteAgentDefinition: function (
      agentName: string,
      writer: AutomationSteward,
      provenance: PiAgentTurnProvenance,
    ) {
      return this.serviceTx(piAgentDirectorySchema)
        .retrieve((uow) =>
          uow.findFirst("agent_definition", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", agentName)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing] }) => {
          assertNotBuiltIn(agentName);
          if (existing) {
            assertStewardWrite({
              resource: agentResource(agentName),
              steward: existing.steward ?? MEMBERS_STEWARD,
              legacyListingId: legacyMarketplaceAgentListingId(existing),
              writer,
              definitionChanged: true,
              toggleable: false,
            });
            uow.delete("agent_definition", existing.id, (b) => b.check());
            uow.triggerHook("recordAgentChange", {
              kind: "deleted",
              agentName,
              definition: definitionFromRow(existing),
              provenance,
            });
          }
        })
        .build();
    },
    /**
     * Checks, without writing, that `applyPackageAgents` would accept the declared agents. Throws
     * `AutomationStewardError` for one the package may not define.
     */
    checkPackageAgents: function (listingId: string, agents: readonly PiAgentDefinitionCreate[]) {
      const writer: AutomationSteward = { kind: "package", listingId };
      return this.serviceTx(piAgentDirectorySchema)
        .retrieve((uow) => uow.find("agent_definition", (b) => b.whereIndex("primary")))
        .transformRetrieve(([rows]) => {
          const rowsByName = new Map(rows.map((row) => [row.id.valueOf(), row]));
          for (const agent of agents) {
            assertPackageMayDefine(rowsByName.get(agent.agentName), agent, writer);
          }
        })
        .build();
    },
    /**
     * Makes a package's agents match its declaration: declared agents are created or updated, and
     * those the package no longer declares are deleted. Throws `AutomationStewardError` for a
     * declared agent the package may not take over.
     */
    applyPackageAgents: function (
      listingId: string,
      agents: readonly PiAgentDefinitionCreate[],
      provenance: PiAgentTurnProvenance,
    ) {
      const writer: AutomationSteward = { kind: "package", listingId };
      return this.serviceTx(piAgentDirectorySchema)
        .retrieve((uow) => uow.find("agent_definition", (b) => b.whereIndex("primary")))
        .mutate(({ uow, retrieveResult: [rows] }) => {
          const rowsByName = new Map(rows.map((row) => [row.id.valueOf(), row]));
          for (const agent of agents) {
            const declared = { ...agent, steward: writer };
            const { agentName, ...fields } = declared;
            const existing = rowsByName.get(agentName);
            assertPackageMayDefine(existing, agent, writer);
            if (!existing) {
              uow.create("agent_definition", { id: agentName, ...fields, managedBy: null });
              uow.triggerHook("recordAgentChange", {
                kind: "created",
                agentName,
                definition: declared,
                provenance,
              });
              continue;
            }
            if (
              isDeepStrictEqual(definitionFromRow(existing), declared) &&
              existing.managedBy === null
            ) {
              continue;
            }
            uow.update("agent_definition", existing.id, (b) =>
              b.set({ ...fields, managedBy: null }).check(),
            );
            uow.triggerHook("recordAgentChange", {
              kind: "updated",
              agentName,
              definition: declared,
              provenance,
            });
          }
          const declaredNames = new Set(agents.map((agent) => agent.agentName));
          for (const row of rows) {
            if (
              isStewardedByPackage(row.steward ?? MEMBERS_STEWARD, listingId) &&
              !declaredNames.has(row.id.valueOf())
            ) {
              uow.delete("agent_definition", row.id, (b) => b.check());
              uow.triggerHook("recordAgentChange", {
                kind: "deleted",
                agentName: row.id.valueOf(),
                definition: definitionFromRow(row),
                provenance,
              });
            }
          }
        })
        .build();
    },
    /** Deletes a package's agents, returning their names. */
    removePackageAgents: function (listingId: string, provenance: PiAgentTurnProvenance) {
      return this.serviceTx(piAgentDirectorySchema)
        .retrieve((uow) => uow.find("agent_definition", (b) => b.whereIndex("primary")))
        .mutate(({ uow, retrieveResult: [rows] }) =>
          rows
            .filter((row) => isStewardedByPackage(row.steward ?? MEMBERS_STEWARD, listingId))
            .map((row) => {
              uow.delete("agent_definition", row.id, (b) => b.check());
              uow.triggerHook("recordAgentChange", {
                kind: "deleted",
                agentName: row.id.valueOf(),
                definition: definitionFromRow(row),
                provenance,
              });
              return row.id.valueOf();
            }),
        )
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
                },
              ]),
            ),
        )
        .build();
    },
  });
}
