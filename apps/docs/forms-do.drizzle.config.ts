import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: ["./app/db/forms-do.schema.ts"],
  out: "./app/db/forms-do/migrations",
});
