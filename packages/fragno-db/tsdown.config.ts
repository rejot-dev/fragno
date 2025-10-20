import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "./src/mod.ts",
    "./src/id.ts",
    "./src/schema/create.ts",
    "./src/adapters/kysely/kysely-adapter.ts",
    "./src/adapters/drizzle/drizzle-adapter.ts",
    "./src/query/unit-of-work.ts",
    "./src/query/cursor.ts",
  ],
  dts: true,
  unbundle: true,
});
