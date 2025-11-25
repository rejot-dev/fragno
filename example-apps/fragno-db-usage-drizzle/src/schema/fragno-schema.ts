import { pgTable, varchar, text, bigserial, integer, uniqueIndex, timestamp, bigint, foreignKey, index } from "drizzle-orm/pg-core"
import { createId } from "@fragno-dev/db/id"
import { relations } from "drizzle-orm"

// ============================================================================
// Fragment: 
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

// ============================================================================
// Fragment: fragno-db-comment
// ============================================================================

export const comment_fragno_db_comment = pgTable("comment_fragno_db_comment", {
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
    name: "fk_comment_comment_parent_fragno_db_comment"
  }),
  index("idx_comment_post_fragno-db-comment").on(table.postReference)
])

export const comment_fragno_db_commentRelations = relations(comment_fragno_db_comment, ({ one, many }) => ({
  parent: one(comment_fragno_db_comment, {
    relationName: "comment_comment",
    fields: [comment_fragno_db_comment.parentId],
    references: [comment_fragno_db_comment._internalId]
  }),
  commentList: many(comment_fragno_db_comment, {
    relationName: "comment_comment"
  })
}));

export const fragno_db_comment_schema = {
  comment_fragno_db_comment: comment_fragno_db_comment,
  comment_fragno_db_commentRelations: comment_fragno_db_commentRelations,
  comment: comment_fragno_db_comment,
  commentRelations: comment_fragno_db_commentRelations,
  schemaVersion: 3
}

// ============================================================================
// Fragment: fragno-db-rating
// ============================================================================

export const upvote_fragno_db_rating = pgTable("upvote_fragno_db_rating", {
  id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
  reference: text("reference").notNull(),
  ownerReference: text("ownerReference"),
  rating: integer("rating").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  note: text("note"),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  index("idx_upvote_reference_fragno-db-rating").on(table.reference, table.ownerReference)
])

export const upvote_total_fragno_db_rating = pgTable("upvote_total_fragno_db_rating", {
  id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
  reference: text("reference").notNull(),
  total: integer("total").notNull().default(0),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("idx_upvote_total_reference_fragno-db-rating").on(table.reference)
])

export const fragno_db_rating_schema = {
  upvote_fragno_db_rating: upvote_fragno_db_rating,
  upvote: upvote_fragno_db_rating,
  upvote_total_fragno_db_rating: upvote_total_fragno_db_rating,
  upvote_total: upvote_total_fragno_db_rating,
  schemaVersion: 2
}

// ============================================================================
// Fragment: simple-auth
// ============================================================================

export const user_simple_auth = pgTable("user_simple_auth", {
  id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
  email: text("email").notNull(),
  passwordHash: text("passwordHash").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  index("idx_user_email_simple-auth").on(table.email)
])

export const session_simple_auth = pgTable("session_simple_auth", {
  id: varchar("id", { length: 30 }).notNull().$defaultFn(() => createId()),
  userId: bigint("userId", { mode: "number" }).notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.userId],
    foreignColumns: [user_simple_auth._internalId],
    name: "fk_session_user_sessionOwner_simple_auth"
  }),
  index("idx_session_user_simple-auth").on(table.userId)
])

export const user_simple_authRelations = relations(user_simple_auth, ({ many }) => ({
  sessionList: many(session_simple_auth, {
    relationName: "session_user"
  })
}));

export const session_simple_authRelations = relations(session_simple_auth, ({ one }) => ({
  sessionOwner: one(user_simple_auth, {
    relationName: "session_user",
    fields: [session_simple_auth.userId],
    references: [user_simple_auth._internalId]
  })
}));

export const simple_auth_schema = {
  user_simple_auth: user_simple_auth,
  user_simple_authRelations: user_simple_authRelations,
  user: user_simple_auth,
  userRelations: user_simple_authRelations,
  session_simple_auth: session_simple_auth,
  session_simple_authRelations: session_simple_authRelations,
  session: session_simple_auth,
  sessionRelations: session_simple_authRelations,
  schemaVersion: 3
}