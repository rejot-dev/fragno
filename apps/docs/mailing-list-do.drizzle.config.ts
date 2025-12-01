import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: ["./app/db/mailing-list-do.schema.ts"],
  out: "./app/db/mailing-list-do/migrations",
});
