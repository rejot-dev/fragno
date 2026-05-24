import { KyselyPGlite } from "kysely-pglite";

import { PGlite } from "@electric-sql/pglite";

import { describeQueryEngineSuite } from "../test-suite/query-engine-suite";
import { PGLiteDriverConfig } from "./driver-config";
import { SqlAdapter } from "./generic-sql-adapter";

describeQueryEngineSuite({
  name: "generic-sql pglite",
  createAdapter: async () => {
    const database = new PGlite();
    const { dialect } = new KyselyPGlite(database);
    const adapter = new SqlAdapter({ dialect, driverConfig: new PGLiteDriverConfig() });
    return { adapter, close: () => adapter.close() };
  },
  capabilities: {
    constraints: false,
  },
});
