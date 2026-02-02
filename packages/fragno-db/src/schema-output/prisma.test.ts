import { describe, expect, it } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../schema/create";
import { internalSchema } from "../fragments/internal-fragment";
import { generatePrismaSchema } from "./prisma";
import { sqliteStorageDefault, sqliteStoragePrisma } from "../adapters/generic-sql/sqlite-storage";

const blogSchema = schema((s) => {
  return s
    .addTable("users", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("email", column("string"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn("birthDate", column("date").nullable())
        .addColumn("profile", column("json").nullable())
        .addColumn("bigScore", column("bigint"))
        .addColumn("reputation", column("decimal"))
        .addColumn("invitedBy", referenceColumn().nullable())
        .createIndex("idx_email", ["email"], { unique: true });
    })
    .addTable("posts", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("title", column("string"))
        .addColumn("authorId", referenceColumn())
        .addColumn("editorId", referenceColumn().nullable())
        .addColumn("publishedAt", column("timestamp").nullable())
        .createIndex("idx_title", ["title"]);
    })
    .addReference("author", {
      type: "one",
      from: { table: "posts", column: "authorId" },
      to: { table: "users", column: "id" },
    })
    .addReference("editor", {
      type: "one",
      from: { table: "posts", column: "editorId" },
      to: { table: "users", column: "id" },
    })
    .addReference("inviter", {
      type: "one",
      from: { table: "users", column: "invitedBy" },
      to: { table: "users", column: "id" },
    })
    .addReference("posts", {
      type: "many",
      from: { table: "users", column: "id" },
      to: { table: "posts", column: "authorId" },
    });
});

const weirdNamesSchema = schema((s) => {
  return s.addTable("user-profiles", (t) => {
    return t
      .addColumn("id", idColumn())
      .addColumn("user-id", column("string"))
      .addColumn("display name", column("string").nullable())
      .createIndex("user-id-index", ["user-id"]);
  });
});

const relationNamingSchema = schema((s) => {
  return s
    .addTable("users", (t) => {
      return t.addColumn("id", idColumn()).addColumn("name", column("string"));
    })
    .addTable("posts", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("author_id", referenceColumn())
        .addColumn("editor_id", referenceColumn().nullable());
    })
    .addTable("comments", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("post_id", referenceColumn())
        .addColumn("parent_id", referenceColumn().nullable());
    })
    .addTable("follows", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("follower_id", referenceColumn())
        .addColumn("followee_id", referenceColumn());
    })
    .addReference("author", {
      type: "one",
      from: { table: "posts", column: "author_id" },
      to: { table: "users", column: "id" },
    })
    .addReference("editor", {
      type: "one",
      from: { table: "posts", column: "editor_id" },
      to: { table: "users", column: "id" },
    })
    .addReference("post", {
      type: "one",
      from: { table: "comments", column: "post_id" },
      to: { table: "posts", column: "id" },
    })
    .addReference("parent", {
      type: "one",
      from: { table: "comments", column: "parent_id" },
      to: { table: "comments", column: "id" },
    })
    .addReference("follower", {
      type: "one",
      from: { table: "follows", column: "follower_id" },
      to: { table: "users", column: "id" },
    })
    .addReference("followee", {
      type: "one",
      from: { table: "follows", column: "followee_id" },
      to: { table: "users", column: "id" },
    })
    .addReference("posts", {
      type: "many",
      from: { table: "users", column: "id" },
      to: { table: "posts", column: "author_id" },
    })
    .addReference("editedPosts", {
      type: "many",
      from: { table: "users", column: "id" },
      to: { table: "posts", column: "editor_id" },
    });
});

