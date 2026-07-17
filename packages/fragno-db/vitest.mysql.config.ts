import { defineConfig } from "vitest/config";

import { baseConfig } from "@fragno-private/vitest-config";

const mysqlContractTest = "src/adapters/generic-sql/sql-adapter-mysql2-query-engine-suite.test.ts";

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [mysqlContractTest],
    environment: "node",
    fileParallelism: false,
    hookTimeout: 15_000,
    testTimeout: 15_000,
    coverage: {
      ...baseConfig.test.coverage,
      enabled: false,
    },
  },
});
