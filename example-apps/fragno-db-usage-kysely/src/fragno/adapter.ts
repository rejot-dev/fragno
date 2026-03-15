import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { PGLiteDriverConfig } from "@fragno-dev/db/drivers";

import { dialect } from "../database";

export function createAdapter() {
  return new SqlAdapter({
    dialect: dialect,
    driverConfig: new PGLiteDriverConfig(),
  });
}
export const adapter = createAdapter();
