import { assert, beforeAll, describe, expect, it } from "vitest";
import { Kysely, SqliteDialect } from "kysely";
import { KyselyAdapter } from "@fragno-dev/db/adapters/kysely";
import SQLite from "better-sqlite3";
import { commentSchema, createCommentFragment } from "./mod";

describe("simple-auth-fragment", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let kysely: Kysely<any>;
  let adapter: KyselyAdapter;
  let fragment: ReturnType<typeof createCommentFragment>;

  beforeAll(async () => {
    const dialect = new SqliteDialect({
      database: new SQLite(":memory:"),
    });

    kysely = new Kysely({
      dialect,
    });

    adapter = new KyselyAdapter({
      db: kysely,
      provider: "sqlite",
    });

    fragment = createCommentFragment(
      {},
      {
        databaseAdapter: adapter,
      },
    );
  }, 12000);

  it("should run migrations", async () => {
    const schemaVersion = await adapter.getSchemaVersion("fragno-db-comment-db");
    expect(schemaVersion).toBeUndefined();

    const migrator = adapter.createMigrationEngine(commentSchema, "fragno-db-comment-db");
    const preparedMigration = await migrator.prepareMigration({
      updateSettings: false,
    });
    assert(preparedMigration.getSQL);
    expect(preparedMigration.getSQL()).toMatchInlineSnapshot(`
      "PRAGMA defer_foreign_keys = ON;

      create table "comment_fragno-db-comment-db" ("id" text not null unique, "title" text not null, "content" text not null, "createdAt" integer default CURRENT_TIMESTAMP not null, "postReference" text not null, "userReference" text not null, "parentId" integer, "_internalId" integer not null primary key autoincrement, "_version" integer default 0 not null, constraint "comment_comment_parent_fk" foreign key ("parentId") references "comment_fragno-db-comment-db" ("_internalId") on delete restrict on update restrict);

      create index "idx_comment_post" on "comment_fragno-db-comment-db" ("postReference");

      alter table "comment_fragno-db-comment-db" add column "rating" integer default 0 not null;"
    `);
    await preparedMigration.execute();
  });

  it("should run queries", async () => {
    const query = await fragment.services.createComment({
      title: "Test comment",
      content: "Test content",
      postReference: "123",
      userReference: "456",
    });

    expect(query).toMatchObject({
      id: expect.any(String),
      title: "Test comment",
      content: "Test content",
      postReference: "123",
      userReference: "456",
    });
  });
});
