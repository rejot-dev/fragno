import { DrizzleAdapter } from "@fragno-dev/db/adapters/drizzle";
import { PGLiteDriverConfig } from "@fragno-dev/db/drivers";
import { KyselyPGlite } from "kysely-pglite";

import { getPgliteClient } from "~/db/pglite.server";

export function createAiAdapter() {
  const { dialect } = new KyselyPGlite(getPgliteClient());

  return new DrizzleAdapter({
    dialect,
    driverConfig: new PGLiteDriverConfig(),
  });
}
