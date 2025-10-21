import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const todos = sqliteTable("todos", {
  id: integer("id", { mode: "number" }).primaryKey({
    autoIncrement: true,
  }),
  title: text("title").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});
