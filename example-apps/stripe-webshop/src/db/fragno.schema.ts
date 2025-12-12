import {
  pgTable,
  varchar,
  text,
  bigserial,
  integer,
  uniqueIndex,
  timestamp,
  boolean,
  index,
  json,
  bigint,
  foreignKey,
} from "drizzle-orm/pg-core";
import { createId } from "@fragno-dev/db/id";
import { relations } from "drizzle-orm";

// ============================================================================
// Fragment:
// ============================================================================

export const fragno_db_settings = pgTable(
  "fragno_db_settings",
  {
    id: varchar("id", { length: 30 })
      .notNull()
      .$defaultFn(() => createId()),
    key: text("key").notNull(),
    value: text("value").notNull(),
    _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
    _version: integer("_version").notNull().default(0),
  },
  (table) => [uniqueIndex("unique_key").on(table.key)],
);

// ============================================================================
// Fragment: stripe
// ============================================================================

export const subscription_stripe = pgTable(
  "subscription_stripe",
  {
    id: varchar("id", { length: 30 })
      .notNull()
      .$defaultFn(() => createId()),
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
    _version: integer("_version").notNull().default(0),
  },
  (table) => [
    index("idx_stripe_customer_id_stripe").on(table.stripeCustomerId),
    index("idx_stripe_subscription_id_stripe").on(table.stripeSubscriptionId),
    index("idx_reference_id_stripe").on(table.referenceId),
  ],
);

export const stripe_schema = {
  subscription_stripe: subscription_stripe,
  subscription: subscription_stripe,
  schemaVersion: 1,
};

// ============================================================================
// Fragment: forms
// ============================================================================

export const form_forms = pgTable(
  "form_forms",
  {
    id: varchar("id", { length: 30 })
      .notNull()
      .$defaultFn(() => createId()),
    title: text("title").notNull(),
    description: text("description"),
    slug: text("slug").notNull(),
    status: text("status").notNull().default("draft"),
    dataSchema: json("dataSchema").notNull(),
    uiSchema: json("uiSchema").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
    _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
    _version: integer("_version").notNull().default(0),
  },
  (table) => [
    index("idx_form_status_forms").on(table.status),
    uniqueIndex("idx_form_slug_forms").on(table.slug),
  ],
);

export const response_forms = pgTable(
  "response_forms",
  {
    id: varchar("id", { length: 30 })
      .notNull()
      .$defaultFn(() => createId()),
    formId: bigint("formId", { mode: "number" }).notNull(),
    formVersion: integer("formVersion").notNull(),
    data: json("data").notNull(),
    submittedAt: timestamp("submittedAt").notNull().defaultNow(),
    userAgent: text("userAgent"),
    ip: text("ip"),
    _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
    _version: integer("_version").notNull().default(0),
  },
  (table) => [
    foreignKey({
      columns: [table.formId],
      foreignColumns: [form_forms._internalId],
      name: "fk_response_form_responseForm_forms",
    }),
    index("idx_response_form_forms").on(table.formId),
    index("idx_response_submitted_at_forms").on(table.submittedAt),
  ],
);

export const form_formsRelations = relations(form_forms, ({ many }) => ({
  responseList: many(response_forms, {
    relationName: "response_form",
  }),
}));

export const response_formsRelations = relations(response_forms, ({ one }) => ({
  responseForm: one(form_forms, {
    relationName: "response_form",
    fields: [response_forms.formId],
    references: [form_forms._internalId],
  }),
}));

export const forms_schema = {
  form_forms: form_forms,
  form_formsRelations: form_formsRelations,
  form: form_forms,
  formRelations: form_formsRelations,
  response_forms: response_forms,
  response_formsRelations: response_formsRelations,
  response: response_forms,
  responseRelations: response_formsRelations,
  schemaVersion: 3,
};
