import { describe, test, expect } from "vitest";
import { GenericSQLUOWOperationCompiler } from "./generic-sql-uow-operation-compiler";
import { BetterSQLite3DriverConfig, NodePostgresDriverConfig } from "../driver-config";
import { schema, column, idColumn, referenceColumn, FragnoId } from "../../../schema/create";
import { Cursor } from "../../../query/cursor";
import { GLOBAL_SHARD_SENTINEL } from "../../../sharding";

// Test schema with indexes
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
        .addColumn("invitedBy", referenceColumn().nullable())
        .createIndex("idx_email", ["email"], { unique: true })
        .createIndex("idx_users_name", ["name"])
        .createIndex("idx_age", ["age"]);
    })
    .addTable("posts", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("title", column("string"))
        .addColumn("content", column("string"))
        .addColumn("userId", referenceColumn())
        .addColumn("viewCount", column("integer").defaultTo(0))
        .addColumn("publishedAt", column("timestamp").nullable())
        .createIndex("idx_title", ["title"])
        .createIndex("idx_user", ["userId"]);
    })
    .addTable("comments", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("content", column("string"))
        .addColumn("postId", referenceColumn())
        .addColumn("authorId", referenceColumn())
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
        .addColumn("postId", referenceColumn())
        .addColumn("tagId", referenceColumn())
        .createIndex("idx_post_tags_post", ["postId"])
        .createIndex("idx_tag", ["tagId"]);
    })
    .addReference("author", {
      type: "one",
      from: { table: "posts", column: "userId" },
      to: { table: "users", column: "id" },
    })
    .addReference("inviter", {
      type: "one",
      from: { table: "users", column: "invitedBy" },
      to: { table: "users", column: "id" },
    })
    .addReference("post", {
      type: "one",
      from: { table: "comments", column: "postId" },
      to: { table: "posts", column: "id" },
    })
    .addReference("author", {
      type: "one",
      from: { table: "comments", column: "authorId" },
      to: { table: "users", column: "id" },
    })
    .addReference("post", {
      type: "one",
      from: { table: "post_tags", column: "postId" },
      to: { table: "posts", column: "id" },
    })
    .addReference("tag", {
      type: "one",
      from: { table: "post_tags", column: "tagId" },
      to: { table: "tags", column: "id" },
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
        .addColumn("productRef", referenceColumn())
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
        .addColumn("prodRef", referenceColumn())
        .addColumn("catRef", referenceColumn())
        .createIndex("idx_prod", ["prodRef"])
        .createIndex("idx_cat", ["catRef"]);
    })
    .addReference("product", {
      type: "one",
      from: { table: "orders", column: "productRef" },
      to: { table: "products", column: "productId" },
    })
    .addReference("product", {
      type: "one",
      from: { table: "product_categories", column: "prodRef" },
      to: { table: "products", column: "productId" },
    })
    .addReference("category", {
      type: "one",
      from: { table: "product_categories", column: "catRef" },
      to: { table: "categories", column: "categoryId" },
    });
});

