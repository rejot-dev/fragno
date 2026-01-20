import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const aiSession = pgTable("ai_session", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const schema = { aiSession };
