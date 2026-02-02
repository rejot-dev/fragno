import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { PGLiteDriverConfig } from "@fragno-dev/db/drivers";
import { KyselyPGlite } from "kysely-pglite";

import { getPgliteClient } from "~/db/db.server";

const { dialect } = new KyselyPGlite(getPgliteClient());

export function createWorkflowsAdapter() {
  return new SqlAdapter({
    dialect,
    driverConfig: new PGLiteDriverConfig(),
  });
}
