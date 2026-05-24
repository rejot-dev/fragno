import SQLite from "better-sqlite3";
import { SqliteDialect } from "kysely";

import { describeQueryEngineSuite } from "../test-suite/query-engine-suite";
import { BetterSQLite3DriverConfig } from "./driver-config";
import { SqlAdapter } from "./generic-sql-adapter";

describeQueryEngineSuite({
  name: "generic-sql sqlite3",
  createAdapter: async () => {
    const database = new SQLite(":memory:");
    const adapter = new SqlAdapter({
      dialect: new SqliteDialect({ database }),
      driverConfig: new BetterSQLite3DriverConfig(),
    });
    return { adapter, close: () => adapter.close() };
  },
  capabilities: {
    constraints: false,
  },
});
