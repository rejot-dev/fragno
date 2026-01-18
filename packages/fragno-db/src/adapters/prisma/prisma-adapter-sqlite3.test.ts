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
      .addTable("events", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn(
            "created_at",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .addColumn("happened_on", column("date"))
          .addColumn("payload", column("json").nullable())
          .addColumn("big_score", column("bigint"))
          .createIndex("events_name_idx", ["name"]);
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
      "users" | "emails" | "posts" | "comments" | "events"
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

  it("should support count operations", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    const createUow = queryEngine.createUnitOfWork("create-count-users");
    createUow.create("users", { name: "Prisma SQLite Count 1", age: 20 });
    createUow.create("users", { name: "Prisma SQLite Count 2", age: 30 });
    createUow.create("users", { name: "Prisma SQLite Count 3", age: 40 });
    await createUow.executeMutations();

    const [totalCount] = await queryEngine
      .createUnitOfWork("count-all")
      .find("users", (b) => b.whereIndex("primary").selectCount())
      .executeRetrieve();

    expect(totalCount).toBeGreaterThanOrEqual(3);
    expect(typeof totalCount).toBe("number");
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

  it("should verify hasNextPage in cursor pagination", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");
    const prefix = "Prisma SQLite HasNextPage";

    for (let i = 1; i <= 15; i++) {
      await queryEngine.create("users", {
        name: `${prefix} ${i.toString().padStart(2, "0")}`,
        age: 20 + i,
      });
    }

    const firstPage = await queryEngine.findWithCursor("users", (b) =>
      b
        .whereIndex("name_idx", (eb) => eb("name", "starts with", prefix))
        .orderByIndex("name_idx", "asc")
        .pageSize(10),
    );

    expect(firstPage.items).toHaveLength(10);
    expect(firstPage.hasNextPage).toBe(true);
    expect(firstPage.cursor).toBeInstanceOf(Cursor);

    const secondPage = await queryEngine.findWithCursor("users", (b) =>
      b
        .whereIndex("name_idx", (eb) => eb("name", "starts with", prefix))
        .after(firstPage.cursor!)
        .orderByIndex("name_idx", "asc")
        .pageSize(10),
    );

    expect(secondPage.items).toHaveLength(5);
    expect(secondPage.hasNextPage).toBe(false);
    expect(secondPage.cursor).toBeUndefined();

    const emptyPage = await queryEngine.findWithCursor("users", (b) =>
      b
        .whereIndex("name_idx", (eb) => eb("name", "starts with", "NoMatchPrefix"))
        .orderByIndex("name_idx", "asc")
        .pageSize(10),
    );

    expect(emptyPage.items).toHaveLength(0);
    expect(emptyPage.hasNextPage).toBe(false);
    expect(emptyPage.cursor).toBeUndefined();
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

  it("should roundtrip Prisma SQLite DateTime, Date, JSON, and BigInt", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");
    const beforeCreate = Date.now();
    const happenedOn = new Date("2024-06-15T00:00:00.000Z");
    const payload = { level: "info", tags: ["launch", "sqlite"] };
    const bigScore = 1234567890123n;

    const createUow = queryEngine.createUnitOfWork("create-event");
    createUow.create("events", {
      name: "Launch",
      happened_on: happenedOn,
      payload,
      big_score: bigScore,
    });
    await createUow.executeMutations();

    const [[event]] = await queryEngine
      .createUnitOfWork("get-event")
      .find("events", (b) => b.whereIndex("events_name_idx", (eb) => eb("name", "=", "Launch")))
      .executeRetrieve();

    expect(event).toBeDefined();
    expect(event.name).toBe("Launch");
    expect(event.payload).toEqual(payload);
    expect(event.big_score).toBe(bigScore);
    expect(event.happened_on).toBeInstanceOf(Date);
    expect(event.happened_on.toISOString()).toBe(happenedOn.toISOString());
    expect(event.created_at).toBeInstanceOf(Date);

    const createdAtMs = event.created_at.getTime();
    const afterFetch = Date.now();
    expect(createdAtMs).toBeGreaterThanOrEqual(beforeCreate - 5 * 60 * 1000);
    expect(createdAtMs).toBeLessThanOrEqual(afterFetch + 5 * 60 * 1000);
  });

  it("should throw when sqlite returns unsafe BigInt numbers", async () => {
    sqliteDatabase.defaultSafeIntegers(false);
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");
    const unsafeBigScore = BigInt(Number.MAX_SAFE_INTEGER) + 2n;

    const createUow = queryEngine.createUnitOfWork("create-unsafe-event");
    createUow.create("events", {
      name: "Unsafe BigInt",
      happened_on: new Date("2024-06-16T00:00:00.000Z"),
      payload: { level: "warn", tags: ["sqlite", "unsafe-bigint"] },
      big_score: unsafeBigScore,
    });
    await createUow.executeMutations();

    await expect(
      queryEngine
        .createUnitOfWork("get-unsafe-event")
        .find("events", (b) =>
          b.whereIndex("events_name_idx", (eb) => eb("name", "=", "Unsafe BigInt")),
        )
        .executeRetrieve(),
    ).rejects.toThrow(/Number\.MAX_SAFE_INTEGER/);
  });
});
