import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle/mysql",
  schema: ["./src/schema/drizzle-schema.mysql.ts", "./src/schema/fragno-schema.mysql.ts"],
  dialect: "mysql",
  dbCredentials: {
    url: "mysql://root:password@localhost:3306/fragno_db_usage",
  },
});
