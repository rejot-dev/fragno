import { beforeAll, describe, expect, it } from "vitest";

import { createRequire } from "node:module";

import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import { writeAndLoadSchema } from "./test-utils";

// I dunno
const require = createRequire(import.meta.url);
const { generateDrizzleJson, generateMigration } =
  require("drizzle-kit/api") as typeof import("drizzle-kit/api");

describe("generateSchema and migrate", () => {
  const testSchema = schema("test", (s) => {
    return s
      .addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("email", column("string"))
          .addColumn("age", column("integer").nullable())
          .addColumn("isActive", column("bool").defaultTo(true))
          .addColumn("bio", column("text").nullable())
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .addColumn(
            "updatedAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .createIndex("idx_users_email", ["email"], { unique: true })
          .createIndex("idx_users_name", ["name"])
          .createIndex("idx_users_active", ["isActive"]);
      })
      .addTable("posts", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("title", column("string"))
          .addColumn("slug", column("varchar(255)"))
          .addColumn("content", column("text"))
          .addColumn("excerpt", column("text").nullable())
          .addColumn("userId", referenceColumn({ table: "users" }))
          .addColumn("viewCount", column("integer").defaultTo(0))
          .addColumn("likeCount", column("bigint").defaultTo(9999999999999999n))
          .addColumn("isPublished", column("bool").defaultTo(false))
          .addColumn("publishedAt", column("timestamp").nullable())
          .addColumn("metadata", column("json").nullable())
          .addColumn("rating", column("decimal").nullable())
          .addColumn("thumbnail", column("binary").nullable())
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .createIndex("idx_posts_user", ["userId"])
          .createIndex("idx_posts_title", ["title"])
          .createIndex("idx_posts_slug", ["slug"], { unique: true })
          .createIndex("idx_posts_published", ["isPublished", "publishedAt"]);
      })
      .addTable("comments", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("content", column("text"))
          .addColumn("postId", referenceColumn({ table: "posts" }))
          .addColumn("userId", referenceColumn({ table: "users" }))
          .addColumn("parentId", referenceColumn({ table: "comments" }).nullable())
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .addColumn("editedAt", column("timestamp").nullable())
          .addColumn("isDeleted", column("bool").defaultTo(false))
          .createIndex("idx_comments_post", ["postId"])
          .createIndex("idx_comments_user", ["userId"])
          .createIndex("idx_comments_parent", ["parentId"]);
      })
      .addTable("tags", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("slug", column("varchar(100)"))
          .addColumn("description", column("text").nullable())
          .addColumn("color", column("varchar(7)").nullable())
          .addColumn("usageCount", column("bigint").defaultTo(0n))
          .createIndex("idx_tags_slug", ["slug"], { unique: true })
          .createIndex("idx_tags_name", ["name"]);
      })
      .addTable("postTags", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("postId", referenceColumn({ table: "posts" }))
          .addColumn("tagId", referenceColumn({ table: "tags" }))
          .addColumn("order", column("integer").defaultTo(0))
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .createIndex("idx_postTags_post_tag", ["postId", "tagId"], { unique: true })
          .createIndex("idx_postTags_tag", ["tagId"]);
      });
  });

  let schemaFilePath: string;

  beforeAll(async () => {
    // Write schema to file and dynamically import it
    const result = await writeAndLoadSchema("migrate-drizzle", testSchema, "postgresql");
    schemaFilePath = result.schemaFilePath;

    return async () => {
      await result.cleanup();
    };
  });

  it("should run migration using drizzle-kit", async () => {
    // Dynamically import the generated schema (with cache busting)
    const schemaModule = await import(`${schemaFilePath}?t=${Date.now()}`);

    const migrationStatements = await generateMigration(
      generateDrizzleJson({}), // Empty schema
      generateDrizzleJson(schemaModule),
    );

    expect(migrationStatements.join("\n")).toMatchInlineSnapshot(`
      "CREATE TABLE "fragno_db_settings" (
      \t"id" varchar(128) NOT NULL,
      \t"key" varchar(191) NOT NULL,
      \t"value" text NOT NULL,
      \t"_internalId" bigserial PRIMARY KEY NOT NULL,
      \t"_version" integer DEFAULT 0 NOT NULL,
      \t"_shard" varchar(191) DEFAULT '' NOT NULL
      );

      CREATE TABLE "fragno_hooks" (
      \t"id" varchar(128) NOT NULL,
      \t"namespace" varchar(191) NOT NULL,
      \t"hookName" varchar(191) NOT NULL,
      \t"payload" json NOT NULL,
      \t"status" varchar(191) NOT NULL,
      \t"attempts" integer DEFAULT 0 NOT NULL,
      \t"maxAttempts" integer DEFAULT 5 NOT NULL,
      \t"lastAttemptAt" timestamp,
      \t"nextRetryAt" timestamp,
      \t"error" text,
      \t"createdAt" timestamp DEFAULT now() NOT NULL,
      \t"nonce" varchar(191) NOT NULL,
      \t"_internalId" bigserial PRIMARY KEY NOT NULL,
      \t"_version" integer DEFAULT 0 NOT NULL,
      \t"_shard" varchar(191) DEFAULT '' NOT NULL,
      \t"propagationContext" json
      );

      CREATE TABLE "fragno_db_outbox" (
      \t"id" varchar(128) NOT NULL,
      \t"versionstamp" varchar(191) NOT NULL,
      \t"uowId" varchar(191) NOT NULL,
      \t"payload" json NOT NULL,
      \t"refMap" json,
      \t"createdAt" timestamp DEFAULT now() NOT NULL,
      \t"_internalId" bigserial PRIMARY KEY NOT NULL,
      \t"_version" integer DEFAULT 0 NOT NULL,
      \t"_shard" varchar(191) DEFAULT '' NOT NULL
      );

      CREATE TABLE "fragno_db_outbox_mutations" (
      \t"id" varchar(128) NOT NULL,
      \t"entryVersionstamp" varchar(191) NOT NULL,
      \t"mutationVersionstamp" varchar(191) NOT NULL,
      \t"uowId" varchar(191) NOT NULL,
      \t"schema" varchar(191) NOT NULL,
      \t"table" varchar(191) NOT NULL,
      \t"externalId" varchar(191),
      \t"op" varchar(191) NOT NULL,
      \t"createdAt" timestamp DEFAULT now() NOT NULL,
      \t"_internalId" bigserial PRIMARY KEY NOT NULL,
      \t"_version" integer DEFAULT 0 NOT NULL,
      \t"_shard" varchar(191) DEFAULT '' NOT NULL,
      \t"payload" json NOT NULL
      );

      CREATE TABLE "fragno_db_sync_requests" (
      \t"id" varchar(128) NOT NULL,
      \t"requestId" varchar(191) NOT NULL,
      \t"status" varchar(191) NOT NULL,
      \t"confirmedCommandIds" json NOT NULL,
      \t"conflictCommandId" varchar(191),
      \t"baseVersionstamp" varchar(191),
      \t"lastVersionstamp" varchar(191),
      \t"createdAt" timestamp DEFAULT now() NOT NULL,
      \t"_internalId" bigserial PRIMARY KEY NOT NULL,
      \t"_version" integer DEFAULT 0 NOT NULL,
      \t"_shard" varchar(191) DEFAULT '' NOT NULL
      );

      CREATE TABLE "test"."users" (
      \t"id" varchar(128) NOT NULL,
      \t"name" varchar(191) NOT NULL,
      \t"email" varchar(191) NOT NULL,
      \t"age" integer,
      \t"isActive" boolean DEFAULT true NOT NULL,
      \t"bio" text,
      \t"createdAt" timestamp DEFAULT now() NOT NULL,
      \t"updatedAt" timestamp DEFAULT now() NOT NULL,
      \t"_internalId" bigserial PRIMARY KEY NOT NULL,
      \t"_version" integer DEFAULT 0 NOT NULL,
      \t"_shard" varchar(191) DEFAULT '' NOT NULL
      );

      CREATE TABLE "test"."posts" (
      \t"id" varchar(128) NOT NULL,
      \t"title" varchar(191) NOT NULL,
      \t"slug" varchar(255) NOT NULL,
      \t"content" text NOT NULL,
      \t"excerpt" text,
      \t"userId" bigint NOT NULL,
      \t"viewCount" integer DEFAULT 0 NOT NULL,
      \t"likeCount" bigint DEFAULT 9999999999999999 NOT NULL,
      \t"isPublished" boolean DEFAULT false NOT NULL,
      \t"publishedAt" timestamp,
      \t"metadata" json,
      \t"rating" numeric,
      \t"thumbnail" "bytea",
      \t"createdAt" timestamp DEFAULT now() NOT NULL,
      \t"_internalId" bigserial PRIMARY KEY NOT NULL,
      \t"_version" integer DEFAULT 0 NOT NULL,
      \t"_shard" varchar(191) DEFAULT '' NOT NULL
      );

      CREATE TABLE "test"."comments" (
      \t"id" varchar(128) NOT NULL,
      \t"content" text NOT NULL,
      \t"postId" bigint NOT NULL,
      \t"userId" bigint NOT NULL,
      \t"parentId" bigint,
      \t"createdAt" timestamp DEFAULT now() NOT NULL,
      \t"editedAt" timestamp,
      \t"isDeleted" boolean DEFAULT false NOT NULL,
      \t"_internalId" bigserial PRIMARY KEY NOT NULL,
      \t"_version" integer DEFAULT 0 NOT NULL,
      \t"_shard" varchar(191) DEFAULT '' NOT NULL
      );

      CREATE TABLE "test"."tags" (
      \t"id" varchar(128) NOT NULL,
      \t"name" varchar(191) NOT NULL,
      \t"slug" varchar(100) NOT NULL,
      \t"description" text,
      \t"color" varchar(7),
      \t"usageCount" bigint DEFAULT 0 NOT NULL,
      \t"_internalId" bigserial PRIMARY KEY NOT NULL,
      \t"_version" integer DEFAULT 0 NOT NULL,
      \t"_shard" varchar(191) DEFAULT '' NOT NULL
      );

      CREATE TABLE "test"."postTags" (
      \t"id" varchar(128) NOT NULL,
      \t"postId" bigint NOT NULL,
      \t"tagId" bigint NOT NULL,
      \t"order" integer DEFAULT 0 NOT NULL,
      \t"createdAt" timestamp DEFAULT now() NOT NULL,
      \t"_internalId" bigserial PRIMARY KEY NOT NULL,
      \t"_version" integer DEFAULT 0 NOT NULL,
      \t"_shard" varchar(191) DEFAULT '' NOT NULL
      );

      ALTER TABLE "test"."posts" ADD CONSTRAINT "fk_posts_users_posts_userId_fk" FOREIGN KEY ("_shard","userId") REFERENCES "test"."users"("_shard","_internalId") ON DELETE no action ON UPDATE no action;
      ALTER TABLE "test"."comments" ADD CONSTRAINT "fk_comments_posts_comments_postId_fk" FOREIGN KEY ("_shard","postId") REFERENCES "test"."posts"("_shard","_internalId") ON DELETE no action ON UPDATE no action;
      ALTER TABLE "test"."comments" ADD CONSTRAINT "fk_comments_users_comments_userId_fk" FOREIGN KEY ("_shard","userId") REFERENCES "test"."users"("_shard","_internalId") ON DELETE no action ON UPDATE no action;
      ALTER TABLE "test"."comments" ADD CONSTRAINT "fk_comments_comments_comments_parentId_fk" FOREIGN KEY ("_shard","parentId") REFERENCES "test"."comments"("_shard","_internalId") ON DELETE no action ON UPDATE no action;
      ALTER TABLE "test"."postTags" ADD CONSTRAINT "fk_postTags_posts_postTags_postId_fk" FOREIGN KEY ("_shard","postId") REFERENCES "test"."posts"("_shard","_internalId") ON DELETE no action ON UPDATE no action;
      ALTER TABLE "test"."postTags" ADD CONSTRAINT "fk_postTags_tags_postTags_tagId_fk" FOREIGN KEY ("_shard","tagId") REFERENCES "test"."tags"("_shard","_internalId") ON DELETE no action ON UPDATE no action;
      CREATE UNIQUE INDEX "unique_key" ON "fragno_db_settings" USING btree ("_shard","key");
      CREATE UNIQUE INDEX "_fragno_fragno_db_settings_shard_external_id" ON "fragno_db_settings" USING btree ("_shard","id");
      CREATE UNIQUE INDEX "_fragno_fragno_db_settings_shard_internal_id" ON "fragno_db_settings" USING btree ("_shard","_internalId");
      CREATE INDEX "idx_namespace_status_retry" ON "fragno_hooks" USING btree ("_shard","namespace","status","nextRetryAt");
      CREATE INDEX "idx_nonce" ON "fragno_hooks" USING btree ("_shard","nonce");
      CREATE INDEX "idx_namespace_status_last_attempt" ON "fragno_hooks" USING btree ("_shard","namespace","status","lastAttemptAt");
      CREATE INDEX "idx_namespace_created_at" ON "fragno_hooks" USING btree ("_shard","namespace","createdAt","id");
      CREATE UNIQUE INDEX "_fragno_fragno_hooks_shard_external_id" ON "fragno_hooks" USING btree ("_shard","id");
      CREATE UNIQUE INDEX "_fragno_fragno_hooks_shard_internal_id" ON "fragno_hooks" USING btree ("_shard","_internalId");
      CREATE UNIQUE INDEX "idx_outbox_versionstamp" ON "fragno_db_outbox" USING btree ("_shard","versionstamp");
      CREATE INDEX "idx_outbox_uow" ON "fragno_db_outbox" USING btree ("_shard","uowId");
      CREATE UNIQUE INDEX "_fragno_fragno_db_outbox_shard_external_id" ON "fragno_db_outbox" USING btree ("_shard","id");
      CREATE UNIQUE INDEX "_fragno_fragno_db_outbox_shard_internal_id" ON "fragno_db_outbox" USING btree ("_shard","_internalId");
      CREATE INDEX "idx_outbox_mutations_entry" ON "fragno_db_outbox_mutations" USING btree ("_shard","entryVersionstamp");
      CREATE INDEX "idx_outbox_mutations_key" ON "fragno_db_outbox_mutations" USING btree ("_shard","schema","table","externalId","entryVersionstamp");
      CREATE INDEX "idx_outbox_mutations_uow" ON "fragno_db_outbox_mutations" USING btree ("_shard","uowId");
      CREATE INDEX "idx_outbox_mutations_entry_order" ON "fragno_db_outbox_mutations" USING btree ("_shard","entryVersionstamp","mutationVersionstamp");
      CREATE UNIQUE INDEX "_fragno_fragno_db_outbox_mutations_shard_external_id" ON "fragno_db_outbox_mutations" USING btree ("_shard","id");
      CREATE UNIQUE INDEX "_fragno_fragno_db_outbox_mutations_shard_internal_id" ON "fragno_db_outbox_mutations" USING btree ("_shard","_internalId");
      CREATE UNIQUE INDEX "idx_sync_request_id" ON "fragno_db_sync_requests" USING btree ("_shard","requestId");
      CREATE UNIQUE INDEX "_fragno_fragno_db_sync_requests_shard_external_id" ON "fragno_db_sync_requests" USING btree ("_shard","id");
      CREATE UNIQUE INDEX "_fragno_fragno_db_sync_requests_shard_internal_id" ON "fragno_db_sync_requests" USING btree ("_shard","_internalId");
      CREATE UNIQUE INDEX "idx_users_email" ON "test"."users" USING btree ("_shard","email");
      CREATE INDEX "idx_users_name" ON "test"."users" USING btree ("_shard","name");
      CREATE INDEX "idx_users_active" ON "test"."users" USING btree ("_shard","isActive");
      CREATE UNIQUE INDEX "_fragno_users_shard_external_id" ON "test"."users" USING btree ("_shard","id");
      CREATE UNIQUE INDEX "_fragno_users_shard_internal_id" ON "test"."users" USING btree ("_shard","_internalId");
      CREATE INDEX "idx_posts_user" ON "test"."posts" USING btree ("_shard","userId");
      CREATE INDEX "idx_posts_title" ON "test"."posts" USING btree ("_shard","title");
      CREATE UNIQUE INDEX "idx_posts_slug" ON "test"."posts" USING btree ("_shard","slug");
      CREATE INDEX "idx_posts_published" ON "test"."posts" USING btree ("_shard","isPublished","publishedAt");
      CREATE UNIQUE INDEX "_fragno_posts_shard_external_id" ON "test"."posts" USING btree ("_shard","id");
      CREATE UNIQUE INDEX "_fragno_posts_shard_internal_id" ON "test"."posts" USING btree ("_shard","_internalId");
      CREATE INDEX "idx_comments_post" ON "test"."comments" USING btree ("_shard","postId");
      CREATE INDEX "idx_comments_user" ON "test"."comments" USING btree ("_shard","userId");
      CREATE INDEX "idx_comments_parent" ON "test"."comments" USING btree ("_shard","parentId");
      CREATE UNIQUE INDEX "_fragno_comments_shard_external_id" ON "test"."comments" USING btree ("_shard","id");
      CREATE UNIQUE INDEX "_fragno_comments_shard_internal_id" ON "test"."comments" USING btree ("_shard","_internalId");
      CREATE UNIQUE INDEX "idx_tags_slug" ON "test"."tags" USING btree ("_shard","slug");
      CREATE INDEX "idx_tags_name" ON "test"."tags" USING btree ("_shard","name");
      CREATE UNIQUE INDEX "_fragno_tags_shard_external_id" ON "test"."tags" USING btree ("_shard","id");
      CREATE UNIQUE INDEX "_fragno_tags_shard_internal_id" ON "test"."tags" USING btree ("_shard","_internalId");
      CREATE UNIQUE INDEX "idx_postTags_post_tag" ON "test"."postTags" USING btree ("_shard","postId","tagId");
      CREATE INDEX "idx_postTags_tag" ON "test"."postTags" USING btree ("_shard","tagId");
      CREATE UNIQUE INDEX "_fragno_postTags_shard_external_id" ON "test"."postTags" USING btree ("_shard","id");
      CREATE UNIQUE INDEX "_fragno_postTags_shard_internal_id" ON "test"."postTags" USING btree ("_shard","_internalId");"
    `);
  });
});
