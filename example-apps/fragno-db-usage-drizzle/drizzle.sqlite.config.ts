import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle/sqlite",
  schema: ["./src/schema/drizzle-schema.sqlite.ts", "./src/schema/fragno-schema.sqlite.ts"],
  dialect: "sqlite",
  dbCredentials: {
    url: "./fragno-db-usage.sqlite" as const,
  },
});
