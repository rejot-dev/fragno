import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./app/db/schema.ts",
  dialect: "postgresql",
  driver: "pglite",
  dbCredentials: {
    url: "./wf-example.pglite" as const,
  },
});
