import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { comment_schema, upvote_schema, auth_schema, workflows_schema } from "./fragno-schema";

export const appUser = pgTable("user", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const blogPost = pgTable("blog_post", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  authorId: integer("author_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Runtime schema object for drizzle-orm
export const schema = {
  ...comment_schema,
  ...upvote_schema,
  ...auth_schema,
  ...workflows_schema,
  appUser,
  blogPost,
};
