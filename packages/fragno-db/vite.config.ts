import { defineConfig } from "vite-plus";

import { baseConfig } from "@fragno-private/vitest-config";

export default defineConfig({
  pack: [
    {
      fixedExtension: false,
      entry: [
        "./src/mod.ts",
        "./src/durable-hooks.ts",
        "./src/id.ts",
        "./src/schema/create.ts",
        "./src/query/simple-query-interface.ts",
        "./src/adapters/adapters.ts",
        "./src/adapters/in-memory/index.ts",
        "./src/adapters/sql/index.ts",
        "./src/adapters/generic-sql/driver-config.ts",
        "./src/schema-output/drizzle.ts",
        "./src/schema-output/prisma.ts",
        "./src/client.ts",
        "./src/sync/index.ts",
        "./src/sql-driver/sql-driver.ts",
        "./src/sql-driver/dialects/dialects.ts",
        "./src/sql-driver/dialects/durable-object-dialect.ts",
        "./src/query/unit-of-work/unit-of-work.ts",
        "./src/query/cursor.ts",
        "./src/db-fragment-definition-builder.ts",
        "./src/dispatchers/node/index.ts",
        "./src/dispatchers/cloudflare-do/index.ts",
        "./src/migration-engine/generation-engine.ts",
      ],
      dts: true,
      unbundle: true,
    },
    {
      fixedExtension: false,
      entry: ["./src/browser/mod.ts"],
      platform: "browser",
      outDir: "./dist/browser",
      dts: true,
      unbundle: true,
    },
  ],

  test: {
    ...baseConfig.test,
    environment: "node",
  },
});
