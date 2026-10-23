import type { AutomationRouteManagedBy } from "@fragno-dev/backoffice-api/v0/automation";
import type { PiAgentDefinition } from "@fragno-dev/backoffice-api/v0/pi";
import { column, idColumn, schema, type Column } from "@fragno-dev/db/schema";

import type {
  PiAgentModelChoice,
  PiAgentNotification,
  PiAgentTurn,
} from "@/fragno/pi/agent/pi-agent-contract";

const jsonColumn = <T>() => column("json") as Column<"json", T, T>;

/** Who asked for a queued item; the queue admits its turn when the item runs. */
export type PiAgentTurnProvenance = Pick<PiAgentTurn, "actors" | "scopeRestriction">;

/**
 * What a queued item asks the agent for. A prompt's model is the one its turn runs with, which
 * null leaves as the conversation's.
 */
export type PiAgentQueueInput =
  | { type: "prompt"; content: string; model: PiAgentModelChoice | null }
  | { type: "notification"; notification: PiAgentNotification };

/**
 * Where an item is in its agent's queue. Dispatched items are the turn Pi runs, several when it
 * handles notifications together, and each names that turn by its Pi request ID; a steered item
 * joined it under its own. Settled and dropped items stay, so a resent request ID is recognized and
 * never runs twice, and a settled one still names the turn that handled it.
 */
export type PiAgentQueueItemState =
  | { status: "queued" }
  | { status: "dispatched"; turn: PiAgentTurn; turnRequestId: string }
  | { status: "steered"; turn: PiAgentTurn }
  | { status: "settled"; turnRequestId: string }
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
    .noOp("removed agent queueRevision column; the agent row's version replaces it")
    .addTable("agent_queue_item", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("agentName", column("string"))
        // The agent row's version after the change that queued the item.
        .addColumn("position", column("integer"))
        .addColumn("requestId", column("string"))
        .addColumn("input", jsonColumn<PiAgentQueueInput>())
        .addColumn("provenance", jsonColumn<PiAgentTurnProvenance>())
        // Repeats the state's status, which the index needs as a column.
        .addColumn("status", column("string"))
        .addColumn("state", jsonColumn<PiAgentQueueItemState>())
        .createIndex(AGENT_QUEUE_STATUS_INDEX, ["agentName", "status", "position"])
        .createIndex(AGENT_QUEUE_REQUEST_INDEX, ["agentName", "requestId"], { unique: true }),
    )
    // Stopping an agent pauses its queue: nothing waiting is dispatched until it is resumed.
    .alterTable("agent", (t) => t.addColumn("paused", column("bool").defaultTo(false)))
    .alterTable("agent", (t) => t.dropColumn("billingOrganizationId")),
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
