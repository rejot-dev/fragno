import { KyselyAdapter } from "@fragno-dev/db/adapters/kysely";
import { dialect } from "../database";
import { PGLiteDriverConfig } from "@fragno-dev/db/drivers";

export function createAdapter() {
  return new KyselyAdapter({
    dialect: dialect,
    driverConfig: new PGLiteDriverConfig(),
  });
}
export const adapter = createAdapter();
