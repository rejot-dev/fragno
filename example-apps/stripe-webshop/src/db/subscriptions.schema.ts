import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  bigserial,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createId } from "@fragno-dev/db/id";

export const subscription = pgTable(
  "subscription",
  {
    id: varchar("id", { length: 30 })
      .notNull()
      .$defaultFn(() => createId()),
    plan: text("plan").notNull(),
    referenceId: text("referenceId").notNull(),
    stripeCustomerId: text("stripeCustomerId"),
    stripeSubscriptionId: text("stripeSubscriptionId"),
    status: text("status").notNull().default("incomplete"),
    periodStart: timestamp("periodStart"),
    periodEnd: timestamp("periodEnd"),
    trialStart: timestamp("trialStart"),
    trialEnd: timestamp("trialEnd"),
    cancelAtPeriodEnd: boolean("cancelAtPeriodEnd").notNull().default(false),
    seats: integer("seats"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
    _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
    _version: integer("_version").notNull().default(0),
  },
  (table) => [
    index("idx_stripe_customer_id").on(table.stripeCustomerId),
    index("idx_stripe_subscription_id").on(table.stripeSubscriptionId),
  ],
);

export const fragno_db_settings = pgTable(
  "fragno_db_settings",
  {
    id: varchar("id", { length: 30 })
      .notNull()
      .$defaultFn(() => createId()),
    key: text("key").notNull(),
    value: text("value").notNull().default("1"),
    _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
    _version: integer("_version").notNull().default(0),
  },
  (table) => [uniqueIndex("unique_key").on(table.key)],
);
