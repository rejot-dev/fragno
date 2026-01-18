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
      "users" | "emails" | "posts" | "comments"
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
});
