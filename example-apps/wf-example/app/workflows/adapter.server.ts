import type { Pool } from "pg";
import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { PostgresDialect } from "@fragno-dev/db/dialects";
import { NodePostgresDriverConfig } from "@fragno-dev/db/drivers";

import { getPostgresPool } from "~/db/db.server";

export function createWorkflowsAdapter(pool?: Pool) {
  const dialect = new PostgresDialect({ pool: pool ?? getPostgresPool() });
  return new SqlAdapter({
    dialect,
    driverConfig: new NodePostgresDriverConfig(),
  });
}
