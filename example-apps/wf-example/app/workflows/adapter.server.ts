import { DrizzleAdapter } from "@fragno-dev/db/adapters/drizzle";
import { PGLiteDriverConfig } from "@fragno-dev/db/drivers";
import { KyselyPGlite } from "kysely-pglite";

import { getPgliteClient } from "~/db/db.server";

const { dialect } = new KyselyPGlite(getPgliteClient());

export function createWorkflowsAdapter() {
  return new DrizzleAdapter({
    dialect,
    driverConfig: new PGLiteDriverConfig(),
  });
}
