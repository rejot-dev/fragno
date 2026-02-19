import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { SQLocalDriverConfig } from "@fragno-dev/db/drivers";
import { createNoopDialect } from "./schema-entry.dialect";
import { createSchemaFragments } from "./schema-entry.shared";

const adapter = new SqlAdapter({
  dialect: createNoopDialect({ supportsReturning: true }),
  driverConfig: new SQLocalDriverConfig(),
});

export const { authFragment, commentFragment, ratingFragment, workflowsFragment } =
  createSchemaFragments(adapter);
