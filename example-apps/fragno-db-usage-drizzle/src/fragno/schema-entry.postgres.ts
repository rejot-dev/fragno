import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { NodePostgresDriverConfig } from "@fragno-dev/db/drivers";
import { createNoopDialect } from "./schema-entry.dialect";
import { createSchemaFragments } from "./schema-entry.shared";

const adapter = new SqlAdapter({
  dialect: createNoopDialect({ supportsReturning: true }),
  driverConfig: new NodePostgresDriverConfig(),
});

export const { authFragment, commentFragment, ratingFragment, workflowsFragment } =
  createSchemaFragments(adapter);
