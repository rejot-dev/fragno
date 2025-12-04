import { DrizzleAdapter, NewDrizzleAdapter } from "@fragno-dev/db/adapters/drizzle";
import { getDrizzleDatabase, getPGLiteClient } from "./database";
import { PGLiteDriverConfig } from "@fragno-dev/db/drivers";
import { KyselyPGlite } from "kysely-pglite";

const { dialect } = new KyselyPGlite(getPGLiteClient());

export function createNewAdapter() {
  return new NewDrizzleAdapter({
    dialect,
    driverConfig: new PGLiteDriverConfig(),
  });
}

export function createAdapter() {
  return new DrizzleAdapter({
    db: getDrizzleDatabase,
    provider: "postgresql",
  });
}

// export const adapter = createAdapter();
export const adapter = createNewAdapter();
