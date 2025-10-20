import {
  pgTable,
  varchar,
  text,
  timestamp,
  bigint,
  bigserial,
  integer,
  foreignKey,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createId } from "@fragno-dev/db/id";
import { relations } from "drizzle-orm";

export const comment = pgTable(
  "comment",
  {
    id: varchar("id", { length: 30 })
      .notNull()
      .$defaultFn(() => createId()),
    title: text("title").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    postReference: text("postReference").notNull(),
    userReference: text("userReference").notNull(),
    parentId: bigint("parentId", { mode: "number" }),
    _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
    _version: integer("_version").notNull().default(0),
    rating: integer("rating").notNull().default(0),
  },
  (table) => [
    foreignKey({
      columns: [table.parentId],
      foreignColumns: [table._internalId],
      name: "comment_comment_parent_fk",
    }),
  ],
);

export const commentRelations = relations(comment, ({ one }) => ({
  parent: one(comment, {
    relationName: "comment_comment",
    fields: [comment.parentId],
    references: [comment._internalId],
  }),
}));

export const fragno_db_settings = pgTable(
  "fragno_db_settings",
  {
    id: varchar("id", { length: 30 })
      .notNull()
      .$defaultFn(() => createId()),
    key: text("key").notNull(),
    value: text("value").notNull().default("3"),
    _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
    _version: integer("_version").notNull().default(0),
  },
  (table) => [uniqueIndex("unique_key").on(table.key)],
);
