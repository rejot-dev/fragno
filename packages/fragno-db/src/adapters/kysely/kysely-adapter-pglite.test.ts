import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { assert, beforeAll, describe, expect, it } from "vitest";
import { KyselyAdapter } from "./kysely-adapter";
import { column, idColumn, schema } from "../../schema/create";

describe("KyselyAdapter PGLite", () => {
  const testSchema = schema((s) => {
    return s
      .addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("age", column("integer").nullable());
      })
      .addTable("emails", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("user_id", column("string"))
          .addColumn("email", column("string"))
          .addColumn("is_primary", column("bool").defaultTo(false))
          .createIndex("unique_email", ["email"], { unique: true })
          .createIndex("user_emails", ["user_id"]);
      })
      .addReference("emails", "user", {
        columns: ["user_id"],
        targetTable: "users",
        targetColumns: ["id"],
      });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let kysely: Kysely<any>;
  let adapter: KyselyAdapter;

  beforeAll(async () => {
    const { dialect } = await KyselyPGlite.create();
    kysely = new Kysely({
      dialect,
    });

    adapter = new KyselyAdapter({
      db: kysely,
      provider: "postgresql",
    });
  });

  it("should run migrations and basic queries", { timeout: 12000 }, async () => {
    const schemaVersion = await adapter.getSchemaVersion("test");
    expect(schemaVersion).toBeUndefined();

    const migrator = adapter.createMigrationEngine(testSchema, "test");
    const preparedMigration = await migrator.prepareMigration();
    assert(preparedMigration.getSQL);

    await preparedMigration.execute();
    expect(preparedMigration.getSQL()).toMatchInlineSnapshot(`
      "create table "users" ("id" varchar(30) not null primary key, "name" text not null, "age" integer);

      create table "emails" ("id" varchar(30) not null primary key, "user_id" text not null, "email" text not null, "is_primary" boolean default false not null);

      create unique index "unique_email" on "emails" ("email");

      create index "user_emails" on "emails" ("user_id");

      alter table "emails" add constraint "emails_users_user_fk" foreign key ("user_id") references "users" ("id") on delete restrict on update restrict;

      create table "fragno_db_settings" ("key" varchar(255) primary key, "value" text not null);

      insert into "fragno_db_settings" ("key", "value") values ('test.schema_version', '3');"
    `);

    const queryEngine = adapter.createQueryEngine(testSchema, "test");

    // Create a user
    const userResult = await queryEngine.create("users", {
      name: "John Doe",
      age: 30,
    });

    expect(userResult).toEqual({
      id: expect.stringMatching(/^[a-z0-9]{20,}$/),
      name: "John Doe",
      age: 30,
    });

    // Create 2 emails for the user
    const email1Result = await queryEngine.create("emails", {
      user_id: userResult.id,
      email: "john.doe@example.com",
      is_primary: true,
    });

    const email2Result = await queryEngine.create("emails", {
      user_id: userResult.id,
      email: "john.doe.work@company.com",
      is_primary: false,
    });

    expect(email1Result).toEqual({
      id: expect.stringMatching(/^[a-z0-9]{20,}$/),
      user_id: userResult.id,
      email: "john.doe@example.com",
      is_primary: true,
    });

    expect(email2Result).toEqual({
      id: expect.stringMatching(/^[a-z0-9]{20,}$/),
      user_id: userResult.id,
      email: "john.doe.work@company.com",
      is_primary: false,
    });

    // Update user name
    await queryEngine.updateMany("users", {
      where: (b) => b("id", "=", userResult.id),
      set: {
        name: "Jane Doe",
      },
    });

    // Query emails with their users using join (since the relation is from emails to users)
    const emailsWithUsers = await queryEngine.findMany("emails", {
      join: (b) => b.user({ select: ["name", "age"] }),
    });

    expect(emailsWithUsers).toHaveLength(2); // One row per email
    expect(emailsWithUsers[0]).toEqual({
      id: expect.any(String),
      user_id: userResult.id,
      email: expect.stringMatching(/\.com$/),
      is_primary: expect.any(Boolean),
      user: {
        name: "Jane Doe",
        age: 30,
      },
    });

    // Also test a more specific join query to get emails for a specific user
    const userEmails = await queryEngine.findMany("emails", {
      where: (b) => b("user_id", "=", userResult.id),
      join: (b) => b.user({ select: ["name", "age"] }),
    });

    expect(userEmails).toHaveLength(2);
  });
});
