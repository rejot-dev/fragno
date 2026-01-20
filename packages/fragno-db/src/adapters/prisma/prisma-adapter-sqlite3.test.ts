import SQLite from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { PrismaAdapter } from "./prisma-adapter";
import { column, idColumn, referenceColumn, schema, type FragnoId } from "../../schema/create";
import { Cursor } from "../../query/cursor";
import {
  createHandlerTxBuilder,
  createServiceTxBuilder,
} from "../../query/unit-of-work/execute-unit-of-work";
import { ExponentialBackoffRetryPolicy } from "../../query/unit-of-work/retry-policy";
import { BetterSQLite3DriverConfig } from "../generic-sql/driver-config";
import { internalSchema } from "../../fragments/internal-fragment";
import { sqliteStorageDefault, sqliteStoragePrisma } from "../generic-sql/sqlite-storage";

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

  const schema2 = schema((s) => {
    return s
      .addTable("products", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("price", column("integer"))
          .createIndex("name_idx", ["name"]);
      })
      .addTable("orders", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("product_id", referenceColumn())
          .addColumn("quantity", column("integer"))
          .createIndex("product_orders_idx", ["product_id"]);
      })
      .addReference("product", {
        type: "one",
        from: { table: "orders", column: "product_id" },
        to: { table: "products", column: "id" },
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

    {
      const migrations = adapter.prepareMigrations(schema2, "namespace2");
      await migrations.executeWithDriver(adapter.driver, 0);
    }

    return async () => {
      await adapter.close();
      sqliteDatabase.close();
    };
  }, 12000);

  it("should default sqlite storage mode to prisma", () => {
    expect(adapter.sqliteStorageMode).toBe(sqliteStoragePrisma);
  });

  it("should default schema generator output path to fragno.prisma", () => {
    const generator = adapter.createSchemaGenerator([
      { schema: testSchema, namespace: "namespace" },
    ]);

    const { path } = generator.generateSchema();

    expect(path).toBe("fragno.prisma");
  });

  it("should store prisma storage values using sqlite-friendly types", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");
    const happenedOn = new Date("2024-06-18T12:34:56.789Z");
    const bigScore = 12345n;

    const createUow = queryEngine.createUnitOfWork("create-prisma-storage-event");
    createUow.create("events", {
      name: "Prisma Storage Event",
      happened_on: happenedOn,
      payload: { level: "info", tags: ["sqlite", "prisma"] },
      big_score: bigScore,
    });
    await createUow.executeMutations();

    const tableName = adapter.createTableNameMapper("namespace").toPhysical("events");
    const row = sqliteDatabase
      .prepare(`SELECT happened_on, big_score FROM ${tableName} WHERE name = ?`)
      .get("Prisma Storage Event") as { happened_on?: unknown; big_score?: unknown } | undefined;

    expect(typeof row?.happened_on).toBe("string");
    expect(row?.happened_on).toBe(happenedOn.toISOString());
    expect(row?.big_score).not.toBeInstanceOf(Buffer);
    expect(["number", "bigint"]).toContain(typeof row?.big_score);
  });

  it("should honor explicit sqlite storage overrides", async () => {
    const fragnoDatabase = new SQLite(":memory:");
    const fragnoDialect = new SqliteDialect({ database: fragnoDatabase });
    const fragnoAdapter = new PrismaAdapter({
      dialect: fragnoDialect,
      driverConfig: new BetterSQLite3DriverConfig(),
      sqliteStorageMode: sqliteStorageDefault,
    });

    try {
      const internalMigrations = fragnoAdapter.prepareMigrations(internalSchema, "");
      await internalMigrations.executeWithDriver(fragnoAdapter.driver, 0);

      const migrations = fragnoAdapter.prepareMigrations(testSchema, "namespace");
      await migrations.executeWithDriver(fragnoAdapter.driver, 0);

      expect(fragnoAdapter.sqliteStorageMode).toBe(sqliteStorageDefault);

      const queryEngine = fragnoAdapter.createQueryEngine(testSchema, "namespace");
      const happenedOn = new Date("2024-06-18T12:34:56.789Z");
      const bigScore = 1234567890123n;

      const createUow = queryEngine.createUnitOfWork("create-fragno-storage-event");
      createUow.create("events", {
        name: "Fragno Storage Event",
        happened_on: happenedOn,
        payload: { level: "info", tags: ["sqlite", "fragno"] },
        big_score: bigScore,
      });
      await createUow.executeMutations();

      const tableName = fragnoAdapter.createTableNameMapper("namespace").toPhysical("events");
      const row = fragnoDatabase
        .prepare(`SELECT happened_on, big_score FROM ${tableName} WHERE name = ?`)
        .get("Fragno Storage Event") as { happened_on?: number; big_score?: Buffer } | undefined;

      expect(typeof row?.happened_on).toBe("number");
      expect(row?.happened_on).toBe(happenedOn.getTime());
      expect(row?.big_score).toBeInstanceOf(Buffer);
      expect(row?.big_score?.readBigInt64BE(0)).toBe(bigScore);
    } finally {
      await fragnoAdapter.close();
      fragnoDatabase.close();
    }
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

    const uow2 = queryEngine.createUnitOfWork("update-user-stale");
    uow2.update("users", initialUserId, (b) => b.set({ age: 27 }).check());

    const { success: success2 } = await uow2.executeMutations();
    expect(success2).toBe(false);

    const [[unchangedUser]] = await queryEngine
      .createUnitOfWork("verify-unchanged")
      .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", initialUserId)))
      .executeRetrieve();

    expect(unchangedUser).toMatchObject({
      id: expect.objectContaining({
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

  it("should support findWithCursor() in Unit of Work", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");
    const prefix = "Prisma SQLite UOW Cursor";

    for (let i = 1; i <= 6; i++) {
      await queryEngine.create("users", {
        name: `${prefix} ${i}`,
        age: 40 + i,
      });
    }

    const uow = queryEngine.createUnitOfWork("cursor-test").findWithCursor("users", (b) =>
      b
        .whereIndex("name_idx", (eb) => eb("name", "starts with", prefix))
        .orderByIndex("name_idx", "asc")
        .pageSize(5),
    );

    const [result] = await uow.executeRetrieve();

    expect(result.items).toHaveLength(5);
    expect(typeof result.hasNextPage).toBe("boolean");
    expect(result.cursor).toBeInstanceOf(Cursor);
  });

  it("should support forSchema for multi-schema queries", async () => {
    const queryEngine1 = adapter.createQueryEngine(testSchema, "namespace");
    const queryEngine2 = adapter.createQueryEngine(schema2, "namespace2");

    const createUsersUow = queryEngine1.createUnitOfWork("create-users-for-multi-schema");
    createUsersUow.create("users", { name: "Prisma Multi Schema User 1", age: 25 });
    createUsersUow.create("users", { name: "Prisma Multi Schema User 2", age: 30 });
    const { success: usersSuccess } = await createUsersUow.executeMutations();
    expect(usersSuccess).toBe(true);

    const createProductsUow = queryEngine2.createUnitOfWork("create-products-for-multi-schema");
    createProductsUow.create("products", { name: "Prisma Product A", price: 100 });
    createProductsUow.create("products", { name: "Prisma Product B", price: 200 });
    const { success: productsSuccess } = await createProductsUow.executeMutations();
    expect(productsSuccess).toBe(true);

    const uow = queryEngine1.createUnitOfWork("multi-schema-query");

    const view1 = uow
      .forSchema(testSchema)
      .find("users", (b) =>
        b
          .whereIndex("name_idx", (eb) => eb("name", "starts with", "Prisma Multi Schema User"))
          .select(["id", "name"]),
      )
      .find("users", (b) =>
        b
          .whereIndex("name_idx", (eb) => eb("name", "starts with", "Prisma Multi Schema User"))
          .select(["name", "age"]),
      );

    const view2 = uow
      .forSchema(schema2)
      .find("products", (b) => b.whereIndex("primary").select(["name", "price"]));

    await uow.executeRetrieve();

    const [users1, users2] = await view1.retrievalPhase;
    const [user1] = users1;
    expectTypeOf(user1).toMatchObjectType<{ id: FragnoId; name: string }>();

    const [user2] = users2;
    expectTypeOf(user2).toMatchObjectType<{ name: string; age: number | null }>();

    const [products] = await view2.retrievalPhase;
    const [product1] = products;
    expectTypeOf(product1).toMatchObjectType<{ name: string; price: number }>();

    expect(users1).toHaveLength(2);
    expect(users1[0]).toMatchObject({
      id: expect.any(Object),
      name: "Prisma Multi Schema User 1",
    });
    expect(users1[1]).toMatchObject({
      id: expect.any(Object),
      name: "Prisma Multi Schema User 2",
    });

    expect(users2).toHaveLength(2);
    expect(users2[0]).toMatchObject({
      name: "Prisma Multi Schema User 1",
      age: 25,
    });
    expect(users2[1]).toMatchObject({
      name: "Prisma Multi Schema User 2",
      age: 30,
    });

    expect(products).toHaveLength(2);
    expect(products[0]).toMatchObject({
      name: "Prisma Product A",
      price: 100,
    });
    expect(products[1]).toMatchObject({
      name: "Prisma Product B",
      price: 200,
    });
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

  it("should support inserting with external id string", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    const createUserUow = queryEngine.createUnitOfWork("create-user-for-external-id");
    createUserUow.create("users", { name: "Prisma SQLite External ID User", age: 35 });
    await createUserUow.executeMutations();

    const [[user]] = await queryEngine
      .createUnitOfWork("get-user-for-external-id")
      .find("users", (b) =>
        b.whereIndex("name_idx", (eb) => eb("name", "=", "Prisma SQLite External ID User")),
      )
      .executeRetrieve();

    const createEmailUow = queryEngine.createUnitOfWork("create-email-with-external-id");
    createEmailUow.create("emails", {
      user_id: user.id.externalId,
      email: "prisma-sqlite-external-id@example.com",
      is_primary: false,
    });

    const { success } = await createEmailUow.executeMutations();
    expect(success).toBe(true);

    const [[email]] = await queryEngine
      .createUnitOfWork("get-email-by-external-id")
      .find("emails", (b) =>
        b
          .whereIndex("unique_email", (eb) =>
            eb("email", "=", "prisma-sqlite-external-id@example.com"),
          )
          .join((jb) => jb.user((builder) => builder.select(["name", "id"]))),
      )
      .executeRetrieve();

    expect(email).toMatchObject({
      email: "prisma-sqlite-external-id@example.com",
      is_primary: false,
      user_id: expect.objectContaining({
        internalId: user.id.internalId,
      }),
      user: {
        id: expect.objectContaining({
          externalId: user.id.externalId,
        }),
        name: "Prisma SQLite External ID User",
      },
    });
  });

  it("should create user and post in same transaction using returned ID", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    const uow = queryEngine.createUnitOfWork("create-user-and-post");
    const userId = uow.create("users", {
      name: "Prisma SQLite UOW User",
      age: 35,
    });

    const postId = uow.create("posts", {
      user_id: userId,
      title: "Prisma SQLite UOW Post",
      content: "This post was created in the same transaction as the user",
    });

    const { success } = await uow.executeMutations();
    expect(success).toBe(true);

    const userIdStr = userId.toString();
    const postIdStr = postId.toString();

    const [[user]] = await queryEngine
      .createUnitOfWork("verify-user")
      .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userIdStr)))
      .executeRetrieve();

    const [[post]] = await queryEngine
      .createUnitOfWork("verify-post")
      .find("posts", (b) => b.whereIndex("primary", (eb) => eb("id", "=", postIdStr)))
      .executeRetrieve();

    expect(user.name).toBe("Prisma SQLite UOW User");
    expect(user.age).toBe(35);
    expect(post.title).toBe("Prisma SQLite UOW Post");
    expect(post.content).toBe("This post was created in the same transaction as the user");
    expect(post.user_id.internalId).toBe(user.id.internalId);
  });

  it("should support complex nested joins (comments -> post -> author)", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    const createAuthorUow = queryEngine.createUnitOfWork("create-author");
    createAuthorUow.create("users", { name: "Prisma SQLite Author", age: 30 });
    await createAuthorUow.executeMutations();

    const [[author]] = await queryEngine
      .createUnitOfWork("get-author")
      .find("users", (b) =>
        b.whereIndex("name_idx", (eb) => eb("name", "=", "Prisma SQLite Author")),
      )
      .executeRetrieve();

    const createPostUow = queryEngine.createUnitOfWork("create-post");
    createPostUow.create("posts", {
      user_id: author.id,
      title: "Prisma SQLite Post",
      content: "Nested join content",
    });
    await createPostUow.executeMutations();

    const [[post]] = await queryEngine
      .createUnitOfWork("get-post")
      .find("posts", (b) => b.whereIndex("posts_user_idx", (eb) => eb("user_id", "=", author.id)))
      .executeRetrieve();

    const createCommenterUow = queryEngine.createUnitOfWork("create-commenter");
    createCommenterUow.create("users", { name: "Prisma SQLite Commenter", age: 25 });
    await createCommenterUow.executeMutations();

    const [[commenter]] = await queryEngine
      .createUnitOfWork("get-commenter")
      .find("users", (b) =>
        b.whereIndex("name_idx", (eb) => eb("name", "=", "Prisma SQLite Commenter")),
      )
      .executeRetrieve();

    const createCommentUow = queryEngine.createUnitOfWork("create-comment");
    createCommentUow.create("comments", {
      post_id: post.id,
      user_id: commenter.id,
      text: "Great Prisma post!",
    });
    await createCommentUow.executeMutations();

    const uow = queryEngine.createUnitOfWork("test-complex-joins").find("comments", (b) =>
      b.whereIndex("primary").join((jb) =>
        jb
          .post((postBuilder) =>
            postBuilder
              .select(["id", "title", "content"])
              .orderByIndex("primary", "desc")
              .pageSize(1)
              .join((jb2) =>
                jb2.author((authorBuilder) =>
                  authorBuilder.select(["id", "name", "age"]).orderByIndex("name_idx", "asc"),
                ),
              ),
          )
          .commenter((commenterBuilder) => commenterBuilder.select(["id", "name"])),
      ),
    );

    const [[comment]] = await uow.executeRetrieve();

    expect(comment).toMatchObject({
      id: expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(BigInt),
      }),
      text: "Great Prisma post!",
      post: {
        id: expect.objectContaining({
          externalId: post.id.externalId,
        }),
        title: "Prisma SQLite Post",
        content: "Nested join content",
        author: {
          id: expect.objectContaining({
            externalId: author.id.externalId,
          }),
          name: "Prisma SQLite Author",
          age: 30,
        },
      },
      commenter: {
        id: expect.objectContaining({
          externalId: commenter.id.externalId,
        }),
        name: "Prisma SQLite Commenter",
      },
    });
  });

  it("should return created IDs from UOW create operations", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    const uow1 = queryEngine.createUnitOfWork("create-multiple-users");
    uow1.create("users", { name: "Prisma ID User 1", age: 30 });
    uow1.create("users", { name: "Prisma ID User 2", age: 35 });
    uow1.create("users", { name: "Prisma ID User 3", age: 40 });

    const { success: success1 } = await uow1.executeMutations();
    expect(success1).toBe(true);

    const createdIds1 = uow1.getCreatedIds();
    expect(createdIds1).toMatchObject([
      expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(BigInt),
      }),
      expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(BigInt),
      }),
      expect.objectContaining({
        externalId: expect.stringMatching(/^[a-z0-9]{20,}$/),
        internalId: expect.any(BigInt),
      }),
    ]);

    const externalIds = createdIds1.map((id) => id.externalId);
    expect(new Set(externalIds).size).toBe(3);

    const user1 = await queryEngine.findFirst("users", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", createdIds1[0].externalId)),
    );
    const user2 = await queryEngine.findFirst("users", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", createdIds1[1].externalId)),
    );
    const user3 = await queryEngine.findFirst("users", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", createdIds1[2].externalId)),
    );

    expect(user1).toMatchObject({
      id: expect.objectContaining({
        externalId: createdIds1[0].externalId,
      }),
      name: "Prisma ID User 1",
      age: 30,
    });

    expect(user2).toMatchObject({
      id: expect.objectContaining({
        externalId: createdIds1[1].externalId,
      }),
      name: "Prisma ID User 2",
      age: 35,
    });

    expect(user3).toMatchObject({
      id: expect.objectContaining({
        externalId: createdIds1[2].externalId,
      }),
      name: "Prisma ID User 3",
      age: 40,
    });

    const uow2 = queryEngine.createUnitOfWork("mixed-operations");
    uow2.create("users", { name: "Prisma New User", age: 50 });
    uow2.update("users", createdIds1[0], (b) => b.set({ age: 31 }));
    uow2.create("users", { name: "Prisma Another New User", age: 55 });
    uow2.delete("users", createdIds1[2]);

    const { success: success2 } = await uow2.executeMutations();
    expect(success2).toBe(true);

    const createdIds2 = uow2.getCreatedIds();
    expect(createdIds2).toHaveLength(2);
    expect(createdIds2[0].externalId).toBeDefined();
    expect(createdIds2[1].externalId).toBeDefined();

    const customId = "prisma-custom-user-id-12345";
    const uow3 = queryEngine.createUnitOfWork("create-with-custom-id");
    uow3.create("users", { id: customId, name: "Prisma Custom ID User", age: 60 });

    const { success: success3 } = await uow3.executeMutations();
    expect(success3).toBe(true);

    const createdIds3 = uow3.getCreatedIds();
    expect(createdIds3).toHaveLength(1);
    expect(createdIds3[0].externalId).toBe(customId);
    expect(createdIds3[0].internalId).toBeDefined();

    const customIdUser = await queryEngine.findFirst("users", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", customId)),
    );

    expect(customIdUser).toMatchObject({
      id: expect.objectContaining({
        externalId: customId,
      }),
      name: "Prisma Custom ID User",
      age: 60,
    });
  });

  it("should handle timestamps and timezones correctly", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    const createUow = queryEngine.createUnitOfWork("create-event-for-timestamp");
    createUow.create("events", {
      name: "Timestamp Event SQLite",
      happened_on: new Date("2024-06-18T00:00:00.000Z"),
      payload: { level: "info", tags: ["timestamp", "sqlite"] },
      big_score: 42n,
    });
    await createUow.executeMutations();

    const [[event]] = await queryEngine
      .createUnitOfWork("get-event-for-timestamp")
      .find("events", (b) =>
        b.whereIndex("events_name_idx", (eb) => eb("name", "=", "Timestamp Event SQLite")),
      )
      .executeRetrieve();

    expect(event.created_at).toBeInstanceOf(Date);

    const now = Date.now();
    const createdTime = event.created_at.getTime();
    expect(createdTime).toBeGreaterThan(now - 24 * 60 * 60 * 1000);
    expect(createdTime).toBeLessThan(now + 24 * 60 * 60 * 1000);

    expect(typeof event.created_at.toISOString).toBe("function");
    expect(typeof event.created_at.getTime).toBe("function");
    expect(typeof event.created_at.getTimezoneOffset).toBe("function");

    const isoString = event.created_at.toISOString();
    expect(new Date(isoString).getTime()).toBe(event.created_at.getTime());
  });

  it("should store Date values as UTC ISO strings for sqlite prisma storage", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");
    const happenedOn = new Date("2024-06-18T12:34:56.789Z");

    const createUow = queryEngine.createUnitOfWork("create-iso-event");
    createUow.create("events", {
      name: "ISO Stored Event",
      happened_on: happenedOn,
      payload: { level: "info", tags: ["sqlite", "iso"] },
      big_score: 7n,
    });
    await createUow.executeMutations();

    const tableName = adapter.createTableNameMapper("namespace").toPhysical("events");
    const row = sqliteDatabase
      .prepare(`SELECT happened_on FROM ${tableName} WHERE name = ?`)
      .get("ISO Stored Event") as { happened_on?: string } | undefined;

    expect(row?.happened_on).toBe(happenedOn.toISOString());
  });

  it("should support handlerTx with retry logic", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    const createUow = queryEngine.createUnitOfWork("create-user-for-execute-uow");
    createUow.create("users", { name: "Prisma Execute UOW User", age: 42 });
    await createUow.executeMutations();

    const [[user]] = await queryEngine
      .createUnitOfWork("get-user-for-execute-uow")
      .find("users", (b) =>
        b.whereIndex("name_idx", (eb) => eb("name", "=", "Prisma Execute UOW User")),
      )
      .executeRetrieve();

    let currentUow: ReturnType<typeof queryEngine.createUnitOfWork> | null = null;

    const getUserById = (userId: typeof user.id) => {
      return createServiceTxBuilder(testSchema, currentUow!)
        .retrieve((uow) =>
          uow.find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", userId))),
        )
        .transformRetrieve(([users]) => users[0] ?? null)
        .build();
    };

    const result = await createHandlerTxBuilder({
      createUnitOfWork: () => {
        currentUow = queryEngine.createUnitOfWork("execute-uow-update");
        return currentUow;
      },
      retryPolicy: new ExponentialBackoffRetryPolicy({ maxRetries: 3, initialDelayMs: 1 }),
    })
      .withServiceCalls(() => [getUserById(user.id)])
      .mutate(({ forSchema, serviceIntermediateResult: [foundUser] }) => {
        if (!foundUser) {
          throw new Error("User not found");
        }
        const newAge = foundUser.age! + 1;
        forSchema(testSchema).update("users", foundUser.id, (b) => b.set({ age: newAge }).check());
        return { previousAge: foundUser.age, newAge };
      })
      .transform(({ mutateResult }) => {
        expect(mutateResult.newAge).toBe(mutateResult.previousAge! + 1);
        return mutateResult;
      })
      .execute();

    expect(result).toEqual({
      previousAge: 42,
      newAge: 43,
    });

    const updatedUser = await queryEngine.findFirst("users", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", user.id)),
    );

    expect(updatedUser).toMatchObject({
      id: expect.objectContaining({
        externalId: user.id.externalId,
        version: 1,
      }),
      name: "Prisma Execute UOW User",
      age: 43,
    });
  });

  it("should fail check() when version changes", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    const createUserUow = queryEngine.createUnitOfWork("create-user-for-version-conflict");
    createUserUow.create("users", {
      name: "Prisma Version Conflict User",
      age: 40,
    });
    await createUserUow.executeMutations();

    const [[user]] = await queryEngine
      .createUnitOfWork("get-user-for-version-conflict")
      .find("users", (b) =>
        b.whereIndex("name_idx", (eb) => eb("name", "=", "Prisma Version Conflict User")),
      )
      .executeRetrieve();

    const updateUow = queryEngine.createUnitOfWork("update-user-version");
    updateUow.update("users", user.id, (b) => b.set({ age: 41 }));
    await updateUow.executeMutations();

    const uow = queryEngine.createUnitOfWork("check-stale-version");
    uow.check("users", user.id);
    uow.create("posts", {
      user_id: user.id,
      title: "Prisma Should Not Be Created",
      content: "Content",
    });

    const { success } = await uow.executeMutations();
    expect(success).toBe(false);

    const [posts] = await queryEngine
      .createUnitOfWork("get-posts-for-version-conflict")
      .find("posts", (b) => b.whereIndex("posts_user_idx", (eb) => eb("user_id", "=", user.id)))
      .executeRetrieve();

    const conflictPosts = posts.filter((p) => p.title === "Prisma Should Not Be Created");
    expect(conflictPosts).toHaveLength(0);
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

  it("should parse CURRENT_TIMESTAMP strings as UTC", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");
    const tableName = adapter.createTableNameMapper("namespace").toPhysical("events");

    const createUow = queryEngine.createUnitOfWork("create-utc-event");
    createUow.create("events", {
      name: "UTC Timestamp",
      happened_on: new Date("2024-06-15T00:00:00.000Z"),
      payload: { level: "info", tags: ["sqlite", "utc"] },
      big_score: 42n,
    });
    await createUow.executeMutations();

    sqliteDatabase
      .prepare(`UPDATE ${tableName} SET created_at = ? WHERE name = ?`)
      .run("2024-06-15 14:30:00", "UTC Timestamp");

    const [[event]] = await queryEngine
      .createUnitOfWork("get-utc-event")
      .find("events", (b) =>
        b.whereIndex("events_name_idx", (eb) => eb("name", "=", "UTC Timestamp")),
      )
      .executeRetrieve();

    expect(event.created_at).toBeInstanceOf(Date);
    expect(event.created_at.toISOString()).toBe("2024-06-15T14:30:00.000Z");
  });

  it("should roundtrip BigInt when sqlite returns bigint values", async () => {
    sqliteDatabase.defaultSafeIntegers(true);
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");
    const safeIntegerLimit = BigInt(Number.MAX_SAFE_INTEGER);
    const bigScore = safeIntegerLimit + 42n;

    try {
      const createUow = queryEngine.createUnitOfWork("create-safe-bigint-event");
      createUow.create("events", {
        name: "Safe BigInt",
        happened_on: new Date("2024-06-17T00:00:00.000Z"),
        payload: { level: "info", tags: ["sqlite", "safe-bigint"] },
        big_score: bigScore,
      });
      await createUow.executeMutations();

      const [[event]] = await queryEngine
        .createUnitOfWork("get-safe-bigint-event")
        .find("events", (b) =>
          b.whereIndex("events_name_idx", (eb) => eb("name", "=", "Safe BigInt")),
        )
        .executeRetrieve();

      expect(event.big_score).toBe(bigScore);
    } finally {
      sqliteDatabase.defaultSafeIntegers(false);
    }
  });

  it("should throw when sqlite returns unsafe BigInt numbers", async () => {
    sqliteDatabase.defaultSafeIntegers(false);
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");
    const unsafeBigScore = BigInt(Number.MAX_SAFE_INTEGER) + 2n;

    try {
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
    } finally {
      sqliteDatabase.defaultSafeIntegers(false);
    }
  });
});
