import { sqliteTable, text, integer, uniqueIndex, blob, index } from "drizzle-orm/sqlite-core";
import { createId } from "@fragno-dev/db/id";

// ============================================================================
// Fragment:
// ============================================================================

export const fragno_db_settings = sqliteTable(
  "fragno_db_settings",
  {
    id: text("id")
      .notNull()
      .$defaultFn(() => createId()),
    key: text("key").notNull(),
    value: text("value").notNull(),
    _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
    _version: integer("_version").notNull().default(0),
  },
  (table) => [uniqueIndex("unique_key").on(table.key)],
);

// ============================================================================
// Fragment: forms
// ============================================================================

export const form_forms = sqliteTable(
  "form_forms",
  {
    id: text("id")
      .notNull()
      .$defaultFn(() => createId()),
    title: text("title").notNull(),
    description: text("description"),
    slug: text("slug").notNull(),
    status: text("status").notNull().default("draft"),
    dataSchema: blob("dataSchema", { mode: "json" }).notNull(),
    uiSchema: blob("uiSchema", { mode: "json" }).notNull(),
    version: integer("version").notNull().default(1),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull().defaultNow(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().defaultNow(),
    _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
    _version: integer("_version").notNull().default(0),
  },
  (table) => [
    index("idx_form_status_forms").on(table.status),
    uniqueIndex("idx_form_slug_forms").on(table.slug),
  ],
);

export const response_forms = sqliteTable(
  "response_forms",
  {
    id: text("id")
      .notNull()
      .$defaultFn(() => createId()),
    formId: text("formId"),
    formVersion: integer("formVersion").notNull(),
    data: blob("data", { mode: "json" }).notNull(),
    submittedAt: integer("submittedAt", { mode: "timestamp" }).notNull().defaultNow(),
    userAgent: text("userAgent"),
    ip: text("ip"),
    _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
    _version: integer("_version").notNull().default(0),
  },
  (table) => [
    index("idx_response_form_forms").on(table.formId),
    index("idx_response_submitted_at_forms").on(table.submittedAt),
  ],
);

export const forms_schema = {
  form_forms: form_forms,
  form: form_forms,
  response_forms: response_forms,
  response: response_forms,
  schemaVersion: 2,
};

// ============================================================================
// Fragment: mailing-list
// ============================================================================

export const subscriber_mailing_list = sqliteTable(
  "subscriber_mailing-list",
  {
    id: text("id")
      .notNull()
      .$defaultFn(() => createId()),
    email: text("email").notNull(),
    subscribedAt: integer("subscribedAt", { mode: "timestamp" }).notNull().defaultNow(),
    _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
    _version: integer("_version").notNull().default(0),
  },
  (table) => [
    index("idx_subscriber_email_mailing-list").on(table.email),
    index("idx_subscriber_subscribedAt_mailing-list").on(table.subscribedAt),
  ],
);

export const mailing_list_schema = {
  subscriber_mailing_list: subscriber_mailing_list,
  subscriber: subscriber_mailing_list,
  schemaVersion: 1,
};
