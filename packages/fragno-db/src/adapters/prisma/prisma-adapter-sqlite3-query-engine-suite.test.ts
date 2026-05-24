import SQLite from "better-sqlite3";
import { SqliteDialect } from "kysely";

import { BetterSQLite3DriverConfig } from "../generic-sql/driver-config";
import { SqlAdapter } from "../generic-sql/generic-sql-adapter";
import { describeQueryEngineSuite } from "../test-suite/query-engine-suite";

describeQueryEngineSuite({
  name: "generic-sql sqlite3 prisma profile",
  createAdapter: async () => {
    const database = new SQLite(":memory:");
    const adapter = new SqlAdapter({
      dialect: new SqliteDialect({ database }),
      driverConfig: new BetterSQLite3DriverConfig(),
      sqliteProfile: "prisma",
    });
    return { adapter, close: () => adapter.close() };
  },
  capabilities: {
    constraints: false,
  },
});
