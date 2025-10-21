import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ debug: true });

export default defineConfig({
  out: "./drizzle",
  schema: "./src/db/schema.ts",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env["DATABASE_URL"]!,
  },
});
