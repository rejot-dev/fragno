import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { PGLiteDriverConfig } from "@fragno-dev/db/drivers";
import { KyselyPGlite } from "kysely-pglite";

import { getPGLiteClient } from "./database";

const { dialect } = new KyselyPGlite(getPGLiteClient());

export function createNewAdapter() {
  return new SqlAdapter({
    dialect,
    driverConfig: new PGLiteDriverConfig(),
  });
}

export const adapter = createNewAdapter();
