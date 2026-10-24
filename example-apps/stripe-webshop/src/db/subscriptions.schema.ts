import { pgTable, varchar, text, bigserial, integer, uniqueIndex, json, timestamp, index, pgSchema, boolean } from "drizzle-orm/pg-core"
import { createId } from "@fragno-dev/db/id"

// ============================================================================
// Fragment: (none)
// ============================================================================

export const fragno_db_settings = pgTable("fragno_db_settings", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  key: varchar("key", { length: 191 }).notNull(),
  value: text("value").notNull(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("unique_key").on(table.key)
])

export const fragno_hooks = pgTable("fragno_hooks", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  namespace: varchar("namespace", { length: 191 }).notNull(),
  hookName: varchar("hookName", { length: 191 }).notNull(),
  payload: json("payload").notNull(),
  status: varchar("status", { length: 191 }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("maxAttempts").notNull().default(5),
  lastAttemptAt: timestamp("lastAttemptAt"),
  nextRetryAt: timestamp("nextRetryAt"),
  error: text("error"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  nonce: varchar("nonce", { length: 191 }).notNull(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0),
  propagationContext: json("propagationContext")
}, (table) => [
  index("idx_namespace_status_retry").on(table.namespace, table.status, table.nextRetryAt),
  index("idx_nonce").on(table.nonce),
  index("idx_namespace_status_last_attempt").on(table.namespace, table.status, table.lastAttemptAt),
  index("idx_namespace_created_at").on(table.namespace, table.createdAt, table.id)
])

export const fragno_db_outbox = pgTable("fragno_db_outbox", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  versionstamp: varchar("versionstamp", { length: 191 }).notNull(),
  uowId: varchar("uowId", { length: 191 }).notNull(),
  payload: json("payload").notNull(),
  refMap: json("refMap"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("idx_outbox_versionstamp").on(table.versionstamp),
  index("idx_outbox_uow").on(table.uowId)
])

export const fragno_db_outbox_mutations = pgTable("fragno_db_outbox_mutations", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  entryVersionstamp: varchar("entryVersionstamp", { length: 191 }).notNull(),
  mutationVersionstamp: varchar("mutationVersionstamp", { length: 191 }).notNull(),
  uowId: varchar("uowId", { length: 191 }).notNull(),
  schema: varchar("schema", { length: 191 }).notNull(),
  table: varchar("table", { length: 191 }).notNull(),
  externalId: varchar("externalId", { length: 191 }),
  op: varchar("op", { length: 191 }).notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0),
  payload: json("payload").notNull()
}, (table) => [
  index("idx_outbox_mutations_entry").on(table.entryVersionstamp),
  index("idx_outbox_mutations_key").on(table.schema, table.table, table.externalId, table.entryVersionstamp),
  index("idx_outbox_mutations_uow").on(table.uowId),
  index("idx_outbox_mutations_entry_order").on(table.entryVersionstamp, table.mutationVersionstamp)
])

export const fragno_db_sync_requests = pgTable("fragno_db_sync_requests", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  requestId: varchar("requestId", { length: 191 }).notNull(),
  status: varchar("status", { length: 191 }).notNull(),
  confirmedCommandIds: json("confirmedCommandIds").notNull(),
  conflictCommandId: varchar("conflictCommandId", { length: 191 }),
  baseVersionstamp: varchar("baseVersionstamp", { length: 191 }),
  lastVersionstamp: varchar("lastVersionstamp", { length: 191 }),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("idx_sync_request_id").on(table.requestId)
])

// ============================================================================
// Fragment: stripe
// ============================================================================

const schema_stripe = pgSchema("stripe");

export const customer_stripe = schema_stripe.table("customer", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  referenceId: varchar("referenceId", { length: 191 }).notNull(),
  linkedAt: timestamp("linkedAt").notNull().defaultNow(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("idx_customer_reference_id").on(table.referenceId)
])

export const subscription_stripe = schema_stripe.table("subscription", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  customerId: varchar("customerId", { length: 191 }).notNull(),
  referenceId: varchar("referenceId", { length: 191 }),
  itemId: varchar("itemId", { length: 191 }).notNull(),
  priceId: varchar("priceId", { length: 191 }).notNull(),
  quantity: integer("quantity"),
  status: varchar("status", { length: 191 }).notNull(),
  currentPeriodStart: timestamp("currentPeriodStart").notNull(),
  currentPeriodEnd: timestamp("currentPeriodEnd").notNull(),
  trialStart: timestamp("trialStart"),
  trialEnd: timestamp("trialEnd"),
  cancelAtPeriodEnd: boolean("cancelAtPeriodEnd").notNull(),
  cancelAt: timestamp("cancelAt"),
  canceledAt: timestamp("canceledAt"),
  endedAt: timestamp("endedAt"),
  createdAt: timestamp("createdAt").notNull(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  index("idx_subscription_customer_id").on(table.customerId),
  index("idx_subscription_reference_id").on(table.referenceId)
])

export const stripe_schema = {
  customer_stripe: customer_stripe,
  customer: customer_stripe,
  subscription_stripe: subscription_stripe,
  subscription: subscription_stripe,
  schemaVersion: 2
}