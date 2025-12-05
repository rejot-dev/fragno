import { DrizzleAdapter } from "@fragno-dev/db/adapters/drizzle";
import { getPGLiteClient } from "./database";
import { PGLiteDriverConfig } from "@fragno-dev/db/drivers";
import { KyselyPGlite } from "kysely-pglite";

const { dialect } = new KyselyPGlite(getPGLiteClient());

export function createNewAdapter() {
  return new DrizzleAdapter({
    dialect,
    driverConfig: new PGLiteDriverConfig(),
  });
}

export const adapter = createNewAdapter();
