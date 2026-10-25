import type { LofiSqliteReplica } from "@fragno-dev/lofi/sqlite";
import { workflowsSchema } from "@fragno-dev/workflows/schema";

import { getBrowserReplica } from "@/fragno/lofi/browser-replica";

import { automationFragmentSchema } from "../schema";
import {
  describeAutomationCollectionSource,
  type AutomationCollectionSource,
} from "../tanstack/browser-database";
import { automationViews } from "./views";

/** The schemas the replica mirrors, the same ones the scope's TanStack collections do. */
export const AUTOMATION_REPLICA_SCHEMAS = [
  { schema: automationFragmentSchema },
  { schema: workflowsSchema },
];

/**
 * Older outbox entries still write these tables, which the schema removed with `noOp`, and the
 * replica rejects unknown tables of a registered schema.
 */
export const AUTOMATION_REPLICA_EPHEMERAL_TABLES = [
  "sandbox_instance",
  "marketplace_ingestion",
].map((table) => ({ schema: automationFragmentSchema.name, table }));

/**
 * The scope's Automations replica in this tab, with the views its projections keep. It streams
 * the same outbox as the scope's TanStack coordinator, over its own connection.
 */
export function getAutomationReplica(
  source: AutomationCollectionSource,
): Promise<LofiSqliteReplica> {
  const description = describeAutomationCollectionSource(source);
  return getBrowserReplica({
    name: "Automations",
    baseUrl: description.baseUrl,
    resourceKey: description.resourceKey,
    schemas: AUTOMATION_REPLICA_SCHEMAS,
    localSchemas: automationViews.localSchemas,
    projections: automationViews.projections,
    ephemeralTables: AUTOMATION_REPLICA_EPHEMERAL_TABLES,
  });
}
