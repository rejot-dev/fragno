import { PrismaAdapter } from "@fragno-dev/db/adapters/prisma";
import { BetterSQLite3DriverConfig } from "@fragno-dev/db/drivers";
import { getSqliteDialect } from "../database";

export function createAdapter() {
  return new PrismaAdapter({
    dialect: getSqliteDialect(),
    driverConfig: new BetterSQLite3DriverConfig(),
  });
}
export const adapter = createAdapter();
