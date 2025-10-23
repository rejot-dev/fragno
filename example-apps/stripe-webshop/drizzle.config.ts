import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ debug: true });

export default defineConfig({
  out: "./drizzle",
  schema: "./src/db/schema.ts",
  dialect: "postgresql",
  driver: "pglite",
  dbCredentials: {
    url: process.env["DATABASE_URL"]!,
  },
});
