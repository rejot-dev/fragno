import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: ["./app/db/schema.ts", "./app/db/workflows.schema.ts"],
  dialect: "postgresql",
  schemaFilter: ["public", "workflows"],
  dbCredentials: {
    url:
      process.env["WF_EXAMPLE_DATABASE_URL"] ??
      process.env["DATABASE_URL"] ??
      "postgres://postgres:postgres@localhost:5436/wilco",
  },
});