describe("generatePrismaSchema", () => {
  it("should generate stable ordering for internal models and namespaces", () => {
    const alphaSchema = schema((s) => {
      return s
        .addTable("zeta", (t) => t.addColumn("id", idColumn()))
        .addTable("alpha", (t) => t.addColumn("id", idColumn()));
    });

    const bravoSchema = schema((s) => {
      return s.addTable("bravo", (t) => t.addColumn("id", idColumn()));
    });

    const generated = generatePrismaSchema(
      [
        { namespace: "bravo", schema: bravoSchema },
        { namespace: "", schema: internalSchema },
        { namespace: "alpha", schema: alphaSchema },
      ],
      "sqlite",
      { sqliteStorageMode: sqliteStoragePrisma },
    );

    const settingsIndex = generated.indexOf("model FragnoDbSettings");
    const hooksIndex = generated.indexOf("model FragnoHooks");
    const alphaIndex = generated.indexOf("model Alpha_alpha");
    const zetaIndex = generated.indexOf("model Zeta_alpha");
    const bravoIndex = generated.indexOf("model Bravo_bravo");

    expect(settingsIndex).toBeGreaterThanOrEqual(0);
    expect(hooksIndex).toBeGreaterThanOrEqual(0);
    expect(alphaIndex).toBeGreaterThanOrEqual(0);
    expect(zetaIndex).toBeGreaterThanOrEqual(0);
    expect(bravoIndex).toBeGreaterThanOrEqual(0);

    expect(settingsIndex).toBeLessThan(hooksIndex);
    expect(hooksIndex).toBeLessThan(alphaIndex);
    expect(alphaIndex).toBeLessThan(zetaIndex);
    expect(zetaIndex).toBeLessThan(bravoIndex);
  });
  it("should generate SQLite Prisma schema", () => {
    const generated = generatePrismaSchema(
      [
        { namespace: "", schema: internalSchema },
        { namespace: "blog", schema: blogSchema },
      ],
      "sqlite",
      { sqliteStorageMode: sqliteStoragePrisma },
    );

    expect(generated).toMatchInlineSnapshot(`
      "// Generated by Fragno Prisma adapter.\n// Provider: sqlite\n// Namespaces: blog\n\nmodel FragnoDbSettings {\n  id String @unique @default(cuid())\n  key String\n  value String\n  _internalId Int @id @default(autoincrement())\n  _version Int @default(0)\n  @@unique([key], map: "unique_key")\n  @@map("fragno_db_settings")\n}\n\nmodel FragnoHooks {\n  id String @unique @default(cuid())\n  namespace String\n  hookName String\n  payload Json\n  status String\n  attempts Int @default(0)\n  maxAttempts Int @default(5)\n  lastAttemptAt DateTime?\n  nextRetryAt DateTime?\n  error String?\n  createdAt DateTime @default(now())\n  nonce String\n  _internalId Int @id @default(autoincrement())\n  _version Int @default(0)\n  @@index([namespace, status, nextRetryAt], map: "idx_namespace_status_retry")\n  @@index([nonce], map: "idx_nonce")\n  @@map("fragno_hooks")\n}\n\nmodel Posts_blog {\n  id String @unique @default(cuid())\n  title String\n  authorId Int\n  editorId Int?\n  publishedAt DateTime?\n  _internalId Int @id @default(autoincrement())\n  _version Int @default(0)\n  author Users_blog @relation("blog_posts_author_users", fields: [authorId], references: [_internalId], map: "fk_posts_users_author_blog")\n  editor Users_blog? @relation("blog_posts_editor_users", fields: [editorId], references: [_internalId], map: "fk_posts_users_editor_blog")\n  @@index([title], map: "idx_title_blog")\n  @@map("posts_blog")\n}\n\nmodel Users_blog {\n  id String @unique @default(cuid())\n  email String\n  createdAt DateTime @default(now())\n  birthDate DateTime?\n  profile Json?\n  bigScore BigInt\n  reputation Float\n  invitedBy Int?\n  _internalId Int @id @default(autoincrement())\n  _version Int @default(0)\n  inviter Users_blog? @relation("blog_users_inviter_users", fields: [invitedBy], references: [_internalId], map: "fk_users_users_inviter_blog")\n  posts Posts_blog[] @relation("blog_posts_author_users")\n  posts_editor Posts_blog[] @relation("blog_posts_editor_users")\n  users Users_blog[] @relation("blog_users_inviter_users")\n  @@unique([email], map: "idx_email_blog")\n  @@map("users_blog")\n}"
    `);
  });

  it("should generate SQLite Prisma schema for default storage mode", () => {
    const generated = generatePrismaSchema(
      [
        { namespace: "", schema: internalSchema },
        { namespace: "blog", schema: blogSchema },
      ],
      "sqlite",
      { sqliteStorageMode: sqliteStorageDefault },
    );

    expect(generated).toMatchInlineSnapshot(`
      "// Generated by Fragno Prisma adapter.\n// Provider: sqlite\n// Namespaces: blog\n\nmodel FragnoDbSettings {\n  id String @unique @default(cuid())\n  key String\n  value String\n  _internalId Int @id @default(autoincrement())\n  _version Int @default(0)\n  @@unique([key], map: "unique_key")\n  @@map("fragno_db_settings")\n}\n\nmodel FragnoHooks {\n  id String @unique @default(cuid())\n  namespace String\n  hookName String\n  payload Json\n  status String\n  attempts Int @default(0)\n  maxAttempts Int @default(5)\n  lastAttemptAt Int?\n  nextRetryAt Int?\n  error String?\n  createdAt Int @default(dbgenerated("CURRENT_TIMESTAMP"))\n  nonce String\n  _internalId Int @id @default(autoincrement())\n  _version Int @default(0)\n  @@index([namespace, status, nextRetryAt], map: "idx_namespace_status_retry")\n  @@index([nonce], map: "idx_nonce")\n  @@map("fragno_hooks")\n}\n\nmodel Posts_blog {\n  id String @unique @default(cuid())\n  title String\n  authorId Int\n  editorId Int?\n  publishedAt Int?\n  _internalId Int @id @default(autoincrement())\n  _version Int @default(0)\n  author Users_blog @relation("blog_posts_author_users", fields: [authorId], references: [_internalId], map: "fk_posts_users_author_blog")\n  editor Users_blog? @relation("blog_posts_editor_users", fields: [editorId], references: [_internalId], map: "fk_posts_users_editor_blog")\n  @@index([title], map: "idx_title_blog")\n  @@map("posts_blog")\n}\n\nmodel Users_blog {\n  id String @unique @default(cuid())\n  email String\n  createdAt Int @default(dbgenerated("CURRENT_TIMESTAMP"))\n  birthDate Int?\n  profile Json?\n  bigScore Bytes\n  reputation Float\n  invitedBy Int?\n  _internalId Int @id @default(autoincrement())\n  _version Int @default(0)\n  inviter Users_blog? @relation("blog_users_inviter_users", fields: [invitedBy], references: [_internalId], map: "fk_users_users_inviter_blog")\n  posts Posts_blog[] @relation("blog_posts_author_users")\n  posts_editor Posts_blog[] @relation("blog_posts_editor_users")\n  users Users_blog[] @relation("blog_users_inviter_users")\n  @@unique([email], map: "idx_email_blog")\n  @@map("users_blog")\n}"
    `);
  });

  it("should generate PostgreSQL (PGLite) Prisma schema", () => {
    const generated = generatePrismaSchema(
      [
        { namespace: "", schema: internalSchema },
        { namespace: "blog", schema: blogSchema },
      ],
      "postgresql",
    );

    expect(generated).toMatchInlineSnapshot(`
      "// Generated by Fragno Prisma adapter.\n// Provider: postgresql\n// Namespaces: blog\n\nmodel FragnoDbSettings {\n  id String @unique @default(cuid()) @db.VarChar(30)\n  key String\n  value String\n  _internalId BigInt @id @default(autoincrement())\n  _version Int @default(0)\n  @@unique([key], map: "unique_key")\n  @@map("fragno_db_settings")\n}\n\nmodel FragnoHooks {\n  id String @unique @default(cuid()) @db.VarChar(30)\n  namespace String\n  hookName String\n  payload Json @db.Json\n  status String\n  attempts Int @default(0)\n  maxAttempts Int @default(5)\n  lastAttemptAt DateTime?\n  nextRetryAt DateTime?\n  error String?\n  createdAt DateTime @default(now())\n  nonce String\n  _internalId BigInt @id @default(autoincrement())\n  _version Int @default(0)\n  @@index([namespace, status, nextRetryAt], map: "idx_namespace_status_retry")\n  @@index([nonce], map: "idx_nonce")\n  @@map("fragno_hooks")\n}\n\nmodel Posts_blog {\n  id String @unique @default(cuid()) @db.VarChar(30)\n  title String\n  authorId BigInt\n  editorId BigInt?\n  publishedAt DateTime?\n  _internalId BigInt @id @default(autoincrement())\n  _version Int @default(0)\n  author Users_blog @relation("blog_posts_author_users", fields: [authorId], references: [_internalId], map: "fk_posts_users_author_blog")\n  editor Users_blog? @relation("blog_posts_editor_users", fields: [editorId], references: [_internalId], map: "fk_posts_users_editor_blog")\n  @@index([title], map: "idx_title_blog")\n  @@map("posts_blog")\n}\n\nmodel Users_blog {\n  id String @unique @default(cuid()) @db.VarChar(30)\n  email String\n  createdAt DateTime @default(now())\n  birthDate DateTime? @db.Date\n  profile Json? @db.Json\n  bigScore BigInt\n  reputation Decimal\n  invitedBy BigInt?\n  _internalId BigInt @id @default(autoincrement())\n  _version Int @default(0)\n  inviter Users_blog? @relation("blog_users_inviter_users", fields: [invitedBy], references: [_internalId], map: "fk_users_users_inviter_blog")\n  posts Posts_blog[] @relation("blog_posts_author_users")\n  posts_editor Posts_blog[] @relation("blog_posts_editor_users")\n  users Users_blog[] @relation("blog_users_inviter_users")\n  @@unique([email], map: "idx_email_blog")\n  @@map("users_blog")\n}"
    `);
  });

  it("should sanitize namespaces and map invalid identifiers for SQLite", () => {
    const generated = generatePrismaSchema(
      [{ namespace: "my-app", schema: weirdNamesSchema }],
      "sqlite",
      { sqliteStorageMode: sqliteStoragePrisma },
    );

    expect(generated).toMatchInlineSnapshot(`
      "// Generated by Fragno Prisma adapter.\n// Provider: sqlite\n// Namespaces: my-app\n\nmodel UserProfiles_my_app {\n  id String @unique @default(cuid())\n  user_id String @map("user-id")\n  display_name String? @map("display name")\n  _internalId Int @id @default(autoincrement())\n  _version Int @default(0)\n  @@index([user_id], map: "user-id-index_my-app")\n  @@map("user-profiles_my-app")\n}"
    `);
  });

  it("should sanitize namespaces and map invalid identifiers for PostgreSQL", () => {
    const generated = generatePrismaSchema(
      [{ namespace: "my-app", schema: weirdNamesSchema }],
      "postgresql",
    );

    expect(generated).toMatchInlineSnapshot(`
      "// Generated by Fragno Prisma adapter.\n// Provider: postgresql\n// Namespaces: my-app\n\nmodel UserProfiles_my_app {\n  id String @unique @default(cuid()) @db.VarChar(30)\n  user_id String @map("user-id")\n  display_name String? @map("display name")\n  _internalId BigInt @id @default(autoincrement())\n  _version Int @default(0)\n  @@index([user_id], map: "user-id-index_my-app")\n  @@map("user-profiles_my-app")\n}"
    `);
  });

  it("should disambiguate inverse relations for SQLite", () => {
    const generated = generatePrismaSchema(
      [{ namespace: "test", schema: relationNamingSchema }],
      "sqlite",
      { sqliteStorageMode: sqliteStoragePrisma },
    );

    expect(generated).toContain('posts Posts_test[] @relation("test_posts_author_users")');
    expect(generated).toContain('editedPosts Posts_test[] @relation("test_posts_editor_users")');
    expect(generated).toContain('comments Comments_test[] @relation("test_comments_post_posts")');
    expect(generated).toContain(
      'comments Comments_test[] @relation("test_comments_parent_comments")',
    );
    expect(generated).toContain('follows Follows_test[] @relation("test_follows_followee_users")');
    expect(generated).toContain(
      'follows_follower Follows_test[] @relation("test_follows_follower_users")',
    );
  });

  it("should disambiguate inverse relations for PostgreSQL", () => {
    const generated = generatePrismaSchema(
      [{ namespace: "test", schema: relationNamingSchema }],
      "postgresql",
    );

    expect(generated).toContain('posts Posts_test[] @relation("test_posts_author_users")');
    expect(generated).toContain('editedPosts Posts_test[] @relation("test_posts_editor_users")');
    expect(generated).toContain('comments Comments_test[] @relation("test_comments_post_posts")');
    expect(generated).toContain(
      'comments Comments_test[] @relation("test_comments_parent_comments")',
    );
    expect(generated).toContain('follows Follows_test[] @relation("test_follows_followee_users")');
    expect(generated).toContain(
      'follows_follower Follows_test[] @relation("test_follows_follower_users")',
    );
  });
});
