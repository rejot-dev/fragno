import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const workflowRun = pgTable("workflow_run", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  stepCount: integer("step_count").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const schema = { workflowRun };
