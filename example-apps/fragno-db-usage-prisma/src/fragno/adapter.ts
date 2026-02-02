import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { BetterSQLite3DriverConfig } from "@fragno-dev/db/drivers";
import { getSqliteDialect } from "../database";

export function createAdapter() {
  return new SqlAdapter({
    dialect: getSqliteDialect(),
    driverConfig: new BetterSQLite3DriverConfig(),
    sqliteProfile: "prisma",
  });
}
export const adapter = createAdapter();
