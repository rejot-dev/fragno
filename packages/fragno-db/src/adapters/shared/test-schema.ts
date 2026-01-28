/**
 * Shared test schema for database adapter integration tests.
 *
 * This schema provides tables for testing all common database operations:
 * - Basic CRUD operations (users table)
 * - Foreign key references (emails -> users, posts -> users)
 * - Complex nested joins (comments -> posts -> users)
 * - Many-to-many relationships (posts <-> tags via post_tags)
 */
import { column, idColumn, referenceColumn, schema } from "../../schema/create";

/**
 * Create the standard test schema used across all adapter integration tests.
 *
 * Tables:
 * - users: Basic table with id, name, age (nullable integer)
 * - emails: References users, tests foreign keys and boolean columns
 * - posts: References users as author, used for nested join tests
 * - comments: References both posts and users, enables complex nested joins
 * - tags: Simple table for many-to-many relationship testing
 * - post_tags: Junction table for posts <-> tags many-to-many
 */
export const testSchema = schema((s) => {
  return s
    .addTable("users", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("age", column("integer").nullable())
        .createIndex("name_idx", ["name"])
        .createIndex("age_idx", ["age"]);
    })
    .addTable("emails", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("user_id", referenceColumn())
        .addColumn("email", column("string"))
        .addColumn("is_primary", column("bool").defaultTo(false))
        .createIndex("unique_email", ["email"], { unique: true })
        .createIndex("user_emails", ["user_id"]);
    })
    .addTable("posts", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("user_id", referenceColumn())
        .addColumn("title", column("string"))
        .addColumn("content", column("string"))
        .createIndex("posts_user_idx", ["user_id"]);
    })
    .addTable("tags", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .createIndex("tag_name", ["name"]);
    })
    .addTable("post_tags", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("post_id", referenceColumn())
        .addColumn("tag_id", referenceColumn())
        .createIndex("pt_post", ["post_id"])
        .createIndex("pt_tag", ["tag_id"]);
    })
    .addTable("comments", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("post_id", referenceColumn())
        .addColumn("user_id", referenceColumn())
        .addColumn("text", column("string"))
        .createIndex("comments_post_idx", ["post_id"])
        .createIndex("comments_user_idx", ["user_id"]);
    })
    .addReference("user", {
      type: "one",
      from: { table: "emails", column: "user_id" },
      to: { table: "users", column: "id" },
    })
    .addReference("author", {
      type: "one",
      from: { table: "posts", column: "user_id" },
      to: { table: "users", column: "id" },
    })
    .addReference("post", {
      type: "one",
      from: { table: "post_tags", column: "post_id" },
      to: { table: "posts", column: "id" },
    })
    .addReference("tag", {
      type: "one",
      from: { table: "post_tags", column: "tag_id" },
      to: { table: "tags", column: "id" },
    })
    .addReference("post", {
      type: "one",
      from: { table: "comments", column: "post_id" },
      to: { table: "posts", column: "id" },
    })
    .addReference("commenter", {
      type: "one",
      from: { table: "comments", column: "user_id" },
      to: { table: "users", column: "id" },
    });
});

export type TestSchema = typeof testSchema;
