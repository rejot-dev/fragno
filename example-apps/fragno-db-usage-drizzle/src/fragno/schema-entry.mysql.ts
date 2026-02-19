import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { MySQL2DriverConfig } from "@fragno-dev/db/drivers";
import { createNoopDialect } from "./schema-entry.dialect";
import { createSchemaFragments } from "./schema-entry.shared";

const adapter = new SqlAdapter({
  dialect: createNoopDialect({ supportsReturning: false }),
  driverConfig: new MySQL2DriverConfig(),
});

export const { authFragment, commentFragment, ratingFragment, workflowsFragment } =
  createSchemaFragments(adapter);
