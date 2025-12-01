import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";
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
// Fragment: mailing-list
// ============================================================================

export const subscriber_mailing_list = sqliteTable(
  "subscriber_mailing_list",
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
