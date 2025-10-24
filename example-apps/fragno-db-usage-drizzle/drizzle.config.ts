import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: ["./src/schema/drizzle-schema.ts", "./src/schema/fragno-schema.ts"],
  dialect: "postgresql",
  driver: "pglite",
  dbCredentials: {
    url: "./fragno-db-usage.pglite" as const,
  },
});
