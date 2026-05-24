import { SQLocalKysely } from "sqlocal/kysely";

import { describeQueryEngineSuite } from "../test-suite/query-engine-suite";
import { SQLocalDriverConfig } from "./driver-config";
import { SqlAdapter } from "./generic-sql-adapter";

describeQueryEngineSuite({
  name: "generic-sql sqlocal",
  createAdapter: async () => {
    const { dialect } = new SQLocalKysely(":memory:");
    const adapter = new SqlAdapter({ dialect, driverConfig: new SQLocalDriverConfig() });
    return { adapter, close: () => adapter.close() };
  },
  capabilities: {
    constraints: false,
  },
});
