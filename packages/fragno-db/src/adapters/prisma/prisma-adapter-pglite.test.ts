import { PGlite } from "@electric-sql/pglite";
import { KyselyPGlite } from "kysely-pglite";
import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { PrismaAdapter } from "./prisma-adapter";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import { Cursor } from "../../query/cursor";
import { PGLiteDriverConfig } from "../generic-sql/driver-config";
import { internalSchema } from "../../fragments/internal-fragment";

describe("PrismaAdapter PGLite", () => {
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

  beforeAll(async () => {
    const pgliteDatabase = new PGlite();

    const { dialect } = new KyselyPGlite(pgliteDatabase);

    adapter = new PrismaAdapter({
      dialect,
      driverConfig: new PGLiteDriverConfig(),
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
    };
  }, 12000);

  it("should execute Unit of Work with version checking", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");

    const createUow = queryEngine.createUnitOfWork("create-users");
    createUow.create("users", {
      name: "Prisma PGLite Alice",
      age: 25,
    });
    createUow.create("users", {
      name: "Prisma PGLite Bob",
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

    const initialUserId = createdIds[0];

    const uow = queryEngine
      .createUnitOfWork("update-user-age")
      .find("users", (b) => b.whereIndex("primary", (eb) => eb("id", "=", initialUserId)));

    const [users] = await uow.executeRetrieve();

    uow.update("users", initialUserId, (b) => b.set({ age: 26 }).check());

    const { success } = await uow.executeMutations();
    expect(success).toBe(true);
    expect(users).toHaveLength(1);
    expect(users[0].name).toBe("Prisma PGLite Alice");

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

    const createUow = queryEngine.createUnitOfWork("create-users-count");
    createUow.create("users", { name: "Prisma PGLite Count 1", age: 21 });
    createUow.create("users", { name: "Prisma PGLite Count 2", age: 31 });
    createUow.create("users", { name: "Prisma PGLite Count 3", age: 41 });
    await createUow.executeMutations();

    const [totalCount] = await queryEngine
      .createUnitOfWork("count-all")
      .find("users", (b) => b.whereIndex("primary").selectCount())
      .executeRetrieve();

    expect(totalCount).toBeGreaterThanOrEqual(3);
    expect(typeof totalCount).toBe("number");
  });

  it("should support cursor-based pagination with findWithCursor()", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");
    const prefix = "Prisma PGLite Cursor";

    for (let i = 1; i <= 12; i++) {
      await queryEngine.create("users", {
        name: `${prefix} ${i.toString().padStart(2, "0")}`,
        age: 20 + i,
      });
    }

    const firstPage = await queryEngine.findWithCursor("users", (b) =>
      b
        .whereIndex("name_idx", (eb) => eb("name", "starts with", prefix))
        .orderByIndex("name_idx", "asc")
        .pageSize(5),
    );

    expect(firstPage.items).toHaveLength(5);
    expect(firstPage.hasNextPage).toBe(true);
    expect(firstPage.cursor).toBeInstanceOf(Cursor);

    const secondPage = await queryEngine.findWithCursor("users", (b) =>
      b
        .whereIndex("name_idx", (eb) => eb("name", "starts with", prefix))
        .after(firstPage.cursor!)
        .orderByIndex("name_idx", "asc")
        .pageSize(5),
    );

    expect(secondPage.items).toHaveLength(5);
    expect(secondPage.hasNextPage).toBe(true);
    expect(secondPage.cursor).toBeInstanceOf(Cursor);

    const thirdPage = await queryEngine.findWithCursor("users", (b) =>
      b
        .whereIndex("name_idx", (eb) => eb("name", "starts with", prefix))
        .after(secondPage.cursor!)
        .orderByIndex("name_idx", "asc")
        .pageSize(5),
    );

    expect(thirdPage.items).toHaveLength(2);
    expect(thirdPage.hasNextPage).toBe(false);
    expect(thirdPage.cursor).toBeUndefined();
  });

  it("should support findWithCursor() in Unit of Work", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");
    const prefix = "Prisma PGLite UOW Cursor";

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

  it("should roundtrip DateTime, Date, JSON, and BigInt", async () => {
    const queryEngine = adapter.createQueryEngine(testSchema, "namespace");
    const beforeCreate = Date.now();
    const happenedOn = new Date("2024-06-15T00:00:00.000Z");
    const payload = { level: "info", tags: ["launch", "pglite"] };
    const bigScore = 9876543210123n;

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
    expect(createdAtMs).toBeGreaterThan(0);
    expect(Math.abs(createdAtMs - beforeCreate)).toBeLessThan(24 * 60 * 60 * 1000);
    expect(Math.abs(createdAtMs - afterFetch)).toBeLessThan(24 * 60 * 60 * 1000);
  });
});
