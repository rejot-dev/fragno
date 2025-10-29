import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import {
  fragno_db_rating_db_schema,
  fragno_db_comment_db_schema,
  simple_auth_db_schema,
} from "./fragno-schema";

export const user = pgTable("user", {
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
  ...fragno_db_comment_db_schema,
  ...fragno_db_rating_db_schema,
  ...simple_auth_db_schema,
  user,
  blogPost,
};
