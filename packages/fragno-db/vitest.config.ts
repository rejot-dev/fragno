import { configDefaults, defineConfig } from "vitest/config";

import { baseConfig } from "@fragno-private/vitest-config";

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    exclude: [
      ...configDefaults.exclude,
      "src/adapters/generic-sql/sql-adapter-mysql2-query-engine-suite.test.ts",
    ],
    environment: "node",
  },
});
