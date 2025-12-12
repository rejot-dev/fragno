import { DrizzleAdapter } from "@fragno-dev/db/adapters/drizzle";
import { PostgresDialect } from "@fragno-dev/db/dialects";
import { KyselyPGlite } from "kysely-pglite";
import { PGLiteDriverConfig } from "@fragno-dev/db/drivers";
import { db } from "../db";

const { dialect } = new KyselyPGlite(db.$client);

export const adapter = new DrizzleAdapter({
  dialect,
  driverConfig: new PGLiteDriverConfig(),
});
