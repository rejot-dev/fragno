import { describe, test, expect } from "vitest";
import { GenericSQLUOWOperationCompiler } from "./generic-sql-uow-operation-compiler";
import { BetterSQLite3DriverConfig, NodePostgresDriverConfig } from "../driver-config";
import { schema, column, idColumn, referenceColumn, FragnoId } from "../../../schema/create";

// Test schema
const testSchema = schema((s) => {
  return s
    .addTable("users", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("email", column("string"))
        .addColumn("age", column("integer").nullable())
        .addColumn("isActive", column("bool"))
        .addColumn("createdAt", column("timestamp"));
    })
    .addTable("posts", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("title", column("string"))
        .addColumn("content", column("string"))
        .addColumn("userId", referenceColumn())
        .addColumn("viewCount", column("integer").defaultTo(0))
        .addColumn("publishedAt", column("timestamp").nullable());
    })
    .addReference("author", {
      type: "one",
      from: { table: "posts", column: "userId" },
      to: { table: "users", column: "id" },
    });
});

// Schema with custom-named id columns
const customIdSchema = schema((s) => {
  return s
    .addTable("products", (t) => {
      return t
        .addColumn("productId", idColumn())
        .addColumn("name", column("string"))
        .addColumn("price", column("integer"));
    })
    .addTable("orders", (t) => {
      return t
        .addColumn("orderId", idColumn())
        .addColumn("productRef", referenceColumn())
        .addColumn("quantity", column("integer"));
    })
    .addReference("product", {
      type: "one",
      from: { table: "orders", column: "productRef" },
      to: { table: "products", column: "productId" },
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
      `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" limit ?"`,
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
      `"insert into "users" ("id", "name", "email", "age") values (?, ?, ?, ?) returning "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."_internalId" as "_internalId", "users"."_version" as "_version""`,
    );
    expect(result!.expectedAffectedRows).toBeNull();
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
      `"update "users" set "name" = ?, "_version" = COALESCE(_version, 0) + 1 where "users"."id" = ?"`,
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
      `"update "users" set "name" = ?, "_version" = COALESCE(_version, 0) + 1 where ("users"."id" = ? and "users"."_version" = ?)"`,
    );
    expect(result!.expectedAffectedRows).toBe(1);
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
    expect(result!.expectedReturnedRows).toBe(1);
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
        `"insert into "users" ("id", "name", "email") values ($1, $2, $3) returning "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."_internalId" as "_internalId", "users"."_version" as "_version""`,
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
        `"insert into "users" ("id", "name", "email") values (?, ?, ?) returning "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."_internalId" as "_internalId", "users"."_version" as "_version""`,
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
      // Should contain a subquery to look up the internal ID
      expect(result!.query.sql).toContain("select");
      expect(result!.query.sql).toContain("_internalId");
      expect(result!.query.sql).toContain("users");
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
      // Should contain a subquery to look up the internal ID
      expect(result!.query.sql).toContain("select");
      expect(result!.query.sql).toContain("_internalId");
      expect(result!.query.sql).toContain("users");
      expect(result!.query.sql).toMatchInlineSnapshot(
        `"update "posts" set "userId" = (select "_internalId" from "users" where "id" = ? limit ?), "_version" = COALESCE(_version, 0) + 1 where "posts"."id" = ?"`,
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
        `"update "posts" set "userId" = ?, "_version" = COALESCE(_version, 0) + 1 where "posts"."id" = ?"`,
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
        `"update "users" set "name" = ?, "email" = ?, "isActive" = ?, "_version" = COALESCE(_version, 0) + 1 where "users"."id" = ?"`,
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
      expect(result!.expectedAffectedRows).toBe(1);
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
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" where "users"."age" > ? limit ?"`,
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
      expect(result!.query.sql).toContain("productId");
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
      expect(result!.sql).toContain("productId");
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
      expect(result!.query.sql).toContain("productId");
      expect(result!.query.sql).toMatchInlineSnapshot(
        `"update "products" set "price" = ?, "_version" = COALESCE(_version, 0) + 1 where "products"."productId" = ?"`,
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
      // Hidden columns (_internalId, _version) are always included for internal use
      expect(result!.sql).toContain("_internalId");
      expect(result!.sql).toContain("_version");
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
      expect(result!.sql).toContain("_internalId");
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
});
