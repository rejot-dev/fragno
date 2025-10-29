import { pgTable, varchar, text, bigserial, integer, uniqueIndex, timestamp, boolean, index } from "drizzle-orm/pg-core"
import { createId } from "@fragno-dev/db/id"

// ============================================================================
// Settings Table (shared across all fragments)
// ============================================================================

export const fragno_db_settings = pgTable("fragno_db_settings", {
  id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
  key: text("key").notNull(),
  value: text("value").notNull(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("unique_key").on(table.key)
])

export const fragnoDbSettingSchemaVersion = 1;

// ============================================================================
// Fragment: stripe
// ============================================================================

export const subscription_stripe = pgTable("subscription_stripe", {
  id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
  referenceId: text("referenceId"),
  stripePriceId: text("stripePriceId").notNull(),
  stripeCustomerId: text("stripeCustomerId").notNull(),
  stripeSubscriptionId: text("stripeSubscriptionId").notNull(),
  status: text("status").notNull().default("incomplete"),
  periodStart: timestamp("periodStart"),
  periodEnd: timestamp("periodEnd"),
  trialStart: timestamp("trialStart"),
  trialEnd: timestamp("trialEnd"),
  cancelAtPeriodEnd: boolean("cancelAtPeriodEnd").notNull().default(false),
  cancelAt: timestamp("cancelAt"),
  seats: integer("seats"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  index("idx_stripe_customer_id_stripe").on(table.stripeCustomerId),
  index("idx_stripe_subscription_id_stripe").on(table.stripeSubscriptionId),
  index("idx_reference_id_stripe").on(table.referenceId)
])

export const stripe_schema = {
  subscription_stripe: subscription_stripe,
  subscription: subscription_stripe,
  schemaVersion: 1
}