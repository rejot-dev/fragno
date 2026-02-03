import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { PostgresDialect } from "@fragno-dev/db/dialects";
import { NodePostgresDriverConfig } from "@fragno-dev/db/drivers";

import { getPostgresPool } from "~/db/db.server";

const dialect = new PostgresDialect({ pool: getPostgresPool() });

export function createWorkflowsAdapter() {
  return new SqlAdapter({
    dialect,
    driverConfig: new NodePostgresDriverConfig(),
  });
}
