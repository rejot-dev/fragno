import { describe, test, expect, assert } from "vitest";

import { Cursor } from "../../../query/cursor";
import { schema, column, idColumn, referenceColumn, FragnoId } from "../../../schema/create";
import {
  BetterSQLite3DriverConfig,
  MySQL2DriverConfig,
  NodePostgresDriverConfig,
} from "../driver-config";
import { GenericSQLUOWOperationCompiler } from "./generic-sql-uow-operation-compiler";

const testSchema = schema("test", (s) => {
  return s
    .addTable("users", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("email", column("string"))
        .addColumn("age", column("integer").nullable())
        .addColumn("isActive", column("bool"))
        .addColumn("createdAt", column("timestamp"))
        .addColumn("invitedBy", referenceColumn({ table: "users" }).nullable())
        .createIndex("idx_email", ["email"], { unique: true })
        .createIndex("idx_name_email", ["name", "email"], { unique: true })
        .createIndex("idx_users_name", ["name"])
        .createIndex("idx_age", ["age"])
        .createIndex("idx_users_name_created_id", ["name", "createdAt", "id"]);
    })
    .addTable("posts", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("title", column("string"))
        .addColumn("content", column("text"))
        .addColumn("userId", referenceColumn({ table: "users" }))
        .addColumn("viewCount", column("integer").defaultTo(0))
        .addColumn("publishedAt", column("timestamp").nullable())
        .createIndex("idx_title", ["title"])
        .createIndex("idx_user", ["userId"]);
    })
    .addTable("comments", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("content", column("text"))
        .addColumn("postId", referenceColumn({ table: "posts" }))
        .addColumn("authorId", referenceColumn({ table: "users" }))
        .createIndex("idx_comments_post", ["postId"])
        .createIndex("idx_author", ["authorId"]);
    })
    .addTable("tags", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .createIndex("idx_tags_name", ["name"]);
    })
    .addTable("post_tags", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("postId", referenceColumn({ table: "posts" }))
        .addColumn("tagId", referenceColumn({ table: "tags" }))
        .createIndex("idx_post_tags_post", ["postId"])
        .createIndex("idx_tag", ["tagId"]);
    });
});

// Schema with custom-named id columns
const customIdSchema = schema("customid", (s) => {
  return s
    .addTable("products", (t) => {
      return t
        .addColumn("productId", idColumn())
        .addColumn("name", column("string"))
        .addColumn("price", column("integer"))
        .createIndex("idx_product_id", ["productId"]);
    })
    .addTable("orders", (t) => {
      return t
        .addColumn("orderId", idColumn())
        .addColumn("productRef", referenceColumn({ table: "products" }))
        .addColumn("quantity", column("integer"));
    })
    .addTable("categories", (t) => {
      return t
        .addColumn("categoryId", idColumn())
        .addColumn("categoryName", column("string"))
        .createIndex("idx_category_id", ["categoryId"]);
    })
    .addTable("product_categories", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("prodRef", referenceColumn({ table: "products" }))
        .addColumn("catRef", referenceColumn({ table: "categories" }))
        .createIndex("idx_prod", ["prodRef"])
        .createIndex("idx_cat", ["catRef"]);
    });
});

