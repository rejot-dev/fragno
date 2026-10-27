import { workflowsSchema } from "@fragno-dev/workflows/schema";

import { automationFragmentSchema } from "../schema";

/** The schemas the replica mirrors: the Automations fragment's and its workflows'. */
export const AUTOMATION_REPLICA_SCHEMAS = [
  { schema: automationFragmentSchema },
  { schema: workflowsSchema },
];

/** The kind of the read views the replica worker maintains with `automationReads`. */
export const AUTOMATION_READ_VIEWS = "automation-reads";

/** The kind of the guarded SQL views the replica worker maintains for pages. */
export const AUTOMATION_PAGE_VIEWS = "automation-pages";
