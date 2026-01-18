import SQLite from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { PrismaAdapter } from "./prisma-adapter";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import { Cursor } from "../../query/cursor";
import { BetterSQLite3DriverConfig } from "../generic-sql/driver-config";
import { internalSchema } from "../../fragments/internal-fragment";

describe("PrismaAdapter SQLite", () => {
  const testSchema = schema((s) => {
    return s
      .addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("age", column("integer").nullable())
          .createIndex("name_idx", ["name"]);
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
        from: { table: "comments", column: "post_id" },
        to: { table: "posts", column: "id" },
      })
      .addReference("commenter", {
        type: "one",
        from: { table: "comments", column: "user_id" },
        to: { table: "users", column: "id" },
      });
  });

  let adapter: PrismaAdapter;
  let sqliteDatabase: InstanceType<typeof SQLite>;

  beforeAll(async () => {
    sqliteDatabase = new SQLite(":memory:");

    const dialect = new SqliteDialect({
      database: sqliteDatabase,
    });

    adapter = new PrismaAdapter({
      dialect,
      driverConfig: new BetterSQLite3DriverConfig(),
    });

    {
      const migrations = adapter.prepareMigrations(internalSchema, "");
      await migrations.executeWithDriver(adapter.driver, 0);
    }

    {
      const migrations = adapter.prepareMigrations(testSchema, "namespace");
      await migrations.executeWithDriver(adapter.driver, 0);
    }

    return async () => {
      await adapter.close();
      sqliteDatabase.close();
    };
  }, 12000);

  it("should default sqlite profile to prisma", () => {
    expect(adapter.driverConfig.sqliteProfile).toBe("prisma");
  });

  it("should execute Unit of Work with version checking", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    const createUow = queryEngine.createUnitOfWork("create-users");
    createUow.create("users", {
      name: "Prisma SQLite Alice",
      age: 25,
    });
    createUow.create("users", {
      name: "Prisma SQLite Bob",
      age: 30,
    });

    expectTypeOf<keyof typeof testSchema.tables>().toEqualTypeOf<
      Parameters<typeof createUow.find>[0]
    >();
    expectTypeOf<keyof typeof testSchema.tables>().toEqualTypeOf<
      "users" | "emails" | "posts" | "comments"
    >();

    const { success: createSuccess } = await createUow.executeMutations();
    expect(createSuccess).toBe(true);

    const createdIds = createUow.getCreatedIds();
    expect(createdIds).toHaveLength(2);

    const [createdUsers] = await queryEngine
      .createUnitOfWork("get-created-users")
      .find("users", (b) =>
        b.whereIndex("name_idx", (eb) =>
          eb("name", "in", ["Prisma SQLite Alice", "Prisma SQLite Bob"]),
        ),
      )
      .executeRetrieve();

    expect(createdUsers).toHaveLength(2);

    const initialUserId = createdIds[0];

    const uow = queryEngine
      .createUnitOfWork("update-user-age")
      .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", initialUserId)));

    const [users] = await uow.executeRetrieve();

    uow.update("users", initialUserId, (b) => b.set({ age: 26 }).check());

    const { success } = await uow.executeMutations();
    expect(success).toBe(true);
    expect(users).toHaveLength(1);
    expect(users[0].name).toBe("Prisma SQLite Alice");

    const [[updatedUser]] = await queryEngine
      .createUnitOfWork("get-updated-user")
      .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", initialUserId)))
      .executeRetrieve();

    expect(updatedUser).toMatchObject({
      id: expect.objectContaining({
        externalId: initialUserId.externalId,
        version: 1,
      }),
      age: 26,
    });
  });

  it("should support cursor-based pagination", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");
    const prefix = "Prisma SQLite Cursor";

    const createUow = queryEngine.createUnitOfWork("create-cursor-users");
    createUow.create("users", { name: `${prefix} A`, age: 20 });
    createUow.create("users", { name: `${prefix} B`, age: 30 });
    createUow.create("users", { name: `${prefix} C`, age: 40 });
    createUow.create("users", { name: `${prefix} D`, age: 50 });
    createUow.create("users", { name: `${prefix} E`, age: 60 });

    await createUow.executeMutations();

    const [firstPage] = await queryEngine
      .createUnitOfWork("first-page")
      .find("users", (b) =>
        b
          .whereIndex("name_idx", (eb) => eb("name", "starts with", prefix))
          .orderByIndex("name_idx", "asc")
          .pageSize(2),
      )
      .executeRetrieve();

    expect(firstPage).toHaveLength(2);
    expect(firstPage.map((u) => u.name)).toEqual([`${prefix} A`, `${prefix} B`]);

    const lastItem = firstPage[firstPage.length - 1]!;
    const cursor = new Cursor({
      indexName: "name_idx",
      orderDirection: "asc",
      pageSize: 2,
      indexValues: { name: lastItem.name },
    }).encode();

    const [secondPage] = await queryEngine
      .createUnitOfWork("second-page")
      .find("users", (b) =>
        b
          .whereIndex("name_idx", (eb) => eb("name", "starts with", prefix))
          .orderByIndex("name_idx", "asc")
          .after(cursor)
          .pageSize(2),
      )
      .executeRetrieve();

    expect(secondPage).toHaveLength(2);
    expect(secondPage.map((u) => u.name)).toEqual([`${prefix} C`, `${prefix} D`]);
  });

  it("should support joins", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    const createUserUow = queryEngine.createUnitOfWork("create-join-user");
    createUserUow.create("users", { name: "Prisma SQLite Email User", age: 20 });

    const { success } = await createUserUow.executeMutations();
    expect(success).toBe(true);

    const [usersResult] = await queryEngine
      .createUnitOfWork("get-created-user")
      .find("users", (b) =>
        b.whereIndex("name_idx", (eb) => eb("name", "=", "Prisma SQLite Email User")),
      )
      .executeRetrieve();

    expect(usersResult).toHaveLength(1);
    const createdUser = usersResult[0];
    expect(createdUser.name).toBe("Prisma SQLite Email User");

    const createEmailUow = queryEngine.createUnitOfWork("create-test-email");
    createEmailUow.create("emails", {
      user_id: createdUser.id,
      email: "prisma-sqlite@example.com",
      is_primary: true,
    });
    await createEmailUow.executeMutations();

    const uow = queryEngine
      .createUnitOfWork("test-joins")
      .find("emails", (b) =>
        b
          .whereIndex("user_emails", (eb) => eb("user_id", "=", createdUser.id))
          .join((jb) => jb.user((builder) => builder.select(["name", "id", "age"]))),
      );

    const [[email]] = await uow.executeRetrieve();

    expect(email).toMatchObject({
      id: expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(BigInt),
      }),
      user_id: expect.objectContaining({
        internalId: expect.any(BigInt),
      }),
      email: "prisma-sqlite@example.com",
      is_primary: true,
      user: {
        id: expect.objectContaining({
          externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
          internalId: expect.any(BigInt),
        }),
        name: "Prisma SQLite Email User",
        age: 20,
      },
    });
  });
});
