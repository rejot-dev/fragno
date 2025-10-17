import { beforeAll, describe, expect, it } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import { createRequire } from "node:module";
import { writeAndLoadSchema } from "./test-utils";

// I dunno
const require = createRequire(import.meta.url);
const { generateDrizzleJson, generateMigration } =
  require("drizzle-kit/api") as typeof import("drizzle-kit/api");

describe("generateSchema and migrate", () => {
  const testSchema = schema((s) => {
    return s
      .addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("email", column("string"))
          .addColumn("age", column("integer").nullable())
          .addColumn("isActive", column("bool").defaultTo(true))
          .addColumn("bio", column("string").nullable())
          .addColumn("createdAt", column("timestamp").defaultTo$("now"))
          .addColumn("updatedAt", column("timestamp").defaultTo$("now"))
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
          .addColumn("createdAt", column("timestamp").defaultTo$("now"))
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
          .addColumn("createdAt", column("timestamp").defaultTo$("now"))
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
          .addColumn("createdAt", column("timestamp").defaultTo$("now"))
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
      "CREATE TABLE "users" (
      	"id" varchar(30) NOT NULL,
      	"name" text NOT NULL,
      	"email" text NOT NULL,
      	"age" integer,
      	"isActive" boolean DEFAULT true NOT NULL,
      	"bio" text,
      	"createdAt" timestamp DEFAULT now() NOT NULL,
      	"updatedAt" timestamp DEFAULT now() NOT NULL,
      	"_internalId" bigserial PRIMARY KEY NOT NULL,
      	"_version" integer DEFAULT 0 NOT NULL
      );

      CREATE TABLE "posts" (
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
      	"_version" integer DEFAULT 0 NOT NULL
      );

      CREATE TABLE "comments" (
      	"id" varchar(30) NOT NULL,
      	"content" text NOT NULL,
      	"postId" bigint NOT NULL,
      	"userId" bigint NOT NULL,
      	"parentId" bigint,
      	"createdAt" timestamp DEFAULT now() NOT NULL,
      	"editedAt" timestamp,
      	"isDeleted" boolean DEFAULT false NOT NULL,
      	"_internalId" bigserial PRIMARY KEY NOT NULL,
      	"_version" integer DEFAULT 0 NOT NULL
      );

      CREATE TABLE "tags" (
      	"id" varchar(30) NOT NULL,
      	"name" text NOT NULL,
      	"slug" varchar(100) NOT NULL,
      	"description" text,
      	"color" varchar(7),
      	"usageCount" bigint DEFAULT 0 NOT NULL,
      	"_internalId" bigserial PRIMARY KEY NOT NULL,
      	"_version" integer DEFAULT 0 NOT NULL
      );

      CREATE TABLE "postTags" (
      	"id" varchar(30) NOT NULL,
      	"postId" bigint NOT NULL,
      	"tagId" bigint NOT NULL,
      	"order" integer DEFAULT 0 NOT NULL,
      	"createdAt" timestamp DEFAULT now() NOT NULL,
      	"_internalId" bigserial PRIMARY KEY NOT NULL,
      	"_version" integer DEFAULT 0 NOT NULL
      );

      ALTER TABLE "posts" ADD CONSTRAINT "posts_users_author_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("_internalId") ON DELETE no action ON UPDATE no action;
      ALTER TABLE "comments" ADD CONSTRAINT "comments_posts_post_fk" FOREIGN KEY ("postId") REFERENCES "public"."posts"("_internalId") ON DELETE no action ON UPDATE no action;
      ALTER TABLE "comments" ADD CONSTRAINT "comments_users_author_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("_internalId") ON DELETE no action ON UPDATE no action;
      ALTER TABLE "comments" ADD CONSTRAINT "comments_comments_parent_fk" FOREIGN KEY ("parentId") REFERENCES "public"."comments"("_internalId") ON DELETE no action ON UPDATE no action;
      ALTER TABLE "postTags" ADD CONSTRAINT "postTags_posts_post_fk" FOREIGN KEY ("postId") REFERENCES "public"."posts"("_internalId") ON DELETE no action ON UPDATE no action;
      ALTER TABLE "postTags" ADD CONSTRAINT "postTags_tags_tag_fk" FOREIGN KEY ("tagId") REFERENCES "public"."tags"("_internalId") ON DELETE no action ON UPDATE no action;
      CREATE UNIQUE INDEX "idx_users_email" ON "users" USING btree ("email");
      CREATE INDEX "idx_users_name" ON "users" USING btree ("name");
      CREATE INDEX "idx_users_active" ON "users" USING btree ("isActive");
      CREATE INDEX "idx_posts_user" ON "posts" USING btree ("userId");
      CREATE INDEX "idx_posts_title" ON "posts" USING btree ("title");
      CREATE UNIQUE INDEX "idx_posts_slug" ON "posts" USING btree ("slug");
      CREATE INDEX "idx_posts_published" ON "posts" USING btree ("isPublished","publishedAt");
      CREATE INDEX "idx_comments_post" ON "comments" USING btree ("postId");
      CREATE INDEX "idx_comments_user" ON "comments" USING btree ("userId");
      CREATE INDEX "idx_comments_parent" ON "comments" USING btree ("parentId");
      CREATE UNIQUE INDEX "idx_tags_slug" ON "tags" USING btree ("slug");
      CREATE INDEX "idx_tags_name" ON "tags" USING btree ("name");
      CREATE UNIQUE INDEX "idx_postTags_post_tag" ON "postTags" USING btree ("postId","tagId");
      CREATE INDEX "idx_postTags_tag" ON "postTags" USING btree ("tagId");"
    `);
  });
});
