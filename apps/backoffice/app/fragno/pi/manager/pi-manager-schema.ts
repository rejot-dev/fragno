import type { AutomationRouteManagedBy } from "@fragno-dev/backoffice-api/v0/automation";
import type { PiAgentDefinition } from "@fragno-dev/backoffice-api/v0/pi";
import { column, idColumn, schema, type Column } from "@fragno-dev/db/schema";

import type { PiAgentTurn } from "@/fragno/pi/agent/pi-agent-contract";

const jsonColumn = <T>() => column("json") as Column<"json", T, T>;

/** Who asked for a queued item; the queue admits its turn when the item runs. */
export type PiAgentTurnProvenance = Pick<PiAgentTurn, "actors" | "scopeRestriction">;

/** What a queued item asks the agent for. */
type PiAgentQueueInput = { type: "prompt"; content: string };

/**
 * Where an item is in its agent's queue. A dispatched item is the one Pi runs; a steered item joined
 * it. Settled and dropped items stay, so a resent request ID is recognized and never runs twice.
 */
export type PiAgentQueueItemState =
  | { status: "queued" }
  | { status: "dispatched"; turn: PiAgentTurn }
  | { status: "steered"; turn: PiAgentTurn }
  | { status: "settled" }
  | { status: "dropped"; reason: string };

export const AGENT_QUEUE_STATUS_INDEX = "idx_agent_queue_item_agentName_status_position";
export const AGENT_QUEUE_REQUEST_INDEX = "idx_agent_queue_item_agentName_requestId";

/**
 * A scope's agent definitions, keyed by agent name, the agents that have been provisioned, and
 * each agent's queue of work waiting for a turn. A provisioning outlives its definition, so a
 * deleted agent's conversation resumes if it returns.
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
    )
    // Every change to an agent's queue bumps its revision, so concurrent changes to one queue
    // conflict; an item takes the revision that queued it as its position.
    .alterTable("agent", (t) => t.addColumn("queueRevision", column("integer").defaultTo(0)))
    .addTable("agent_queue_item", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("agentName", column("string"))
        .addColumn("position", column("integer"))
        .addColumn("requestId", column("string"))
        .addColumn("input", jsonColumn<PiAgentQueueInput>())
        .addColumn("provenance", jsonColumn<PiAgentTurnProvenance>())
        // Repeats the state's status, which the index needs as a column.
        .addColumn("status", column("string"))
        .addColumn("state", jsonColumn<PiAgentQueueItemState>())
        .createIndex(AGENT_QUEUE_STATUS_INDEX, ["agentName", "status", "position"])
        .createIndex(AGENT_QUEUE_REQUEST_INDEX, ["agentName", "requestId"], { unique: true }),
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
