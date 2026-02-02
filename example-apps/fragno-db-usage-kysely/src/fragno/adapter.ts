import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { dialect } from "../database";
import { PGLiteDriverConfig } from "@fragno-dev/db/drivers";

export function createAdapter() {
  return new SqlAdapter({
    dialect: dialect,
    driverConfig: new PGLiteDriverConfig(),
  });
}
export const adapter = createAdapter();
