import { workflowsSchema } from "@fragno-dev/workflows/schema";

import { automationFragmentSchema } from "../schema";

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

/** The kind of the read views the replica worker maintains with `automationReads`. */
export const AUTOMATION_READ_VIEWS = "automation-reads";

/** The kind of the guarded SQL views the replica worker maintains for pages. */
export const AUTOMATION_PAGE_VIEWS = "automation-pages";
