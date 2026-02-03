import { int, mysqlTable, serial, text, timestamp } from "drizzle-orm/mysql-core";
import {
  comment_schema,
  upvote_schema,
  auth_schema,
  workflows_schema,
} from "./fragno-schema.mysql";

export const user = mysqlTable("user", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const blogPost = mysqlTable("blog_post", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  authorId: int("author_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
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