describe("GenericSQLUOWOperationCompiler", () => {
  const driverConfig = new BetterSQLite3DriverConfig();
  const shardDefaults = {
    shard: null,
    shardScope: "scoped",
    shardingStrategy: undefined,
    shardFilterExempt: false,
  } as const;

  test("compileCount operation", () => {
    const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

    const result = compiler.compileCount({
      ...shardDefaults,
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
      ...shardDefaults,
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
      ...shardDefaults,
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
      `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard" from "users" limit ?"`,
    );
  });

  test("compileCreate operation", () => {
    const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

    const result = compiler.compileCreate({
      ...shardDefaults,
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
      `"insert into "users" ("id", "name", "email", "age") values (?, ?, ?, ?) returning "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard""`,
    );
    expect(result!.expectedAffectedRows).toBeNull();
  });

  test("compileUpdate operation", () => {
    const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

    const result = compiler.compileUpdate({
      ...shardDefaults,
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
      ...shardDefaults,
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
    expect(result!.expectedAffectedRows).toBe(1n);
  });

  test("compileDelete operation", () => {
    const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

    const result = compiler.compileDelete({
      ...shardDefaults,
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
      ...shardDefaults,
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

  describe("shard filters", () => {
    const shardRowDefaults = {
      ...shardDefaults,
      shard: "tenant-a",
      shardingStrategy: { mode: "row" } as const,
    };

    test("compileCount applies shard filter", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileCount({
        ...shardRowDefaults,
        type: "count",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "primary",
        options: {
          useIndex: "primary",
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select count(*) as "count" from "users" where "users"."_shard" = ?"`,
      );
    });

    test("compileFind applies shard filter with null shard", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardRowDefaults,
        shard: null,
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: true,
          pageSize: 1,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard" from "users" where "users"."_shard" = ? limit ?"`,
      );
      expect(result!.parameters[0]).toBe(GLOBAL_SHARD_SENTINEL);
    });

    test("compileUpdate applies shard filter", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileUpdate({
        ...shardRowDefaults,
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
        `"update "users" set "name" = ?, "_version" = coalesce("_version", 0) + 1 where ("users"."id" = ? and "users"."_shard" = ?)"`,
      );
    });

    test("compileCheck applies shard filter", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileCheck({
        ...shardRowDefaults,
        type: "check",
        schema: testSchema,
        table: "users",
        id: new FragnoId({ externalId: "user123", internalId: 1n, version: 5 }),
      });

      expect(result).not.toBeNull();
      expect(result!.query.sql).toMatchInlineSnapshot(
        `"select 1 as "exists" from "users" where (("users"."id" = ? and "users"."_version" = ?) and "users"."_shard" = ?) limit ?"`,
      );
    });

    test("compileFind skips shard filter for global scope", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardRowDefaults,
        shardScope: "global",
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: true,
          pageSize: 1,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard" from "users" limit ?"`,
      );
    });

    test("compileCount skips shard filter when shardFilterExempt", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileCount({
        ...shardRowDefaults,
        shardFilterExempt: true,
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
  });

  describe("compileCreate - dialect differences", () => {
    test("should compile insert query for PostgreSQL", () => {
      const compiler = new GenericSQLUOWOperationCompiler(new NodePostgresDriverConfig());

      const result = compiler.compileCreate({
        ...shardDefaults,
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
        `"insert into "users" ("id", "name", "email") values ($1, $2, $3) returning "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard""`,
      );
    });

    test("should compile insert query for SQLite", () => {
      const compiler = new GenericSQLUOWOperationCompiler(new BetterSQLite3DriverConfig());

      const result = compiler.compileCreate({
        ...shardDefaults,
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
        `"insert into "users" ("id", "name", "email") values (?, ?, ?) returning "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard""`,
      );
    });
  });

  describe("compileCreate - reference column handling", () => {
    test("should handle string reference (external ID) in create", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileCreate({
        ...shardDefaults,
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
        `"insert into "posts" ("id", "title", "content", "userId") values (?, ?, ?, (select "_internalId" from "users" where "id" = ? limit ?)) returning "posts"."id" as "id", "posts"."title" as "title", "posts"."content" as "content", "posts"."userId" as "userId", "posts"."viewCount" as "viewCount", "posts"."publishedAt" as "publishedAt", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version", "posts"."_shard" as "_shard""`,
      );
    });

    test("should handle bigint reference without subquery", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileCreate({
        ...shardDefaults,
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
        `"insert into "posts" ("id", "title", "content", "userId") values (?, ?, ?, ?) returning "posts"."id" as "id", "posts"."title" as "title", "posts"."content" as "content", "posts"."userId" as "userId", "posts"."viewCount" as "viewCount", "posts"."publishedAt" as "publishedAt", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version", "posts"."_shard" as "_shard""`,
      );
    });
  });

  describe("compileUpdate - reference column handling", () => {
    test("should handle string reference in update", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileUpdate({
        ...shardDefaults,
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
        ...shardDefaults,
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
        ...shardDefaults,
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
        ...shardDefaults,
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
      expect(result!.expectedAffectedRows).toBe(1n);
    });
  });

  describe("compileFind - select options", () => {
    test("should compile select with specific columns", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
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
        `"select "users"."id" as "id", "users"."name" as "name", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard" from "users" limit ?"`,
      );
    });

    test("should compile select with where clause", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
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
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard" from "users" where "users"."age" > ? limit ?"`,
      );
    });

    test("should compile complete query with where clause", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
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
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard" from "users" where ("users"."isActive" = ? and "users"."age" >= ?) limit ?"`,
      );
    });
  });

  describe("custom-named id columns", () => {
    test("should handle custom id column in create", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileCreate({
        ...shardDefaults,
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
        `"insert into "products" ("productId", "name", "price") values (?, ?, ?) returning "products"."productId" as "productId", "products"."name" as "name", "products"."price" as "price", "products"."_internalId" as "_internalId", "products"."_version" as "_version", "products"."_shard" as "_shard""`,
      );
    });

    test("should handle custom id column in find", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
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
        `"select "products"."productId" as "productId", "products"."name" as "name", "products"."_internalId" as "_internalId", "products"."_version" as "_version", "products"."_shard" as "_shard" from "products" limit ?"`,
      );
    });

    test("should handle custom id column in where clause", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
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
        `"select "products"."productId" as "productId", "products"."name" as "name", "products"."price" as "price", "products"."_internalId" as "_internalId", "products"."_version" as "_version", "products"."_shard" as "_shard" from "products" where "products"."productId" = ? limit ?"`,
      );
    });

    test("should handle custom id column in update", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileUpdate({
        ...shardDefaults,
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
        ...shardDefaults,
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
        `"select "orders"."orderId" as "orderId", "orders"."productRef" as "productRef", "orders"."quantity" as "quantity", "orders"."_internalId" as "_internalId", "orders"."_version" as "_version", "orders"."_shard" as "_shard" from "orders" where "orders"."orderId" = ? limit ?"`,
      );
    });
  });

  describe("special columns - _internalId and _version", () => {
    test("should always include _internalId and _version", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
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
        `"select "users"."name" as "name", "users"."email" as "email", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard" from "users" limit ?"`,
      );
    });

    test("should include _internalId when id is selected", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
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
        `"select "users"."id" as "id", "users"."name" as "name", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard" from "users" limit ?"`,
      );
    });
  });

  describe("id column selection", () => {
    test("should select id column explicitly", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
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
        `"select "users"."id" as "id", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard" from "users" limit ?"`,
      );
    });

    test("should handle id column in where clause", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
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
        `"select "users"."id" as "id", "users"."name" as "name", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard" from "users" where "users"."id" = ? limit ?"`,
      );
    });
  });

  describe("orderByIndex", () => {
    test("should compile find with orderByIndex on primary index", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
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
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard" from "users" order by "users"."id" desc"`,
      );
    });

    test("should compile find with orderByIndex on named index", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
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
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard" from "users" order by "users"."name" asc"`,
      );
    });

    test("should compile find with orderByIndex and where clause", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
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
        `"select "users"."id" as "id", "users"."name" as "name", "users"."age" as "age", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard" from "users" where "users"."age" > ? order by "users"."age" desc limit ?"`,
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
        ...shardDefaults,
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
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard" from "users" where "users"."name" > ? order by "users"."name" asc limit ?"`,
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
        ...shardDefaults,
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
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard" from "users" where "users"."name" > ? order by "users"."name" desc limit ?"`,
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
        ...shardDefaults,
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
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard" from "users" where ("users"."isActive" = ? and "users"."name" > ?) order by "users"."name" asc limit ?"`,
      );
      expect(result!.parameters).toEqual([1, "Alice", 5]);
    });
  });

  describe("complex where conditions", () => {
    test("should compile find with AND conditions", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
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
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard" from "users" where ("users"."age" > ? and "users"."isActive" = ?) limit ?"`,
      );
    });

    test("should compile find with OR conditions", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
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
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard" from "users" where ("users"."name" = ? or "users"."name" = ?) limit ?"`,
      );
      expect(result!.parameters).toEqual(["Alice", "Bob", 10]);
    });

    test("should compile find with nested AND/OR conditions", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
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
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard" from "users" where ("users"."isActive" = ? and ("users"."name" = ? or "users"."name" = ?)) limit ?"`,
      );
      expect(result!.parameters).toEqual([1, "Alice", "Bob", 10]);
    });
  });

  describe("always-false/always-true conditions", () => {
    test("should return null for always-false conditions in find", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
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
        ...shardDefaults,
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
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard" from "users" limit ?"`,
      );
    });

    test("should return null for always-false conditions in count", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileCount({
        ...shardDefaults,
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
        ...shardDefaults,
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
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard" from "users" where "users"."email" like ? limit ?"`,
      );
      expect(result!.parameters).toEqual(["%@example.com%", 10]);
    });

    test("should compile find with starts with operator", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
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
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."isActive" as "isActive", "users"."createdAt" as "createdAt", "users"."invitedBy" as "invitedBy", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard" from "users" where "users"."name" like ? limit ?"`,
      );
      expect(result!.parameters).toEqual(["John%", 10]);
    });
  });

  describe("join operations", () => {
    test("should compile find with basic join", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
        type: "find",
        schema: testSchema,
        table: testSchema.tables.posts,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: ["id", "title"],
          joins: [
            {
              relation: testSchema.tables.posts.relations.author,
              options: {
                select: ["name", "email"],
              },
            },
          ],
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "author"."name" as "author:name", "author"."email" as "author:email", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "author"."_shard" as "author:_shard", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version", "posts"."_shard" as "_shard" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId""`,
      );
    });

    test("should enforce shard filters on joins in row mode", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
        shard: "tenant-a",
        shardingStrategy: { mode: "row" },
        type: "find",
        schema: testSchema,
        table: testSchema.tables.posts,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: ["id", "title"],
          joins: [
            {
              relation: testSchema.tables.posts.relations.author,
              options: {
                select: ["name", "email"],
              },
            },
          ],
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "author"."name" as "author:name", "author"."email" as "author:email", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "author"."_shard" as "author:_shard", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version", "posts"."_shard" as "_shard" from "posts" left join "users" as "author" on ("posts"."userId" = "author"."_internalId" and "users"."_shard" = ?) where "posts"."_shard" = ?"`,
      );
      expect(result!.parameters).toEqual(["tenant-a", "tenant-a"]);
    });

    test("should compile join with specific column selection", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
        type: "find",
        schema: testSchema,
        table: testSchema.tables.posts,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: ["id", "userId"],
          joins: [
            {
              relation: testSchema.tables.posts.relations.author,
              options: {
                select: true,
              },
            },
          ],
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "author"."id" as "author:id", "author"."name" as "author:name", "author"."email" as "author:email", "author"."age" as "author:age", "author"."isActive" as "author:isActive", "author"."createdAt" as "author:createdAt", "author"."invitedBy" as "author:invitedBy", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "author"."_shard" as "author:_shard", "posts"."id" as "id", "posts"."userId" as "userId", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version", "posts"."_shard" as "_shard" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId""`,
      );
    });

    test("should compile find with multiple joins", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
        type: "find",
        schema: testSchema,
        table: testSchema.tables.comments,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: ["id", "content"],
          joins: [
            {
              relation: testSchema.tables.comments.relations.post,
              options: {
                select: ["title"],
              },
            },
            {
              relation: testSchema.tables.comments.relations.author,
              options: {
                select: ["name"],
              },
            },
          ],
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "post"."title" as "post:title", "post"."_internalId" as "post:_internalId", "post"."_version" as "post:_version", "post"."_shard" as "post:_shard", "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "author"."_shard" as "author:_shard", "comments"."id" as "id", "comments"."content" as "content", "comments"."_internalId" as "_internalId", "comments"."_version" as "_version", "comments"."_shard" as "_shard" from "comments" left join "posts" as "post" on "comments"."postId" = "post"."_internalId" left join "users" as "author" on "comments"."authorId" = "author"."_internalId""`,
      );
    });

    test("should compile self-referencing join", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
        type: "find",
        schema: testSchema,
        table: testSchema.tables.users,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: ["id", "name"],
          joins: [
            {
              relation: testSchema.tables.users.relations.inviter,
              options: {
                select: ["name", "email"],
              },
            },
          ],
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "inviter"."name" as "inviter:name", "inviter"."email" as "inviter:email", "inviter"."_internalId" as "inviter:_internalId", "inviter"."_version" as "inviter:_version", "inviter"."_shard" as "inviter:_shard", "users"."id" as "id", "users"."name" as "name", "users"."_internalId" as "_internalId", "users"."_version" as "_version", "users"."_shard" as "_shard" from "users" left join "users" as "inviter" on "users"."invitedBy" = "inviter"."_internalId""`,
      );
    });

    test("should compile join with where clause on joined table", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);
      const usersTable = testSchema.tables.users;

      const result = compiler.compileFind({
        ...shardDefaults,
        type: "find",
        schema: testSchema,
        table: testSchema.tables.posts,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: ["id", "title"],
          joins: [
            {
              relation: testSchema.tables.posts.relations.author,
              options: {
                select: ["name"],
                where: {
                  type: "compare",
                  a: usersTable.columns.name,
                  operator: "contains",
                  b: "john",
                },
              },
            },
          ],
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "author"."_shard" as "author:_shard", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version", "posts"."_shard" as "_shard" from "posts" left join "users" as "author" on ("posts"."userId" = "author"."_internalId" and "users"."name" like ?)"`,
      );
      expect(result!.parameters).toEqual(["%john%"]);
    });

    test("should compile join with complex AND where conditions", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);
      const usersTable = testSchema.tables.users;

      const result = compiler.compileFind({
        ...shardDefaults,
        type: "find",
        schema: testSchema,
        table: testSchema.tables.posts,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: ["id", "title"],
          joins: [
            {
              relation: testSchema.tables.posts.relations.author,
              options: {
                select: ["name"],
                where: {
                  type: "and",
                  items: [
                    {
                      type: "compare",
                      a: usersTable.columns.name,
                      operator: "contains",
                      b: "john",
                    },
                    {
                      type: "compare",
                      a: usersTable.columns.isActive,
                      operator: "=",
                      b: true,
                    },
                  ],
                },
              },
            },
          ],
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "author"."_shard" as "author:_shard", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version", "posts"."_shard" as "_shard" from "posts" left join "users" as "author" on ("posts"."userId" = "author"."_internalId" and ("users"."name" like ? and "users"."isActive" = ?))"`,
      );
    });

    test("should compile join with id column selection", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
        type: "find",
        schema: testSchema,
        table: testSchema.tables.posts,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: ["id", "title"],
          joins: [
            {
              relation: testSchema.tables.posts.relations.author,
              options: {
                select: ["id", "name"],
              },
            },
          ],
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "author"."id" as "author:id", "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "author"."_shard" as "author:_shard", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version", "posts"."_shard" as "_shard" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId""`,
      );
    });

    test("should compile join with select true (all columns)", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
        type: "find",
        schema: testSchema,
        table: testSchema.tables.posts,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: ["id"],
          joins: [
            {
              relation: testSchema.tables.posts.relations.author,
              options: {
                select: true,
              },
            },
          ],
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "author"."id" as "author:id", "author"."name" as "author:name", "author"."email" as "author:email", "author"."age" as "author:age", "author"."isActive" as "author:isActive", "author"."createdAt" as "author:createdAt", "author"."invitedBy" as "author:invitedBy", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "author"."_shard" as "author:_shard", "posts"."id" as "id", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version", "posts"."_shard" as "_shard" from "posts" left join "users" as "author" on "posts"."userId" = "author"."_internalId""`,
      );
    });

    test("should compile join with id in where clause on joined table", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);
      const usersTable = testSchema.tables.users;

      const result = compiler.compileFind({
        ...shardDefaults,
        type: "find",
        schema: testSchema,
        table: testSchema.tables.posts,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: ["id", "title"],
          joins: [
            {
              relation: testSchema.tables.posts.relations.author,
              options: {
                select: ["id", "name"],
                where: {
                  type: "compare",
                  a: usersTable.columns.id,
                  operator: "=",
                  b: "user-123",
                },
              },
            },
          ],
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "author"."id" as "author:id", "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "author"."_shard" as "author:_shard", "posts"."id" as "id", "posts"."title" as "title", "posts"."_internalId" as "_internalId", "posts"."_version" as "_version", "posts"."_shard" as "_shard" from "posts" left join "users" as "author" on ("posts"."userId" = "author"."_internalId" and "users"."id" = ?)"`,
      );
      expect(result!.parameters).toEqual(["user-123"]);
    });

    test("should compile multiple joins with different id selections", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
        type: "find",
        schema: testSchema,
        table: testSchema.tables.comments,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: ["id", "content"],
          joins: [
            {
              relation: testSchema.tables.comments.relations.post,
              options: {
                select: ["id", "title"],
              },
            },
            {
              relation: testSchema.tables.comments.relations.author,
              options: {
                select: ["name"],
              },
            },
          ],
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "post"."id" as "post:id", "post"."title" as "post:title", "post"."_internalId" as "post:_internalId", "post"."_version" as "post:_version", "post"."_shard" as "post:_shard", "author"."name" as "author:name", "author"."_internalId" as "author:_internalId", "author"."_version" as "author:_version", "author"."_shard" as "author:_shard", "comments"."id" as "id", "comments"."content" as "content", "comments"."_internalId" as "_internalId", "comments"."_version" as "_version", "comments"."_shard" as "_shard" from "comments" left join "posts" as "post" on "comments"."postId" = "post"."_internalId" left join "users" as "author" on "comments"."authorId" = "author"."_internalId""`,
      );
    });

    test("should compile many-to-many join through junction table", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
        type: "find",
        schema: testSchema,
        table: testSchema.tables.post_tags,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: ["id"],
          joins: [
            {
              relation: testSchema.tables.post_tags.relations.post,
              options: {
                select: ["title"],
              },
            },
            {
              relation: testSchema.tables.post_tags.relations.tag,
              options: {
                select: ["name"],
              },
            },
          ],
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "post"."title" as "post:title", "post"."_internalId" as "post:_internalId", "post"."_version" as "post:_version", "post"."_shard" as "post:_shard", "tag"."name" as "tag:name", "tag"."_internalId" as "tag:_internalId", "tag"."_version" as "tag:_version", "tag"."_shard" as "tag:_shard", "post_tags"."id" as "id", "post_tags"."_internalId" as "_internalId", "post_tags"."_version" as "_version", "post_tags"."_shard" as "_shard" from "post_tags" left join "posts" as "post" on "post_tags"."postId" = "post"."_internalId" left join "tags" as "tag" on "post_tags"."tagId" = "tag"."_internalId""`,
      );
    });
  });

  describe("custom-named id columns in joins", () => {
    test("should compile join with custom id column names", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
        type: "find",
        schema: customIdSchema,
        table: customIdSchema.tables.product_categories,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: ["id"],
          joins: [
            {
              relation: customIdSchema.tables.product_categories.relations.product,
              options: {
                select: ["productId", "name"],
              },
            },
            {
              relation: customIdSchema.tables.product_categories.relations.category,
              options: {
                select: ["categoryId", "categoryName"],
              },
            },
          ],
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "product"."productId" as "product:productId", "product"."name" as "product:name", "product"."_internalId" as "product:_internalId", "product"."_version" as "product:_version", "product"."_shard" as "product:_shard", "category"."categoryId" as "category:categoryId", "category"."categoryName" as "category:categoryName", "category"."_internalId" as "category:_internalId", "category"."_version" as "category:_version", "category"."_shard" as "category:_shard", "product_categories"."id" as "id", "product_categories"."_internalId" as "_internalId", "product_categories"."_version" as "_version", "product_categories"."_shard" as "_shard" from "product_categories" left join "products" as "product" on "product_categories"."prodRef" = "product"."_internalId" left join "categories" as "category" on "product_categories"."catRef" = "category"."_internalId""`,
      );
    });

    test("should handle custom id in join where clause", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);
      const productsTable = customIdSchema.tables.products;

      const result = compiler.compileFind({
        ...shardDefaults,
        type: "find",
        schema: customIdSchema,
        table: customIdSchema.tables.product_categories,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: ["id"],
          joins: [
            {
              relation: customIdSchema.tables.product_categories.relations.product,
              options: {
                select: ["productId", "name"],
                where: {
                  type: "compare",
                  a: productsTable.columns.productId,
                  operator: "=",
                  b: "prod-456",
                },
              },
            },
          ],
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "product"."productId" as "product:productId", "product"."name" as "product:name", "product"."_internalId" as "product:_internalId", "product"."_version" as "product:_version", "product"."_shard" as "product:_shard", "product_categories"."id" as "id", "product_categories"."_internalId" as "_internalId", "product_categories"."_version" as "_version", "product_categories"."_shard" as "_shard" from "product_categories" left join "products" as "product" on ("product_categories"."prodRef" = "product"."_internalId" and "products"."productId" = ?)"`,
      );
      expect(result!.parameters).toEqual(["prod-456"]);
    });

    test("should handle select true with custom id columns in join", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
        type: "find",
        schema: customIdSchema,
        table: customIdSchema.tables.product_categories,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: ["id"],
          joins: [
            {
              relation: customIdSchema.tables.product_categories.relations.product,
              options: {
                select: true,
              },
            },
          ],
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "product"."productId" as "product:productId", "product"."name" as "product:name", "product"."price" as "product:price", "product"."_internalId" as "product:_internalId", "product"."_version" as "product:_version", "product"."_shard" as "product:_shard", "product_categories"."id" as "id", "product_categories"."_internalId" as "_internalId", "product_categories"."_version" as "_version", "product_categories"."_shard" as "_shard" from "product_categories" left join "products" as "product" on "product_categories"."prodRef" = "product"."_internalId""`,
      );
    });

    test("should join tables with different custom id names", () => {
      const compiler = new GenericSQLUOWOperationCompiler(driverConfig);

      const result = compiler.compileFind({
        ...shardDefaults,
        type: "find",
        schema: customIdSchema,
        table: customIdSchema.tables.product_categories,
        indexName: "primary",
        options: {
          useIndex: "primary",
          select: ["id"],
          joins: [
            {
              relation: customIdSchema.tables.product_categories.relations.product,
              options: {
                select: ["productId"],
              },
            },
            {
              relation: customIdSchema.tables.product_categories.relations.category,
              options: {
                select: ["categoryId"],
              },
            },
          ],
        },
      });

      expect(result).not.toBeNull();
      expect(result!.sql).toMatchInlineSnapshot(
        `"select "product"."productId" as "product:productId", "product"."_internalId" as "product:_internalId", "product"."_version" as "product:_version", "product"."_shard" as "product:_shard", "category"."categoryId" as "category:categoryId", "category"."_internalId" as "category:_internalId", "category"."_version" as "category:_version", "category"."_shard" as "category:_shard", "product_categories"."id" as "id", "product_categories"."_internalId" as "_internalId", "product_categories"."_version" as "_version", "product_categories"."_shard" as "_shard" from "product_categories" left join "products" as "product" on "product_categories"."prodRef" = "product"."_internalId" left join "categories" as "category" on "product_categories"."catRef" = "category"."_internalId""`,
      );
    });
  });
});
