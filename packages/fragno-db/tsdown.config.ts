import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: [
      "./src/mod.ts",
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
      "./src/fragment.ts",
      "./src/db-fragment-definition-builder.ts",
      "./src/dispatchers/node/index.ts",
      "./src/dispatchers/cloudflare-do/index.ts",
      "./src/migration-engine/generation-engine.ts",
    ],
    dts: true,
    unbundle: true,
  },
  {
    entry: ["./src/browser/mod.ts"],
    platform: "browser",
    outDir: "./dist/browser",
    dts: true,
    unbundle: true,
  },
]);
