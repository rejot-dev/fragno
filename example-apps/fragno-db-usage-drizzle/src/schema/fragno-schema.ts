import { pgTable, varchar, text, bigserial, integer, uniqueIndex, timestamp, bigint, foreignKey, index } from "drizzle-orm/pg-core"
import { createId } from "@fragno-dev/db/id"
import { relations } from "drizzle-orm"

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
// Fragment: fragno-db-comment-db
// ============================================================================

export const comment_fragno_db_comment_db = pgTable("comment_fragno_db_comment_db", {
  id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
  title: text("title").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  postReference: text("postReference").notNull(),
  userReference: text("userReference").notNull(),
  parentId: bigint("parentId", { mode: "number" }),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0),
  rating: integer("rating").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.parentId],
    foreignColumns: [table._internalId],
    name: "fk_comment_comment_parent_fragno_db_comment_db"
  }),
  index("idx_comment_post_fragno-db-comment-db").on(table.postReference)
])

export const comment_fragno_db_comment_dbRelations = relations(comment_fragno_db_comment_db, ({ one, many }) => ({
  parent: one(comment_fragno_db_comment_db, {
    relationName: "comment_comment",
    fields: [comment_fragno_db_comment_db.parentId],
    references: [comment_fragno_db_comment_db._internalId]
  }),
  commentList: many(comment_fragno_db_comment_db, {
    relationName: "comment_comment"
  })
}));

export const fragno_db_comment_db_schema = {
  comment_fragno_db_comment_db: comment_fragno_db_comment_db,
  comment_fragno_db_comment_dbRelations: comment_fragno_db_comment_dbRelations,
  comment: comment_fragno_db_comment_db,
  commentRelations: comment_fragno_db_comment_dbRelations,
  schemaVersion: 3
}

// ============================================================================
// Fragment: fragno-db-rating-db
// ============================================================================

export const upvote_fragno_db_rating_db = pgTable("upvote_fragno_db_rating_db", {
  id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
  reference: text("reference").notNull(),
  ownerReference: text("ownerReference"),
  rating: integer("rating").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  note: text("note"),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  index("idx_upvote_reference_fragno-db-rating-db").on(table.reference, table.ownerReference)
])

export const upvote_total_fragno_db_rating_db = pgTable("upvote_total_fragno_db_rating_db", {
  id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
  reference: text("reference").notNull(),
  total: integer("total").notNull().default(0),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("idx_upvote_total_reference_fragno-db-rating-db").on(table.reference)
])

export const fragno_db_rating_db_schema = {
  upvote_fragno_db_rating_db: upvote_fragno_db_rating_db,
  upvote: upvote_fragno_db_rating_db,
  upvote_total_fragno_db_rating_db: upvote_total_fragno_db_rating_db,
  upvote_total: upvote_total_fragno_db_rating_db,
  schemaVersion: 2
}

// ============================================================================
// Fragment: simple-auth-db
// ============================================================================

export const user_simple_auth_db = pgTable("user_simple_auth_db", {
  id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
  email: text("email").notNull(),
  passwordHash: text("passwordHash").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  index("idx_user_email_simple-auth-db").on(table.email)
])

export const session_simple_auth_db = pgTable("session_simple_auth_db", {
  id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
  userId: bigint("userId", { mode: "number" }).notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.userId],
    foreignColumns: [user_simple_auth_db._internalId],
    name: "fk_session_user_sessionOwner_simple_auth_db"
  }),
  index("idx_session_user_simple-auth-db").on(table.userId)
])

export const user_simple_auth_dbRelations = relations(user_simple_auth_db, ({ many }) => ({
  sessionList: many(session_simple_auth_db, {
    relationName: "session_user"
  })
}));

export const session_simple_auth_dbRelations = relations(session_simple_auth_db, ({ one }) => ({
  sessionOwner: one(user_simple_auth_db, {
    relationName: "session_user",
    fields: [session_simple_auth_db.userId],
    references: [user_simple_auth_db._internalId]
  })
}));

export const simple_auth_db_schema = {
  user_simple_auth_db: user_simple_auth_db,
  user_simple_auth_dbRelations: user_simple_auth_dbRelations,
  user: user_simple_auth_db,
  userRelations: user_simple_auth_dbRelations,
  session_simple_auth_db: session_simple_auth_db,
  session_simple_auth_dbRelations: session_simple_auth_dbRelations,
  session: session_simple_auth_db,
  sessionRelations: session_simple_auth_dbRelations,
  schemaVersion: 3
}