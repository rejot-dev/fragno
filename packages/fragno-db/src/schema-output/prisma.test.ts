import { describe, expect, it } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../schema/create";
import { internalSchema } from "../fragments/internal-fragment";
import { generatePrismaSchema } from "./prisma";
import { sqliteStorageDefault, sqliteStoragePrisma } from "../adapters/generic-sql/sqlite-storage";

const blogSchema = schema("blog", (s) => {
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

const weirdNamesSchema = schema("weirdnames", (s) => {
  return s.addTable("user-profiles", (t) => {
    return t
      .addColumn("id", idColumn())
      .addColumn("user-id", column("string"))
      .addColumn("display name", column("string").nullable())
      .createIndex("user-id-index", ["user-id"]);
  });
});

const relationNamingSchema = schema("relationnaming", (s) => {
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
    const alphaSchema = schema("alpha", (s) => {
      return s
        .addTable("zeta", (t) => t.addColumn("id", idColumn()))
        .addTable("alpha", (t) => t.addColumn("id", idColumn()));
    });

    const bravoSchema = schema("bravo", (s) => {
      return s.addTable("bravo", (t) => t.addColumn("id", idColumn()));
    });

    const generated = generatePrismaSchema(
      [
        { namespace: "bravo", schema: bravoSchema },
        { namespace: null, schema: internalSchema },
        { namespace: "alpha", schema: alphaSchema },
      ],
      "sqlite",
      { sqliteStorageMode: sqliteStoragePrisma },
    );

    const settingsIndex = generated.indexOf("model FragnoDbSettings");
    const hooksIndex = generated.indexOf("model FragnoHooks");
    const outboxIndex = generated.indexOf("model FragnoDbOutbox");
    const alphaIndex = generated.indexOf("model Alpha_alpha");
    const zetaIndex = generated.indexOf("model Zeta_alpha");
    const bravoIndex = generated.indexOf("model Bravo_bravo");

    expect(settingsIndex).toBeGreaterThanOrEqual(0);
    expect(hooksIndex).toBeGreaterThanOrEqual(0);
    expect(outboxIndex).toBeGreaterThanOrEqual(0);
    expect(alphaIndex).toBeGreaterThanOrEqual(0);
    expect(zetaIndex).toBeGreaterThanOrEqual(0);
    expect(bravoIndex).toBeGreaterThanOrEqual(0);

    expect(outboxIndex).toBeLessThan(settingsIndex);
    expect(settingsIndex).toBeLessThan(hooksIndex);
    expect(hooksIndex).toBeLessThan(alphaIndex);
    expect(alphaIndex).toBeLessThan(zetaIndex);
    expect(zetaIndex).toBeLessThan(bravoIndex);
  });
  it("should generate SQLite Prisma schema", () => {
    const generated = generatePrismaSchema(
      [
        { namespace: null, schema: internalSchema },
        { namespace: "blog", schema: blogSchema },
      ],
      "sqlite",
      { sqliteStorageMode: sqliteStoragePrisma },
    );

    expect(generated).toMatchInlineSnapshot(`
      "// Generated by Fragno Prisma adapter.
      // Provider: sqlite
      // Namespaces: blog

      model FragnoDbOutbox {
        id String @unique @default(cuid())
        versionstamp String
        uowId String
        payload Json
        refMap Json?
        createdAt DateTime @default(now())
        _internalId Int @id @default(autoincrement())
        _version Int @default(0)
        @@index([uowId], map: "idx_fragno_db_outbox_idx_outbox_uow_733c7f90")
        @@unique([versionstamp], map: "uidx_fragno_db_outbox_idx_outbox_versionstamp_37972a68")
        @@map("fragno_db_outbox")
      }

      model FragnoDbOutboxMutations {
        id String @unique @default(cuid())
        entryVersionstamp String
        mutationVersionstamp String
        uowId String
        schema String
        table String
        externalId String
        op String
        createdAt DateTime @default(now())
        _internalId Int @id @default(autoincrement())
        _version Int @default(0)
        @@index([entryVersionstamp], map: "idx_fragno_db_outbox_mutations_idx_outbox_mutations_entf896150d")
        @@index([schema, table, externalId, entryVersionstamp], map: "idx_fragno_db_outbox_mutations_idx_outbox_mutations_key16922fb2")
        @@index([uowId], map: "idx_fragno_db_outbox_mutations_idx_outbox_mutations_uowa7a0749c")
        @@map("fragno_db_outbox_mutations")
      }

      model FragnoDbSettings {
        id String @unique @default(cuid())
        key String
        value String
        _internalId Int @id @default(autoincrement())
        _version Int @default(0)
        @@unique([key], map: "uidx_fragno_db_settings_unique_key_09269db3")
        @@map("fragno_db_settings")
      }

      model FragnoDbSyncRequests {
        id String @unique @default(cuid())
        requestId String
        status String
        confirmedCommandIds Json
        conflictCommandId String?
        baseVersionstamp String?
        lastVersionstamp String?
        createdAt DateTime @default(now())
        _internalId Int @id @default(autoincrement())
        _version Int @default(0)
        @@unique([requestId], map: "uidx_fragno_db_sync_requests_idx_sync_request_id_a352b2bb")
        @@map("fragno_db_sync_requests")
      }

      model FragnoHooks {
        id String @unique @default(cuid())
        namespace String
        hookName String
        payload Json
        status String
        attempts Int @default(0)
        maxAttempts Int @default(5)
        lastAttemptAt DateTime?
        nextRetryAt DateTime?
        error String?
        createdAt DateTime @default(now())
        nonce String
        _internalId Int @id @default(autoincrement())
        _version Int @default(0)
        dedupeKey String?
        @@unique([namespace, hookName, dedupeKey, status], map: "uidx_fragno_hooks_idx_hook_dedupe_6a3c98e5")
        @@index([namespace, status, nextRetryAt], map: "idx_fragno_hooks_idx_namespace_status_retry_b66b1168")
        @@index([nonce], map: "idx_fragno_hooks_idx_nonce_90c97cf1")
        @@map("fragno_hooks")
      }

      model Posts_blog {
        id String @unique @default(cuid())
        title String
        authorId Int
        editorId Int?
        publishedAt DateTime?
        _internalId Int @id @default(autoincrement())
        _version Int @default(0)
        author Users_blog @relation("blog_posts_author_users", fields: [authorId], references: [_internalId], map: "fk_posts_users_author_blog_d01fe02e")
        editor Users_blog? @relation("blog_posts_editor_users", fields: [editorId], references: [_internalId], map: "fk_posts_users_editor_blog_d7abc235")
        @@index([title], map: "idx_posts_idx_title_blog_f90cbb7e")
        @@map("posts_blog")
      }

      model Users_blog {
        id String @unique @default(cuid())
        email String
        createdAt DateTime @default(now())
        birthDate DateTime?
        profile Json?
        bigScore BigInt
        reputation Float
        invitedBy Int?
        _internalId Int @id @default(autoincrement())
        _version Int @default(0)
        inviter Users_blog? @relation("blog_users_inviter_users", fields: [invitedBy], references: [_internalId], map: "fk_users_users_inviter_blog_631afc1c")
        posts Posts_blog[] @relation("blog_posts_author_users")
        posts_editor Posts_blog[] @relation("blog_posts_editor_users")
        users Users_blog[] @relation("blog_users_inviter_users")
        @@unique([email], map: "uidx_users_idx_email_blog_4468050e")
        @@map("users_blog")
      }"
    `);
  });

  it("should generate SQLite Prisma schema for default storage mode", () => {
    const generated = generatePrismaSchema(
      [
        { namespace: null, schema: internalSchema },
        { namespace: "blog", schema: blogSchema },
      ],
      "sqlite",
      { sqliteStorageMode: sqliteStorageDefault },
    );

    expect(generated).toMatchInlineSnapshot(`
      "// Generated by Fragno Prisma adapter.
      // Provider: sqlite
      // Namespaces: blog

      model FragnoDbOutbox {
        id String @unique @default(cuid())
        versionstamp String
        uowId String
        payload Json
        refMap Json?
        createdAt Int @default(dbgenerated("CURRENT_TIMESTAMP"))
        _internalId Int @id @default(autoincrement())
        _version Int @default(0)
        @@index([uowId], map: "idx_fragno_db_outbox_idx_outbox_uow_733c7f90")
        @@unique([versionstamp], map: "uidx_fragno_db_outbox_idx_outbox_versionstamp_37972a68")
        @@map("fragno_db_outbox")
      }

      model FragnoDbOutboxMutations {
        id String @unique @default(cuid())
        entryVersionstamp String
        mutationVersionstamp String
        uowId String
        schema String
        table String
        externalId String
        op String
        createdAt Int @default(dbgenerated("CURRENT_TIMESTAMP"))
        _internalId Int @id @default(autoincrement())
        _version Int @default(0)
        @@index([entryVersionstamp], map: "idx_fragno_db_outbox_mutations_idx_outbox_mutations_entf896150d")
        @@index([schema, table, externalId, entryVersionstamp], map: "idx_fragno_db_outbox_mutations_idx_outbox_mutations_key16922fb2")
        @@index([uowId], map: "idx_fragno_db_outbox_mutations_idx_outbox_mutations_uowa7a0749c")
        @@map("fragno_db_outbox_mutations")
      }

      model FragnoDbSettings {
        id String @unique @default(cuid())
        key String
        value String
        _internalId Int @id @default(autoincrement())
        _version Int @default(0)
        @@unique([key], map: "uidx_fragno_db_settings_unique_key_09269db3")
        @@map("fragno_db_settings")
      }

      model FragnoDbSyncRequests {
        id String @unique @default(cuid())
        requestId String
        status String
        confirmedCommandIds Json
        conflictCommandId String?
        baseVersionstamp String?
        lastVersionstamp String?
        createdAt Int @default(dbgenerated("CURRENT_TIMESTAMP"))
        _internalId Int @id @default(autoincrement())
        _version Int @default(0)
        @@unique([requestId], map: "uidx_fragno_db_sync_requests_idx_sync_request_id_a352b2bb")
        @@map("fragno_db_sync_requests")
      }

      model FragnoHooks {
        id String @unique @default(cuid())
        namespace String
        hookName String
        payload Json
        status String
        attempts Int @default(0)
        maxAttempts Int @default(5)
        lastAttemptAt Int?
        nextRetryAt Int?
        error String?
        createdAt Int @default(dbgenerated("CURRENT_TIMESTAMP"))
        nonce String
        _internalId Int @id @default(autoincrement())
        _version Int @default(0)
        dedupeKey String?
        @@unique([namespace, hookName, dedupeKey, status], map: "uidx_fragno_hooks_idx_hook_dedupe_6a3c98e5")
        @@index([namespace, status, nextRetryAt], map: "idx_fragno_hooks_idx_namespace_status_retry_b66b1168")
        @@index([nonce], map: "idx_fragno_hooks_idx_nonce_90c97cf1")
        @@map("fragno_hooks")
      }

      model Posts_blog {
        id String @unique @default(cuid())
        title String
        authorId Int
        editorId Int?
        publishedAt Int?
        _internalId Int @id @default(autoincrement())
        _version Int @default(0)
        author Users_blog @relation("blog_posts_author_users", fields: [authorId], references: [_internalId], map: "fk_posts_users_author_blog_d01fe02e")
        editor Users_blog? @relation("blog_posts_editor_users", fields: [editorId], references: [_internalId], map: "fk_posts_users_editor_blog_d7abc235")
        @@index([title], map: "idx_posts_idx_title_blog_f90cbb7e")
        @@map("posts_blog")
      }

      model Users_blog {
        id String @unique @default(cuid())
        email String
        createdAt Int @default(dbgenerated("CURRENT_TIMESTAMP"))
        birthDate Int?
        profile Json?
        bigScore Bytes
        reputation Float
        invitedBy Int?
        _internalId Int @id @default(autoincrement())
        _version Int @default(0)
        inviter Users_blog? @relation("blog_users_inviter_users", fields: [invitedBy], references: [_internalId], map: "fk_users_users_inviter_blog_631afc1c")
        posts Posts_blog[] @relation("blog_posts_author_users")
        posts_editor Posts_blog[] @relation("blog_posts_editor_users")
        users Users_blog[] @relation("blog_users_inviter_users")
        @@unique([email], map: "uidx_users_idx_email_blog_4468050e")
        @@map("users_blog")
      }"
    `);
  });

  it("should generate PostgreSQL (PGLite) Prisma schema", () => {
    const generated = generatePrismaSchema(
      [
        { namespace: null, schema: internalSchema },
        { namespace: "blog", schema: blogSchema },
      ],
      "postgresql",
    );

    expect(generated).toMatchInlineSnapshot(`
      "// Generated by Fragno Prisma adapter.
      // Provider: postgresql
      // Namespaces: blog

      model FragnoDbOutbox {
        id String @unique @default(cuid()) @db.VarChar(30)
        versionstamp String
        uowId String
        payload Json @db.Json
        refMap Json? @db.Json
        createdAt DateTime @default(now())
        _internalId BigInt @id @default(autoincrement())
        _version Int @default(0)
        @@index([uowId], map: "idx_outbox_uow")
        @@unique([versionstamp], map: "idx_outbox_versionstamp")
        @@map("fragno_db_outbox")
      }

      model FragnoDbOutboxMutations {
        id String @unique @default(cuid()) @db.VarChar(30)
        entryVersionstamp String
        mutationVersionstamp String
        uowId String
        schema String
        table String
        externalId String
        op String
        createdAt DateTime @default(now())
        _internalId BigInt @id @default(autoincrement())
        _version Int @default(0)
        @@index([entryVersionstamp], map: "idx_outbox_mutations_entry")
        @@index([schema, table, externalId, entryVersionstamp], map: "idx_outbox_mutations_key")
        @@index([uowId], map: "idx_outbox_mutations_uow")
        @@map("fragno_db_outbox_mutations")
      }

      model FragnoDbSettings {
        id String @unique @default(cuid()) @db.VarChar(30)
        key String
        value String
        _internalId BigInt @id @default(autoincrement())
        _version Int @default(0)
        @@unique([key], map: "unique_key")
        @@map("fragno_db_settings")
      }

      model FragnoDbSyncRequests {
        id String @unique @default(cuid()) @db.VarChar(30)
        requestId String
        status String
        confirmedCommandIds Json @db.Json
        conflictCommandId String?
        baseVersionstamp String?
        lastVersionstamp String?
        createdAt DateTime @default(now())
        _internalId BigInt @id @default(autoincrement())
        _version Int @default(0)
        @@unique([requestId], map: "idx_sync_request_id")
        @@map("fragno_db_sync_requests")
      }

      model FragnoHooks {
        id String @unique @default(cuid()) @db.VarChar(30)
        namespace String
        hookName String
        payload Json @db.Json
        status String
        attempts Int @default(0)
        maxAttempts Int @default(5)
        lastAttemptAt DateTime?
        nextRetryAt DateTime?
        error String?
        createdAt DateTime @default(now())
        nonce String
        _internalId BigInt @id @default(autoincrement())
        _version Int @default(0)
        dedupeKey String?
        @@unique([namespace, hookName, dedupeKey, status], map: "idx_hook_dedupe")
        @@index([namespace, status, nextRetryAt], map: "idx_namespace_status_retry")
        @@index([nonce], map: "idx_nonce")
        @@map("fragno_hooks")
      }

      model Posts_blog {
        id String @unique @default(cuid()) @db.VarChar(30)
        title String
        authorId BigInt
        editorId BigInt?
        publishedAt DateTime?
        _internalId BigInt @id @default(autoincrement())
        _version Int @default(0)
        author Users_blog @relation("blog_posts_author_users", fields: [authorId], references: [_internalId], map: "fk_posts_users_author")
        editor Users_blog? @relation("blog_posts_editor_users", fields: [editorId], references: [_internalId], map: "fk_posts_users_editor")
        @@index([title], map: "idx_title")
        @@map("posts")
      }

      model Users_blog {
        id String @unique @default(cuid()) @db.VarChar(30)
        email String
        createdAt DateTime @default(now())
        birthDate DateTime? @db.Date
        profile Json? @db.Json
        bigScore BigInt
        reputation Decimal
        invitedBy BigInt?
        _internalId BigInt @id @default(autoincrement())
        _version Int @default(0)
        inviter Users_blog? @relation("blog_users_inviter_users", fields: [invitedBy], references: [_internalId], map: "fk_users_users_inviter")
        posts Posts_blog[] @relation("blog_posts_author_users")
        posts_editor Posts_blog[] @relation("blog_posts_editor_users")
        users Users_blog[] @relation("blog_users_inviter_users")
        @@unique([email], map: "idx_email")
        @@map("users")
      }"
    `);
  });

  it("should sanitize namespaces and map invalid identifiers for SQLite", () => {
    const generated = generatePrismaSchema(
      [{ namespace: "my-app", schema: weirdNamesSchema }],
      "sqlite",
      { sqliteStorageMode: sqliteStoragePrisma },
    );

    expect(generated).toMatchInlineSnapshot(`
      "// Generated by Fragno Prisma adapter.
      // Provider: sqlite
      // Namespaces: my-app

      model UserProfiles_my_app {
        id String @unique @default(cuid())
        user_id String @map("user-id")
        display_name String? @map("display name")
        _internalId Int @id @default(autoincrement())
        _version Int @default(0)
        @@index([user_id], map: "idx_user-profiles_user-id-index_my-app_c295d8f4")
        @@map("user-profiles_my-app")
      }"
    `);
  });

  it("should sanitize namespaces and map invalid identifiers for PostgreSQL", () => {
    const generated = generatePrismaSchema(
      [{ namespace: "my-app", schema: weirdNamesSchema }],
      "postgresql",
    );

    expect(generated).toMatchInlineSnapshot(`
      "// Generated by Fragno Prisma adapter.
      // Provider: postgresql
      // Namespaces: my-app

      model UserProfiles_my_app {
        id String @unique @default(cuid()) @db.VarChar(30)
        user_id String @map("user-id")
        display_name String? @map("display name")
        _internalId BigInt @id @default(autoincrement())
        _version Int @default(0)
        @@index([user_id], map: "user-id-index")
        @@map("user-profiles")
      }"
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
