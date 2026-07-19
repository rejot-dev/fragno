import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  comment_schema,
  upvote_schema,
  auth_schema,
  workflows_schema,
} from "./fragno-schema.sqlite";

export const user = sqliteTable("user", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull(),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(cast((julianday('now') - 2440587.5)*86400000 as integer))`).notNull(),
});

export const blogPost = sqliteTable("blog_post", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  content: text("content").notNull(),
  authorId: integer("author_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(cast((julianday('now') - 2440587.5)*86400000 as integer))`).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(sql`(cast((julianday('now') - 2440587.5)*86400000 as integer))`).notNull(),
});

// Runtime schema object for drizzle-orm
export const schema = {
  ...comment_schema,
  ...upvote_schema,
  ...auth_schema,
  ...workflows_schema,
  user,
  blogPost,
};
