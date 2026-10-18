import type { AutomationRouteManagedBy } from "@fragno-dev/backoffice-api/v0/automation";
import type { PiAgentDefinition } from "@fragno-dev/backoffice-api/v0/pi";
import { column, idColumn, schema, type Column } from "@fragno-dev/db/schema";

const jsonColumn = <T>() => column("json") as Column<"json", T, T>;

/**
 * A scope's agent definitions, keyed by agent name, and the agents that have been provisioned. A
 * provisioning outlives its definition, so a deleted agent's conversation resumes if it returns.
 */
export const piAgentDirectorySchema = schema("pi_manager", (s) =>
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

export function definitionFromRow(row: AgentDefinitionRow): PiAgentDefinition {
  return {
    agentName: row.id.valueOf(),
    description: row.description,
    model: row.model,
    permissions: row.permissions,
    instructions: row.instructions,
    managedBy: row.managedBy,
  };
}
