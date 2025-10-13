import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { assert, beforeAll, describe, expect, it } from "vitest";
import { KyselyAdapter } from "./kysely-adapter";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";

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
          .addColumn("user_id", referenceColumn())
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
  }, 12000);

  it("should run migrations and basic queries", async () => {
    const schemaVersion = await adapter.getSchemaVersion("test");
    expect(schemaVersion).toBeUndefined();

    const migrator = adapter.createMigrationEngine(testSchema, "test");
    const preparedMigration = await migrator.prepareMigration();
    assert(preparedMigration.getSQL);

    expect(preparedMigration.getSQL()).toMatchInlineSnapshot(`
      "create table "users" ("id" varchar(30) not null unique, "name" text not null, "age" integer, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      create table "emails" ("id" varchar(30) not null unique, "user_id" bigint not null, "email" text not null, "is_primary" boolean default false not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      create unique index "unique_email" on "emails" ("email");

      create index "user_emails" on "emails" ("user_id");

      alter table "emails" add constraint "emails_users_user_fk" foreign key ("user_id") references "users" ("_internalId") on delete restrict on update restrict;

      create table "fragno_db_settings" ("key" varchar(255) primary key, "value" text not null);

      insert into "fragno_db_settings" ("key", "value") values ('test.schema_version', '3');"
    `);

    await preparedMigration.execute();

    const queryEngine = adapter.createQueryEngine(testSchema, "test");

    // Create a user
    const userResult = await queryEngine.create("users", {
      name: "John Doe",
      age: 30,
    });

    expect(userResult).toMatchObject({
      id: expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(Number),
      }),
      name: "John Doe",
      age: 30,
    });

    expect(userResult.id.version).toBe(0);

    const getUser = await queryEngine.findFirst("users", {
      select: ["id"],
      where: (b) => b("id", "=", userResult.id),
    });
    expect(getUser).toMatchObject({
      id: expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(Number),
      }),
    });

    // Create 2 emails for the user
    const email1Result = await queryEngine.create("emails", {
      user_id: userResult.id,
      email: "john.doe@example.com",
      is_primary: true,
    });

    const email2Result = await queryEngine.create("emails", {
      // Pass only the string (external ID) here, to make sure we generate the right sub-query.
      user_id: userResult.id.toString(),
      email: "john.doe.work@company.com",
      is_primary: false,
    });

    expect(email1Result).toEqual({
      id: expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(Number),
      }),
      user_id: expect.objectContaining({
        internalId: expect.any(Number),
      }),
      email: "john.doe@example.com",
      is_primary: true,
    });

    expect(email2Result).toEqual({
      id: expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(Number),
      }),
      user_id: expect.objectContaining({
        internalId: expect.any(Number),
      }),
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

    const updatedUser = await queryEngine.findFirst("users", {
      where: (b) => b("id", "=", userResult.id),
    });
    // Version has been incremented
    expect(updatedUser!.id.version).toBe(1);

    // Query emails with their users using join (since the relation is from emails to users)
    const emailsWithUsers = await queryEngine.findMany("emails", {
      join: (b) => b.user({ select: ["id", "name", "age"] }),
    });

    expect(emailsWithUsers).toHaveLength(2); // One row per email
    expect(emailsWithUsers[0]).toEqual({
      id: expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(Number),
      }),
      user_id: expect.objectContaining({
        internalId: expect.any(Number),
      }),
      email: expect.stringMatching(/\.com$/),
      is_primary: expect.any(Boolean),
      user: {
        id: expect.objectContaining({
          externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
          internalId: expect.any(Number),
        }),
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

  it("should execute Unit of Work with version checking", async () => {
    // Use the same namespace as the first test (migrations already ran)
    const queryEngine = adapter.createQueryEngine(testSchema, "test");

    // Create initial user
    const initialUser = await queryEngine.create("users", {
      name: "Alice",
      age: 25,
    });

    expect(initialUser.id.version).toBe(0);

    // Build a UOW to update the user with optimistic locking
    const uow = queryEngine
      .createUnitOfWork("update-user-age")
      // Retrieval phase: find the user
      .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", initialUser.id)));

    // Execute retrieval and transition to mutation phase
    const [users] = await uow.executeRetrieve();

    // Mutation phase: update with version check
    uow.update("users", initialUser.id, (b) => b.set({ age: 26 }).check());

    // Execute mutations
    const { success } = await uow.executeMutations();

    // Should succeed
    expect(success).toBe(true);
    expect(users).toHaveLength(1);

    // Verify the user was updated
    const updatedUser = await queryEngine.findFirst("users", {
      where: (b) => b("id", "=", initialUser.id),
    });

    expect(updatedUser).toMatchObject({
      id: expect.objectContaining({
        externalId: initialUser.id.externalId,
        version: 1, // Version incremented
      }),
      name: "Alice",
      age: 26,
    });

    // Try to update again with stale version (should fail)
    const uow2 = queryEngine.createUnitOfWork("update-user-stale");

    // Use the old version (0) which is now stale
    uow2.update("users", initialUser.id, (b) => b.set({ age: 27 }).check());

    const { success: success2 } = await uow2.executeMutations();

    // Should fail due to version conflict
    expect(success2).toBe(false);

    // Verify the user was NOT updated
    const [[unchangedUser]] = await queryEngine
      .createUnitOfWork("verify-unchanged")
      .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", initialUser.id)))
      .executeRetrieve();

    expect(unchangedUser).toMatchObject({
      id: expect.objectContaining({
        version: 1, // Still version 1
      }),
      age: 26, // Still 26, not 27
    });

    const uow3 = queryEngine
      .createUnitOfWork("get-all-emails")
      .find("emails", (b) => b.whereIndex("primary").orderByIndex("unique_email", "desc"));
    const [allEmails] = await uow3.executeRetrieve();
    const userNames = allEmails.map((email) => email.email);
    expect(userNames).toEqual(["john.doe@example.com", "john.doe.work@company.com"]);
  });
});
