import { beforeAll, describe, expect, it } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import { createRequire } from "node:module";
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
          .addColumn("bio", column("string").nullable())
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
          .addColumn("content", column("string"))
          .addColumn("excerpt", column("string").nullable())
          .addColumn("userId", referenceColumn())
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
          .addColumn("content", column("string"))
          .addColumn("postId", referenceColumn())
          .addColumn("userId", referenceColumn())
          .addColumn("parentId", referenceColumn().nullable())
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
          .addColumn("description", column("string").nullable())
          .addColumn("color", column("varchar(7)").nullable())
          .addColumn("usageCount", column("bigint").defaultTo(0n))
          .createIndex("idx_tags_slug", ["slug"], { unique: true })
          .createIndex("idx_tags_name", ["name"]);
      })
      .addTable("postTags", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("postId", referenceColumn())
          .addColumn("tagId", referenceColumn())
          .addColumn("order", column("integer").defaultTo(0))
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .createIndex("idx_postTags_post_tag", ["postId", "tagId"], { unique: true })
          .createIndex("idx_postTags_tag", ["tagId"]);
      })
      .addReference("author", {
        type: "one",
        from: { table: "posts", column: "userId" },
        to: { table: "users", column: "id" },
      })
      .addReference("post", {
        type: "one",
        from: { table: "comments", column: "postId" },
        to: { table: "posts", column: "id" },
      })
      .addReference("author", {
        type: "one",
        from: { table: "comments", column: "userId" },
        to: { table: "users", column: "id" },
      })
      .addReference("parent", {
        type: "one",
        from: { table: "comments", column: "parentId" },
        to: { table: "comments", column: "id" },
      })
      .addReference("post", {
        type: "one",
        from: { table: "postTags", column: "postId" },
        to: { table: "posts", column: "id" },
      })
      .addReference("tag", {
        type: "one",
        from: { table: "postTags", column: "tagId" },
        to: { table: "tags", column: "id" },
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
      	"id" varchar(30) NOT NULL,
      	"key" text NOT NULL,
      	"value" text NOT NULL,
      	"_internalId" bigserial PRIMARY KEY NOT NULL,
      	"_version" integer DEFAULT 0 NOT NULL,
      	"_shard" text,
      	CONSTRAINT "fragno_db_settings_id_unique" UNIQUE("id")
      );

      CREATE TABLE "fragno_hooks" (
      	"id" varchar(30) NOT NULL,
      	"namespace" text NOT NULL,
      	"hookName" text NOT NULL,
      	"payload" json NOT NULL,
      	"status" text NOT NULL,
      	"attempts" integer DEFAULT 0 NOT NULL,
      	"maxAttempts" integer DEFAULT 5 NOT NULL,
      	"lastAttemptAt" timestamp,
      	"nextRetryAt" timestamp,
      	"error" text,
      	"createdAt" timestamp DEFAULT now() NOT NULL,
      	"nonce" text NOT NULL,
      	"_shard" text,
      	"_internalId" bigserial PRIMARY KEY NOT NULL,
      	"_version" integer DEFAULT 0 NOT NULL,
      	CONSTRAINT "fragno_hooks_id_unique" UNIQUE("id")
      );

      CREATE TABLE "fragno_db_outbox" (
      	"id" varchar(30) NOT NULL,
      	"versionstamp" text NOT NULL,
      	"uowId" text NOT NULL,
      	"payload" json NOT NULL,
      	"refMap" json,
      	"createdAt" timestamp DEFAULT now() NOT NULL,
      	"_shard" text,
      	"_internalId" bigserial PRIMARY KEY NOT NULL,
      	"_version" integer DEFAULT 0 NOT NULL,
      	CONSTRAINT "fragno_db_outbox_id_unique" UNIQUE("id")
      );

      CREATE TABLE "fragno_db_outbox_mutations" (
      	"id" varchar(30) NOT NULL,
      	"entryVersionstamp" text NOT NULL,
      	"mutationVersionstamp" text NOT NULL,
      	"uowId" text NOT NULL,
      	"schema" text NOT NULL,
      	"table" text NOT NULL,
      	"externalId" text NOT NULL,
      	"op" text NOT NULL,
      	"createdAt" timestamp DEFAULT now() NOT NULL,
      	"_shard" text,
      	"_internalId" bigserial PRIMARY KEY NOT NULL,
      	"_version" integer DEFAULT 0 NOT NULL,
      	CONSTRAINT "fragno_db_outbox_mutations_id_unique" UNIQUE("id")
      );

      CREATE TABLE "fragno_db_sync_requests" (
      	"id" varchar(30) NOT NULL,
      	"requestId" text NOT NULL,
      	"status" text NOT NULL,
      	"confirmedCommandIds" json NOT NULL,
      	"conflictCommandId" text,
      	"baseVersionstamp" text,
      	"lastVersionstamp" text,
      	"createdAt" timestamp DEFAULT now() NOT NULL,
      	"_shard" text,
      	"_internalId" bigserial PRIMARY KEY NOT NULL,
      	"_version" integer DEFAULT 0 NOT NULL,
      	CONSTRAINT "fragno_db_sync_requests_id_unique" UNIQUE("id")
      );

      CREATE TABLE "test"."users" (
      	"id" varchar(30) NOT NULL,
      	"name" text NOT NULL,
      	"email" text NOT NULL,
      	"age" integer,
      	"isActive" boolean DEFAULT true NOT NULL,
      	"bio" text,
      	"createdAt" timestamp DEFAULT now() NOT NULL,
      	"updatedAt" timestamp DEFAULT now() NOT NULL,
      	"_internalId" bigserial PRIMARY KEY NOT NULL,
      	"_version" integer DEFAULT 0 NOT NULL,
      	"_shard" text,
      	CONSTRAINT "users_id_unique" UNIQUE("id")
      );

      CREATE TABLE "test"."posts" (
      	"id" varchar(30) NOT NULL,
      	"title" text NOT NULL,
      	"slug" varchar(255) NOT NULL,
      	"content" text NOT NULL,
      	"excerpt" text,
      	"userId" bigint NOT NULL,
      	"viewCount" integer DEFAULT 0 NOT NULL,
      	"likeCount" bigint DEFAULT 9999999999999999 NOT NULL,
      	"isPublished" boolean DEFAULT false NOT NULL,
      	"publishedAt" timestamp,
      	"metadata" json,
      	"rating" numeric,
      	"thumbnail" "bytea",
      	"createdAt" timestamp DEFAULT now() NOT NULL,
      	"_internalId" bigserial PRIMARY KEY NOT NULL,
      	"_version" integer DEFAULT 0 NOT NULL,
      	"_shard" text,
      	CONSTRAINT "posts_id_unique" UNIQUE("id")
      );

      CREATE TABLE "test"."comments" (
      	"id" varchar(30) NOT NULL,
      	"content" text NOT NULL,
      	"postId" bigint NOT NULL,
      	"userId" bigint NOT NULL,
      	"parentId" bigint,
      	"createdAt" timestamp DEFAULT now() NOT NULL,
      	"editedAt" timestamp,
      	"isDeleted" boolean DEFAULT false NOT NULL,
      	"_internalId" bigserial PRIMARY KEY NOT NULL,
      	"_version" integer DEFAULT 0 NOT NULL,
      	"_shard" text,
      	CONSTRAINT "comments_id_unique" UNIQUE("id")
      );

      CREATE TABLE "test"."tags" (
      	"id" varchar(30) NOT NULL,
      	"name" text NOT NULL,
      	"slug" varchar(100) NOT NULL,
      	"description" text,
      	"color" varchar(7),
      	"usageCount" bigint DEFAULT 0 NOT NULL,
      	"_internalId" bigserial PRIMARY KEY NOT NULL,
      	"_version" integer DEFAULT 0 NOT NULL,
      	"_shard" text,
      	CONSTRAINT "tags_id_unique" UNIQUE("id")
      );

      CREATE TABLE "test"."postTags" (
      	"id" varchar(30) NOT NULL,
      	"postId" bigint NOT NULL,
      	"tagId" bigint NOT NULL,
      	"order" integer DEFAULT 0 NOT NULL,
      	"createdAt" timestamp DEFAULT now() NOT NULL,
      	"_internalId" bigserial PRIMARY KEY NOT NULL,
      	"_version" integer DEFAULT 0 NOT NULL,
      	"_shard" text,
      	CONSTRAINT "postTags_id_unique" UNIQUE("id")
      );

      ALTER TABLE "test"."posts" ADD CONSTRAINT "fk_posts_users_author" FOREIGN KEY ("userId") REFERENCES "test"."users"("_internalId") ON DELETE no action ON UPDATE no action;
      ALTER TABLE "test"."comments" ADD CONSTRAINT "fk_comments_posts_post" FOREIGN KEY ("postId") REFERENCES "test"."posts"("_internalId") ON DELETE no action ON UPDATE no action;
      ALTER TABLE "test"."comments" ADD CONSTRAINT "fk_comments_users_author" FOREIGN KEY ("userId") REFERENCES "test"."users"("_internalId") ON DELETE no action ON UPDATE no action;
      ALTER TABLE "test"."comments" ADD CONSTRAINT "fk_comments_comments_parent" FOREIGN KEY ("parentId") REFERENCES "test"."comments"("_internalId") ON DELETE no action ON UPDATE no action;
      ALTER TABLE "test"."postTags" ADD CONSTRAINT "fk_postTags_posts_post" FOREIGN KEY ("postId") REFERENCES "test"."posts"("_internalId") ON DELETE no action ON UPDATE no action;
      ALTER TABLE "test"."postTags" ADD CONSTRAINT "fk_postTags_tags_tag" FOREIGN KEY ("tagId") REFERENCES "test"."tags"("_internalId") ON DELETE no action ON UPDATE no action;
      CREATE UNIQUE INDEX "unique_key" ON "fragno_db_settings" USING btree ("key");
      CREATE INDEX "idx_fragno_db_settings_shard" ON "fragno_db_settings" USING btree ("_shard");
      CREATE INDEX "idx_namespace_status_retry" ON "fragno_hooks" USING btree ("namespace","status","nextRetryAt");
      CREATE INDEX "idx_hooks_shard_status_retry" ON "fragno_hooks" USING btree ("_shard","status","nextRetryAt");
      CREATE INDEX "idx_nonce" ON "fragno_hooks" USING btree ("nonce");
      CREATE INDEX "idx_fragno_hooks_shard" ON "fragno_hooks" USING btree ("_shard");
      CREATE UNIQUE INDEX "idx_outbox_versionstamp" ON "fragno_db_outbox" USING btree ("versionstamp");
      CREATE INDEX "idx_outbox_shard_versionstamp" ON "fragno_db_outbox" USING btree ("_shard","versionstamp");
      CREATE INDEX "idx_outbox_uow" ON "fragno_db_outbox" USING btree ("uowId");
      CREATE INDEX "idx_fragno_db_outbox_shard" ON "fragno_db_outbox" USING btree ("_shard");
      CREATE INDEX "idx_outbox_mutations_entry" ON "fragno_db_outbox_mutations" USING btree ("entryVersionstamp");
      CREATE INDEX "idx_outbox_mutations_shard_entry" ON "fragno_db_outbox_mutations" USING btree ("_shard","entryVersionstamp");
      CREATE INDEX "idx_outbox_mutations_key" ON "fragno_db_outbox_mutations" USING btree ("schema","table","externalId","entryVersionstamp");
      CREATE INDEX "idx_outbox_mutations_uow" ON "fragno_db_outbox_mutations" USING btree ("uowId");
      CREATE INDEX "idx_fragno_db_outbox_mutations_shard" ON "fragno_db_outbox_mutations" USING btree ("_shard");
      CREATE UNIQUE INDEX "idx_sync_request_id" ON "fragno_db_sync_requests" USING btree ("requestId");
      CREATE INDEX "idx_sync_requests_shard_request" ON "fragno_db_sync_requests" USING btree ("_shard","requestId");
      CREATE INDEX "idx_fragno_db_sync_requests_shard" ON "fragno_db_sync_requests" USING btree ("_shard");
      CREATE UNIQUE INDEX "idx_users_email" ON "test"."users" USING btree ("email");
      CREATE INDEX "idx_users_name" ON "test"."users" USING btree ("name");
      CREATE INDEX "idx_users_active" ON "test"."users" USING btree ("isActive");
      CREATE INDEX "idx_users_shard" ON "test"."users" USING btree ("_shard");
      CREATE INDEX "idx_posts_user" ON "test"."posts" USING btree ("userId");
      CREATE INDEX "idx_posts_title" ON "test"."posts" USING btree ("title");
      CREATE UNIQUE INDEX "idx_posts_slug" ON "test"."posts" USING btree ("slug");
      CREATE INDEX "idx_posts_published" ON "test"."posts" USING btree ("isPublished","publishedAt");
      CREATE INDEX "idx_posts_shard" ON "test"."posts" USING btree ("_shard");
      CREATE INDEX "idx_comments_post" ON "test"."comments" USING btree ("postId");
      CREATE INDEX "idx_comments_user" ON "test"."comments" USING btree ("userId");
      CREATE INDEX "idx_comments_parent" ON "test"."comments" USING btree ("parentId");
      CREATE INDEX "idx_comments_shard" ON "test"."comments" USING btree ("_shard");
      CREATE UNIQUE INDEX "idx_tags_slug" ON "test"."tags" USING btree ("slug");
      CREATE INDEX "idx_tags_name" ON "test"."tags" USING btree ("name");
      CREATE INDEX "idx_tags_shard" ON "test"."tags" USING btree ("_shard");
      CREATE UNIQUE INDEX "idx_postTags_post_tag" ON "test"."postTags" USING btree ("postId","tagId");
      CREATE INDEX "idx_postTags_tag" ON "test"."postTags" USING btree ("tagId");
      CREATE INDEX "idx_postTags_shard" ON "test"."postTags" USING btree ("_shard");"
    `);
  });
});
