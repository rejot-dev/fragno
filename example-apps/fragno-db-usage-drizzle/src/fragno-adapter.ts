import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { getPGLiteClient } from "./database";
import { PGLiteDriverConfig } from "@fragno-dev/db/drivers";
import { KyselyPGlite } from "kysely-pglite";

const { dialect } = new KyselyPGlite(getPGLiteClient());

export function createNewAdapter() {
  return new SqlAdapter({
    dialect,
    driverConfig: new PGLiteDriverConfig(),
    outbox: { enabled: true },
  });
}

export const adapter = createNewAdapter();