describe("GenericSQLUOWOperationCompiler", () => {
  const driverConfig = new BetterSQLite3DriverConfig();

  test("compileCount operation", () => {
    const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

    const result = compiler.compileCount({
      type: "count",
      schema: testSchema,
      table: testSchema.tables.users,
      indexName: "primary",
      options: {
        useIndex: "primary",
      },
    });

    expect(result).not.toBeNull();
    expect(result!.sql).toMatchInlineSnapshot(`"select count(*) as "count" from "users""`);
  });

  test("compileCount with where clause", () => {
    const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

    const result = compiler.compileCount({
      type: "count",
      schema: testSchema,
      table: testSchema.tables.users,
      indexName: "primary",
      options: {
        useIndex: "primary",
        where: (eb) => eb("age", ">", 18),
      },
    });

    expect(result).not.toBeNull();
    expect(result!.sql).toMatchInlineSnapshot(
      `"select count(*) as "count" from "users" where "users"."age" > ?"`,
    );
  });

  test("compileFind operation", () => {
    const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

    const result = compiler.compileFind({
      type: "find",
      schema: testSchema,
      table: testSchema.tables.users,
      indexName: "primary",
      options: {
        useIndex: "primary",
        select: true,
        pageSize: 10,
      },
    });

    expect(result).not.toBeNull();
    expect(result!.sql).toMatchInlineSnapshot(
      `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" limit ?"`,
    );
  });

  test("compileCreate operation", () => {
    const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

    const result = compiler.compileCreate({
      type: "create",
      schema: testSchema,
      table: "users",
      values: {
        name: "John",
        email: "john@example.com",
        age: 30,
      },
      generatedExternalId: "user123",
    });

    expect(result).not.toBeNull();
    expect(result!.query.sql).toMatchInlineSnapshot(
      `"insert into "users" ("id", "name", "email", "age") values (?, ?, ?, ?) returning "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version""`,
    );
    expect(result!.expectedAffectedRows).toBeNull();
  });

  test("compileCreate materializes runtime defaults once for execution and outbox", () => {
    let runtimeDefaultCalls = 0;
    const runtimeSchema = schema("runtime", (s) =>
      s.addTable("records", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("label", column("string"))
          .addColumn(
            "runtimeLabel",
            column("string").defaultTo$(() => `runtime-${runtimeDefaultCalls++}`),
          ),
      ),
    );
    const callsAfterSchemaDefinition = runtimeDefaultCalls;
    const compiler = new GenericSQLUOWOperationCompiler(driverConfig);
    const operation = {
      type: "create" as const,
      schema: runtimeSchema,
      table: "records" as const,
      values: { id: "record-1", label: "Record" },
      generatedExternalId: "record-1",
    };

    const result = compiler.compileCreate(operation);

    expect(result).not.toBeNull();
    assert(result?.materializedOperation?.type === "create");
    expect(result.materializedOperation.values).toMatchObject({
      id: "record-1",
      label: "Record",
      runtimeLabel: `runtime-${callsAfterSchemaDefinition}`,
    });
    expect(result.query.parameters).toContain(`runtime-${callsAfterSchemaDefinition}`);
    assert(runtimeDefaultCalls === callsAfterSchemaDefinition + 1);
  });

  test("compileUpdate operation", () => {
    const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

    const result = compiler.compileUpdate({
      type: "update",
      schema: testSchema,
      table: "users",
      id: "user123",
      checkVersion: false,
      set: {
        name: "Jane",
      },
    });

    expect(result).not.toBeNull();
    expect(result!.query.sql).toMatchInlineSnapshot(
      `"update "users" set "name" = ?, "_version" = coalesce("_version", 0) + 1 where "users"."id" = ?"`,
    );
    expect(result!.expectedAffectedRows).toBeNull();
  });

  test("compileUpdate with version check", () => {
    const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

    const result = compiler.compileUpdate({
      type: "update",
      schema: testSchema,
      table: "users",
      id: new FragnoId({ externalId: "user123", internalId: 1n, version: 5 }),
      checkVersion: true,
      set: {
        name: "Jane",
      },
    });

    expect(result).not.toBeNull();
    expect(result!.query.sql).toMatchInlineSnapshot(
      `"update "users" set "name" = ?, "_version" = coalesce("_version", 0) + 1 where ("users"."id" = ? and "users"."_version" = ?)"`,
    );
    assert(result!.expectedAffectedRows === 1n);
  });

  test("compileDelete operation", () => {
    const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

    const result = compiler.compileDelete({
      type: "delete",
      schema: testSchema,
      table: "users",
      id: "user123",
      checkVersion: false,
    });

    expect(result).not.toBeNull();
    expect(result!.query.sql).toMatchInlineSnapshot(`"delete from "users" where "users"."id" = ?"`);
    expect(result!.expectedAffectedRows).toBeNull();
  });

  test("compileCheck operation", () => {
    const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

    const result = compiler.compileCheck({
      type: "check",
      schema: testSchema,
      table: "users",
      id: new FragnoId({ externalId: "user123", internalId: 1n, version: 5 }),
    });

    expect(result).not.toBeNull();
    expect(result!.query.sql).toMatchInlineSnapshot(
      `"select 1 as "exists" from "users" where ("users"."id" = ? and "users"."_version" = ?) limit ?"`,
    );
    assert(result!.expectedReturnedRows === 1);
  });

  test("compileCheckAbsent operation for a composite unique index", () => {
    const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

    const result = compiler.compileCheckAbsent({
      type: "check-absent",
      schema: testSchema,
      table: "users",
      indexName: "idx_name_email",
      values: { name: "Alice", email: "alice@example.com" },
    });

    expect(result.query.sql).toMatchInlineSnapshot(
      `"select 1 as "exists" from "users" where ("users"."name" = ? and "users"."email" = ?) limit ?"`,
    );
    assert(result.expectedReturnedRows === 0);
  });

  test("compileCheckAbsent operation for the built-in primary index", () => {
    const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

    const result = compiler.compileCheckAbsent({
      type: "check-absent",
      schema: testSchema,
      table: "users",
      indexName: "_primary",
      values: { id: "user-123" },
    });

    expect(result.query.sql).toMatchInlineSnapshot(
      `"select 1 as "exists" from "users" where "users"."id" = ? limit ?"`,
    );
    assert(result.expectedReturnedRows === 0);
  });

  describe("compileCreate - dialect differences", () => {
    test("should compile insert query for PostgreSQL", () => {
      const compiler = new GenericSQLUOWOperationCompiler(new NodePostgresDriverConfig());

      const result = compiler.compileCreate({
        type: "create",
        schema: testSchema,
        table: "users",
        values: {
          name: "John",
          email: "john@example.com",
        },
        generatedExternalId: "user-123",
      });

      expect(result).not.toBeNull();
      expect(result!.query.sql).toMatchInlineSnapshot(
        `"insert into "users" ("id", "name", "email") values ($1, $2, $3) returning "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version""`,
      );
    });

    test("should compile insert query for SQLite", () => {
      const compiler = new GenericSQLUOWOperationCompiler(new BetterSQLite3DriverConfig());

      const result = compiler.compileCreate({
        type: "create",
        schema: testSchema,
        table: "users",
        values: {
          name: "John",
          email: "john@example.com",
        },
        generatedExternalId: "user-123",
      });

      expect(result).not.toBeNull();
      expect(result!.query.sql).toMatchInlineSnapshot(
        `"insert into "users" ("id", "name", "email") values (?, ?, ?) returning "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version""`,
      );
    });
  });

  describe("compileCreate - reference column handling", () => {
    test("should handle string reference (external ID) in create", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileCreate({
        type: "create",
        schema: testSchema,
        table: "posts",
        values: {
          title: "My Post",
          content: "Post content",
          userId: "user-external-id-123",
        },
        generatedExternalId: "post-123",
      });

      expect(result).not.toBeNull();
      expect(result!.query.sql).toMatchInlineSnapshot(
        `"insert into "posts" ("id", "title", "content", "userId") values (?, ?, ?, (select "_internalId" from "users" where "id" = ? limit ?)) returning "posts"."id" as "id", "posts"."title" as "title", "posts"."content" as "content", "posts"."userId" as "userId", "posts"."viewCount" as "viewCount", "posts"."publishedAt" as "publishedAt", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version""`,
      );
    });

    test("should handle bigint reference without subquery", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileCreate({
        type: "create",
        schema: testSchema,
        table: "posts",
        values: {
          title: "Direct ID Post",
          content: "Content",
          userId: 12345n,
        },
        generatedExternalId: "post-456",
      });

      expect(result).not.toBeNull();
      // Should not have nested SELECT for the userId value
      expect(result!.query.sql).not.toMatch(/\(select.*from.*users/i);
      expect(result!.query.sql).toMatchInlineSnapshot(
        `"insert into "posts" ("id", "title", "content", "userId") values (?, ?, ?, ?) returning "posts"."id" as "id", "posts"."title" as "title", "posts"."content" as "content", "posts"."userId" as "userId", "posts"."viewCount" as "viewCount", "posts"."publishedAt" as "publishedAt", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version""`,
      );
    });
  });

  describe("compileUpdate - reference column handling", () => {
    test("should handle string reference in update", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileUpdate({
        type: "update",
        schema: testSchema,
        table: "posts",
        id: "post-123",
        checkVersion: false,
        set: {
          userId: "new-user-id-456",
        },
      });

      expect(result).not.toBeNull();
      expect(result!.query.sql).toMatchInlineSnapshot(
        `"update "posts" set "userId" = (select "_internalId" from "users" where "id" = ? limit ?), "_version" = coalesce("_version", 0) + 1 where "posts"."id" = ?"`,
      );
    });

    test("should handle bigint reference in update without subquery", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileUpdate({
        type: "update",
        schema: testSchema,
        table: "posts",
        id: "post-123",
        checkVersion: false,
        set: {
          userId: 78910n,
        },
      });

      expect(result).not.toBeNull();
      // Should not have nested SELECT for the userId value
      expect(result!.query.sql).not.toMatch(/\(select.*from.*users/i);
      expect(result!.query.sql).toMatchInlineSnapshot(
        `"update "posts" set "userId" = ?, "_version" = coalesce("_version", 0) + 1 where "posts"."id" = ?"`,
      );
    });

    test("should compile update with multiple fields", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileUpdate({
        type: "update",
        schema: testSchema,
        table: "users",
        id: "user-123",
        checkVersion: false,
        set: {
          name: "Updated Name",
          email: "updated@example.com",
          isActive: true,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.query.sql).toMatchInlineSnapshot(
        `"update "users" set "name" = ?, "email" = ?, "isActive" = ?, "_version" = coalesce("_version", 0) + 1 where "users"."id" = ?"`,
      );
    });
  });

  describe("compileDelete with version check", () => {
    test("should compile delete with version check", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileDelete({
        type: "delete",
        schema: testSchema,
        table: "users",
        id: new FragnoId({ externalId: "user123", internalId: 1n, version: 5 }),
        checkVersion: true,
      });

      expect(result).not.toBeNull();
      expect(result!.query.sql).toMatchInlineSnapshot(
        `"delete from "users" where ("users"."id" = ? and "users"."_version" = ?)"`,
      );
      assert(result!.expectedAffectedRows === 1n);
    });
  });

  describe("compileFind - select options", () => {
    test("should compile select with specific columns", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: ["id", "name"],
          pageSize: 10,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" limit ?"`,
      );
    });

    test("should compile select with where clause", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: true,
          where: (eb) => eb("age", ">", 18),
          pageSize: 10,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where "users"."age" > ? limit ?"`,
      );
    });

    test("should compile complete query with where clause", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: ["id", "name", "email"],
          where: (eb) => eb.and(eb("isActive", "=", true), eb("age", ">=", 18)),
          pageSize: 10,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where ("users"."isActive" = ? and "users"."age" >= ?) limit ?"`,
      );
    });
  });

  describe("custom-named id columns", () => {
    test("should handle custom id column in create", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileCreate({
        type: "create",
        schema: customIdSchema,
        table: "products",
        values: {
          name: "Widget",
          price: 1000,
        },
        generatedExternalId: "prod-123",
      });

      expect(result).not.toBeNull();
      expect(result!.query.sql).toMatchInlineSnapshot(
        `"insert into "products" ("productId", "name", "price") values (?, ?, ?) returning "products"."productId" as "productId", "products"."name" as "name", "products"."price" as "price", "products"."_internalId" as "_internalId", "products"."_version" as "_version""`,
      );
    });

    test("should handle custom id column in find", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        type: "find",
        schema: customIdSchema,
        table: customIdSchema.tables.products,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: ["productId", "name"],
          pageSize: 10,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "products"."productId" as "productId", "products"."name" as "name", "products"."_internalId" as "_internalId", "products"."_version" as "_version" from "products" limit ?"`,
      );
    });

    test("should handle custom id column in where clause", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        type: "find",
        schema: customIdSchema,
        table: customIdSchema.tables.products,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: true,
          where: (eb) => eb("productId", "=", "prod-123"),
          pageSize: 10,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "products"."productId" as "productId", "products"."name" as "name", "products"."price" as "price", "products"."_internalId" as "_internalId", "products"."_version" as "_version" from "products" where "products"."productId" = ? limit ?"`,
      );
    });

    test("should handle custom id column in update", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileUpdate({
        type: "update",
        schema: customIdSchema,
        table: "products",
        id: "prod-456",
        checkVersion: false,
        set: {
          price: 2000,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.query.sql).toMatchInlineSnapshot(
        `"update "products" set "price" = ?, "_version" = coalesce("_version", 0) + 1 where "products"."productId" = ?"`,
      );
    });

    test("should handle references to custom id columns", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        type: "find",
        schema: customIdSchema,
        table: customIdSchema.tables.orders,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: ["orderId", "productRef", "quantity"],
          where: (eb) => eb("orderId", "=", "order-789"),
          pageSize: 10,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "orders"."orderId" as "orderId", "orders"."productRef" as "productRef", "orders"."quantity" as "quantity", "orders"."_internalId" as "_internalId", "orders"."_version" as "_version" from "orders" where "orders"."orderId" = ? limit ?"`,
      );
    });
  });

  describe("special columns - _internalId and _version", () => {
    test("should always include _internalId and _version", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: ["name", "email"],
          pageSize: 10,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "users"."name" as "name", "users"."email" as "email", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" limit ?"`,
      );
    });

    test("should include _internalId when id is selected", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: ["id", "name"],
          pageSize: 10,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" limit ?"`,
      );
    });
  });

  describe("id column selection", () => {
    test("should select id column explicitly", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: ["id"],
          pageSize: 10,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" limit ?"`,
      );
    });

    test("should handle id column in where clause", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: ["id", "name"],
          where: (eb) => eb("id", "=", "test-id-123"),
          pageSize: 10,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where "users"."id" = ? limit ?"`,
      );
    });
  });

  describe("orderByIndex", () => {
    test("should compile find with orderByIndex on primary index", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "_primary",
        options: {
          useIndex: "_primary",
          select: true,
          orderByIndex: { indexName: "_primary", direction: "desc" },
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" order by "users"."id" desc"`,
      );
    });

    test("should compile find with orderByIndex on named index", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "idx_users_name",
        options: {
          useIndex: "idx_users_name",
          select: true,
          orderByIndex: { indexName: "idx_users_name", direction: "asc" },
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" order by "users"."name" asc"`,
      );
    });

    test("should compile find with orderByIndex and where clause", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "idx_age",
        options: {
          useIndex: "idx_age",
          select: ["id", "name", "age"],
          where: (eb) => eb("age", ">", 18),
          orderByIndex: { indexName: "idx_age", direction: "desc" },
          pageSize: 10,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."age" as "age", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where "users"."age" > ? order by "users"."age" desc limit ?"`,
      );
    });
  });

  describe("cursor pagination", () => {
    test("should compile find with cursor pagination using after", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);
      const cursor = new Cursor({
        indexName: "idx_users_name",
        orderDirection: "asc",
        pageSize: 10,
        indexValues: { name: "Alice" },
      });

      const result = compiler.compileFind({
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "idx_users_name",
        options: {
          useIndex: "idx_users_name",
          select: true,
          orderByIndex: { indexName: "idx_users_name", direction: "asc" },
          after: cursor,
          pageSize: 10,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where "users"."name" > ? order by "users"."name" asc limit ?"`,
      );
      expect(result!.parameters).toEqual(["Alice", 10]);
    });

    test("should compile find with cursor pagination using before", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);
      const cursor = new Cursor({
        indexName: "idx_users_name",
        orderDirection: "desc",
        pageSize: 10,
        indexValues: { name: "Bob" },
      });

      const result = compiler.compileFind({
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "idx_users_name",
        options: {
          useIndex: "idx_users_name",
          select: true,
          orderByIndex: { indexName: "idx_users_name", direction: "desc" },
          before: cursor,
          pageSize: 10,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where "users"."name" > ? order by "users"."name" desc limit ?"`,
      );
      expect(result!.parameters).toEqual(["Bob", 10]);
    });

    test("should compile find with cursor pagination and additional where conditions", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);
      const cursor = new Cursor({
        indexName: "idx_users_name",
        orderDirection: "asc",
        pageSize: 5,
        indexValues: { name: "Alice" },
      });

      const result = compiler.compileFind({
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "idx_users_name",
        options: {
          useIndex: "idx_users_name",
          select: true,
          where: (eb) => eb("isActive", "=", true),
          orderByIndex: { indexName: "idx_users_name", direction: "asc" },
          after: cursor,
          pageSize: 5,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where ("users"."isActive" = ? and "users"."name" > ?) order by "users"."name" asc limit ?"`,
      );
      expect(result!.parameters).toEqual([1, "Alice", 5]);
    });

    test("should compile find with composite cursor pagination", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);
      const createdAt = new Date("2024-01-01T00:00:00.000Z");
      const cursor = new Cursor({
        indexName: "idx_users_name_created_id",
        orderDirection: "desc",
        pageSize: 7,
        indexValues: { name: "Alice", createdAt, id: "user-123" },
      });

      const result = compiler.compileFind({
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "idx_users_name_created_id",
        options: {
          useIndex: "idx_users_name_created_id",
          select: true,
          orderByIndex: { indexName: "idx_users_name_created_id", direction: "desc" },
          after: cursor,
          pageSize: 7,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where ("users"."name" < ? or ("users"."name" = ? and "users"."createdAt" < ?) or ("users"."name" = ? and "users"."createdAt" = ? and "users"."id" < ?)) order by "users"."name" desc, "users"."createdAt" desc, "users"."id" desc limit ?"`,
      );
      expect(result!.parameters).toEqual([
        "Alice",
        "Alice",
        createdAt.getTime(),
        "Alice",
        createdAt.getTime(),
        "user-123",
        7,
      ]);
    });
  });

  describe("complex where conditions", () => {
    test("should compile find with AND conditions", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: true,
          where: (eb) => eb.and(eb("age", ">", 18), eb("isActive", "=", true)),
          pageSize: 10,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where ("users"."age" > ? and "users"."isActive" = ?) limit ?"`,
      );
    });

    test("should compile find with OR conditions", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: true,
          where: (eb) => eb.or(eb("name", "=", "Alice"), eb("name", "=", "Bob")),
          pageSize: 10,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where ("users"."name" = ? or "users"."name" = ?) limit ?"`,
      );
      expect(result!.parameters).toEqual(["Alice", "Bob", 10]);
    });

    test("should compile find with nested AND/OR conditions", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: true,
          where: (eb) =>
            eb.and(
              eb("isActive", "=", true),
              eb.or(eb("name", "=", "Alice"), eb("name", "=", "Bob")),
            ),
          pageSize: 10,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where ("users"."isActive" = ? and ("users"."name" = ? or "users"."name" = ?)) limit ?"`,
      );
      expect(result!.parameters).toEqual([1, "Alice", "Bob", 10]);
    });
  });

  describe("always-false/always-true conditions", () => {
    test("should return null for always-false conditions in find", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: true,
          where: () => false,
          pageSize: 10,
        },
      });

      expect(result).toBeNull();
    });

    test("should compile query without where for always-true conditions", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: true,
          where: () => true,
          pageSize: 10,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" limit ?"`,
      );
    });

    test("should return null for always-false conditions in count", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileCount({
        type: "count",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "primary",
        options: {
          useIndex: "primary",
          where: () => false,
        },
      });

      expect(result).toBeNull();
    });
  });

  describe("contains and starts with operators", () => {
    test("should compile find with contains operator", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: true,
          where: (eb) => eb("email", "contains", "@example.com"),
          pageSize: 10,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where "users"."email" like ? limit ?"`,
      );
      expect(result!.parameters).toEqual(["%@example.com%", 10]);
    });

    test("should compile find with starts with operator", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: true,
          where: (eb) => eb("name", "starts with", "John"),
          pageSize: 10,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where "users"."name" like ? limit ?"`,
      );
      expect(result!.parameters).toEqual(["John%", 10]);
    });
  });

  describe("MySQL dialect SQL snapshots", () => {
    const mysqlDriverConfig = new MySQL2DriverConfig();

    test("should compile insert without returning clause", () => {
      const compiler = new GenericSQLUOWOperationCompiler(mysqlDriverConfig);

      const result = compiler.compileCreate({
        type: "create",
        schema: testSchema,
        table: "users",
        values: {
          name: "John",
          email: "john@example.com",
        },
        generatedExternalId: "user-123",
      });

      expect(result).not.toBeNull();
      expect(result!.query.sql).toMatchInlineSnapshot(
        `"insert into \`users\` (\`id\`, \`name\`, \`email\`) values (?, ?, ?)"`,
      );
    });

    test("should compile reference subquery in insert", () => {
      const compiler = new GenericSQLUOWOperationCompiler(mysqlDriverConfig);

      const result = compiler.compileCreate({
        type: "create",
        schema: testSchema,
        table: "posts",
        values: {
          title: "My Post",
          content: "Post content",
          userId: "user-external-id-123",
        },
        generatedExternalId: "post-123",
      });

      expect(result).not.toBeNull();
      expect(result!.query.sql).toMatchInlineSnapshot(
        `"insert into \`posts\` (\`id\`, \`title\`, \`content\`, \`userId\`) values (?, ?, ?, (select \`_internalId\` from \`users\` where \`id\` = ? limit ?))"`,
      );
    });

    test("should compile update with version check", () => {
      const compiler = new GenericSQLUOWOperationCompiler(mysqlDriverConfig);

      const result = compiler.compileUpdate({
        type: "update",
        schema: testSchema,
        table: "users",
        id: new FragnoId({ externalId: "user123", internalId: 1n, version: 5 }),
        checkVersion: true,
        set: { name: "Updated" },
      });

      expect(result).not.toBeNull();
      expect(result!.query.sql).toMatchInlineSnapshot(
        `"update \`users\` set \`name\` = ?, \`_version\` = coalesce(\`_version\`, 0) + 1 where (\`users\`.\`id\` = ? and \`users\`.\`_version\` = ?)"`,
      );
      assert(result!.expectedAffectedRows === 1n);
    });

    test("should compile cursor pagination", () => {
      const compiler = new GenericSQLUOWOperationCompiler(mysqlDriverConfig);
      const cursor = new Cursor({
        indexName: "idx_users_name",
        orderDirection: "asc",
        pageSize: 10,
        indexValues: { name: "John" },
      });

      const result = compiler.compileFind({
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "idx_users_name",
        options: {
          useIndex: "idx_users_name",
          select: ["id", "name"],
          orderByIndex: { indexName: "idx_users_name", direction: "asc" },
          after: cursor,
          pageSize: 10,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select \`users\`.\`id\` as \`id\`, \`users\`.\`name\` as \`name\`, \`users\`.\`_internalId\` as \`_internalId\`, \`users\`.\`_version\` as \`_version\` from \`users\` where \`users\`.\`name\` > ? order by \`users\`.\`name\` asc limit ?"`,
      );
    });

    test("should compile check operation", () => {
      const compiler = new GenericSQLUOWOperationCompiler(mysqlDriverConfig);

      const result = compiler.compileCheck({
        type: "check",
        schema: testSchema,
        table: "users",
        id: new FragnoId({ externalId: "user123", internalId: 1n, version: 5 }),
      });

      expect(result).not.toBeNull();
      expect(result!.query.sql).toMatchInlineSnapshot(
        `"select 1 as \`exists\` from \`users\` where (\`users\`.\`id\` = ? and \`users\`.\`_version\` = ?) limit ?"`,
      );
      assert(result!.expectedReturnedRows === 1);
    });
  });
});
