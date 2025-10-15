import { describe, it, expect, assert, expectTypeOf } from "vitest";
import { column, schema, idColumn } from "../schema/create";
import {
  UnitOfWork,
  type UOWCompiler,
  type UOWDecoder,
  createUnitOfWork,
  type InferIdColumnName,
  type IndexColumns,
} from "./unit-of-work";
import { createIndexedBuilder } from "./condition-builder";
import type { AnySchema } from "../schema/create";
import type { AbstractQuery } from "./query";

// Mock compiler and executor for testing
function createMockCompiler<TSchema extends AnySchema = AnySchema>(): UOWCompiler<
  TSchema,
  unknown
> {
  return {
    compileRetrievalOperation: () => null,
    compileMutationOperation: () => null,
  };
}

function createMockExecutor() {
  return {
    executeRetrievalPhase: async () => [],
    executeMutationPhase: async () => ({ success: true }),
  };
}

function createMockDecoder<TSchema extends AnySchema = AnySchema>(): UOWDecoder<TSchema> {
  return (rawResults, operations) => {
    if (rawResults.length !== operations.length) {
      throw new Error("rawResults and operations must have the same length");
    }
    return rawResults;
  };
}

describe("FindBuilder", () => {
  it("should support primary index", () => {
    const testSchema = schema((s) =>
      s.addTable("users", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("email", "string")
          .addColumn("name", "string")
          .addColumn("age", "integer")
          .createIndex("idx_email", ["email"], { unique: true })
          .createIndex("idx_name_age", ["name", "age"]),
      ),
    );

    const uow = new UnitOfWork(
      testSchema,
      createMockCompiler(),
      createMockExecutor(),
      createMockDecoder(),
    );
    uow.find("users", (b) => b.whereIndex("primary"));

    const ops = uow.getRetrievalOperations();
    expect(ops).toHaveLength(1);
    expect(ops[0].indexName).toBe("_primary");
  });

  it("should support custom indexes", () => {
    const testSchema = schema((s) =>
      s.addTable("users", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("email", "string")
          .addColumn("name", "string")
          .createIndex("idx_email", ["email"], { unique: true }),
      ),
    );

    const uow = new UnitOfWork(
      testSchema,
      createMockCompiler(),
      createMockExecutor(),
      createMockDecoder(),
    );
    uow.find("users", (b) =>
      b.whereIndex("idx_email", (eb) => eb("email", "=", "test@example.com")),
    );

    const ops = uow.getRetrievalOperations();
    expect(ops).toHaveLength(1);
    expect(ops[0].indexName).toBe("idx_email");
  });

  it("should support cursor-based pagination", () => {
    const testSchema = schema((s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", "string")),
    );

    const uow = new UnitOfWork(
      testSchema,
      createMockCompiler(),
      createMockExecutor(),
      createMockDecoder(),
    );

    const cursor = "eyJpbmRleFZhbHVlcyI6eyJpZCI6InVzZXIxMjMifSwiZGlyZWN0aW9uIjoiZm9yd2FyZCJ9";
    uow.find("users", (b) => b.whereIndex("primary").after(cursor).pageSize(10));

    const ops = uow.getRetrievalOperations();
    expect(ops).toHaveLength(1);
    const op = ops[0];
    assert(op.type === "find");
    expect(op.options.after).toBe(cursor);
    expect(op.options.pageSize).toBe(10);
  });

  it("should support backward cursor pagination", () => {
    const testSchema = schema((s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", "string")),
    );

    const uow = new UnitOfWork(
      testSchema,
      createMockCompiler(),
      createMockExecutor(),
      createMockDecoder(),
    );

    const cursor = "eyJpbmRleFZhbHVlcyI6eyJpZCI6InVzZXI0NTYifSwiZGlyZWN0aW9uIjoiYmFja3dhcmQifQ==";
    uow.find("users", (b) => b.whereIndex("primary").before(cursor).pageSize(5));

    const ops = uow.getRetrievalOperations();
    expect(ops).toHaveLength(1);
    const op = ops[0];
    assert(op.type === "find");
    expect(op.options.before).toBe(cursor);
    expect(op.options.pageSize).toBe(5);
  });

  it("should throw if index doesn't exist", () => {
    const testSchema = schema((s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", "string")),
    );

    const uow = new UnitOfWork(
      testSchema,
      createMockCompiler(),
      createMockExecutor(),
      createMockDecoder(),
    );
    expect(() => {
      uow.find("users", (b) => b.whereIndex("nonexistent" as "primary"));
    }).toThrow('Index "nonexistent" not found on table "users"');
  });

  it("should throw if finalized without index", () => {
    const testSchema = schema((s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", "string")),
    );

    const uow = new UnitOfWork(
      testSchema,
      createMockCompiler(),
      createMockExecutor(),
      createMockDecoder(),
    );
    expect(() => {
      uow.find("users", (b) => b);
    }).toThrow(
      'Must specify an index using .whereIndex() before finalizing find operation on table "users"',
    );
  });

  it("should support count operations", () => {
    const testSchema = schema((s) =>
      s.addTable("users", (t) =>
        t.addColumn("id", idColumn()).addColumn("name", "string").addColumn("age", "integer"),
      ),
    );

    const uow = new UnitOfWork(
      testSchema,
      createMockCompiler(),
      createMockExecutor(),
      createMockDecoder(),
    );
    uow.find("users", (b) => b.whereIndex("primary").selectCount());

    const ops = uow.getRetrievalOperations();
    expect(ops).toHaveLength(1);
    expect(ops[0]?.type).toBe("count");
  });

  it("should throw when using both select and selectCount", () => {
    const testSchema = schema((s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", "string")),
    );

    const uow = new UnitOfWork(
      testSchema,
      createMockCompiler(),
      createMockExecutor(),
      createMockDecoder(),
    );

    // select() then selectCount()
    expect(() => {
      uow.find("users", (b) => b.whereIndex("primary").select(["name"]).selectCount());
    }).toThrow(/cannot call selectCount/i);

    // selectCount() then select()
    const uow2 = new UnitOfWork(
      testSchema,
      createMockCompiler(),
      createMockExecutor(),
      createMockDecoder(),
    );
    expect(() => {
      uow2.find("users", (b) => b.whereIndex("primary").selectCount().select(["name"]));
    }).toThrow(/cannot call select/i);
  });

  it("should support orderByIndex", () => {
    const testSchema = schema((s) =>
      s.addTable("users", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("name", "string")
          .addColumn("createdAt", "integer")
          .createIndex("idx_created", ["createdAt"]),
      ),
    );

    const uow = new UnitOfWork(
      testSchema,
      createMockCompiler(),
      createMockExecutor(),
      createMockDecoder(),
    );
    uow.find("users", (b) => b.whereIndex("primary").orderByIndex("idx_created", "desc"));

    const ops = uow.getRetrievalOperations();
    expect(ops).toHaveLength(1);
    const op = ops[0];
    if (op?.type === "find") {
      expect(op.options.orderByIndex).toEqual({
        indexName: "idx_created",
        direction: "desc",
      });
    } else {
      throw new Error("Expected find operation");
    }
  });

  it("should support join operations", () => {
    const testSchema = schema((s) =>
      s
        .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", "string"))
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("userId", column("string"))
            .addColumn("title", "string")
            .createIndex("idx_user", ["userId"]),
        )
        .addReference("posts", "user", {
          columns: ["userId"],
          targetTable: "users",
          targetColumns: ["id"],
        }),
    );

    const uow = new UnitOfWork(
      testSchema,
      createMockCompiler(),
      createMockExecutor(),
      createMockDecoder(),
    );

    uow.find("posts", (b) =>
      b.whereIndex("primary").join((jb) => {
        jb["user"]({ select: ["name"] });
      }),
    );

    const ops = uow.getRetrievalOperations();
    expect(ops).toHaveLength(1);
    const op = ops[0];
    assert(op.type === "find");
    expect(op.options.join).toBeDefined();
    expect(op.options.join).toHaveLength(1);
  });
});

describe("IndexedConditionBuilder", () => {
  const testSchema = schema((s) =>
    s.addTable("users", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("email", column("string"))
        .addColumn("name", column("string"))
        .addColumn("age", column("integer").nullable())
        .addColumn("bio", column("string").nullable()) // Not indexed
        .createIndex("_primary", ["id"], { unique: true })
        .createIndex("idx_email", ["email"], { unique: true })
        .createIndex("idx_name_age", ["name", "age"]),
    ),
  );

  const usersTable = testSchema.tables.users;

  it("should enforce indexed columns at runtime", () => {
    // Collect all indexed column names from all indexes
    const indexedColumns = new Set<string>();
    for (const index of Object.values(usersTable.indexes)) {
      for (const col of index.columns) {
        indexedColumns.add(col.ormName);
      }
    }

    const builder = createIndexedBuilder(usersTable.columns, indexedColumns);

    // Should work with indexed columns
    expect(() => builder("id", "=", "123")).not.toThrow();
    expect(() => builder("email", "=", "test@example.com")).not.toThrow();
    expect(() => builder("name", "=", "Alice")).not.toThrow();
    expect(() => builder("age", ">", 18)).not.toThrow();

    // Should throw when using non-indexed column
    expect(() => builder("bio" as "email", "=", "Some bio")).toThrow('Column "bio" is not indexed');
  });

  it("should work with complex conditions", () => {
    const indexedColumns = new Set(["id", "email", "name", "age"]);
    const builder = createIndexedBuilder(usersTable.columns, indexedColumns);

    // Complex AND condition with indexed columns
    const condition = builder.and(
      builder("name", "=", "Alice"),
      builder("age", ">", 18),
      builder("email", "contains", "example"),
    );

    expect(condition).toEqual({
      type: "and",
      items: [
        {
          type: "compare",
          a: usersTable.columns.name,
          operator: "=",
          b: "Alice",
        },
        {
          type: "compare",
          a: usersTable.columns.age,
          operator: ">",
          b: 18,
        },
        {
          type: "compare",
          a: usersTable.columns.email,
          operator: "contains",
          b: "example",
        },
      ],
    });
  });

  it("should provide helpful error message listing available columns", () => {
    const indexedColumns = new Set(["id", "email"]);
    const builder = createIndexedBuilder(usersTable.columns, indexedColumns);

    expect(() => builder("name" as "email", "=", "Alice")).toThrow(
      "Only indexed columns can be used in Unit of Work queries. Available indexed columns: id, email",
    );
  });

  it("should work with all builder helper methods", () => {
    const indexedColumns = new Set(["id", "email", "age"]);
    const builder = createIndexedBuilder(usersTable.columns, indexedColumns);

    // isNull
    expect(() => builder.isNull("age")).not.toThrow();
    expect(() => builder.isNull("bio" as "age")).toThrow('Column "bio" is not indexed');

    // isNotNull
    expect(() => builder.isNotNull("email")).not.toThrow();
    expect(() => builder.isNotNull("bio" as "email")).toThrow('Column "bio" is not indexed');

    // not
    const notCondition = builder.not(builder("id", "=", "123"));
    expect(notCondition).toEqual({
      type: "not",
      item: {
        type: "compare",
        a: usersTable.columns.id,
        operator: "=",
        b: "123",
      },
    });

    // or
    const orCondition = builder.or(builder("email", "contains", "gmail"), builder("age", ">", 30));
    expect(orCondition).toEqual({
      type: "or",
      items: [
        {
          type: "compare",
          a: usersTable.columns.email,
          operator: "contains",
          b: "gmail",
        },
        {
          type: "compare",
          a: usersTable.columns.age,
          operator: ">",
          b: 30,
        },
      ],
    });
  });

  it("should enforce index restrictions in nested conditions", () => {
    const indexedColumns = new Set(["id", "email"]);
    const builder = createIndexedBuilder(usersTable.columns, indexedColumns);

    // This should throw because "name" is not indexed, even though it's nested
    expect(() => {
      builder.and(
        builder("email", "=", "test@example.com"),
        builder("name" as "email", "=", "Alice"),
      );
    }).toThrow('Column "name" is not indexed');

    // This should throw because "bio" is not indexed, even in OR
    expect(() => {
      builder.or(builder("id", "=", "123"), builder("bio" as "id", "=", "Some bio"));
    }).toThrow('Column "bio" is not indexed');
  });

  describe("type safety", () => {
    it("should restrict to only indexed columns at type level", () => {
      // This schema has "bio" column that is NOT indexed
      const typeTestSchema = schema((s) =>
        s.addTable("users", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("email", column("string"))
            .addColumn("name", column("string"))
            .addColumn("age", column("integer").nullable())
            .addColumn("bio", column("string").nullable()) // Not indexed!
            .createIndex("idx_email", ["email"], { unique: true })
            .createIndex("idx_name_age", ["name", "age"]),
        ),
      );

      type _IdColumnName = InferIdColumnName<typeof typeTestSchema.tables.users>;
      expectTypeOf<_IdColumnName>().toEqualTypeOf<"id">();
      type _IndexColumnNames = IndexColumns<
        typeof typeTestSchema.tables.users.indexes.idx_name_age
      >;
      expectTypeOf<_IndexColumnNames>().toEqualTypeOf<"name" | "age">();

      const uow = createUnitOfWork(
        typeTestSchema,
        createMockCompiler<typeof typeTestSchema>(),
        createMockExecutor(),
        createMockDecoder<typeof typeTestSchema>(),
      );
      expectTypeOf(uow.schema).toEqualTypeOf(typeTestSchema);
      expectTypeOf<keyof typeof typeTestSchema.tables>().toEqualTypeOf<"users">();
      type _Query = AbstractQuery<typeof typeTestSchema>;
      expectTypeOf<Parameters<_Query["create"]>[0]>().toEqualTypeOf<"users">();

      expectTypeOf(uow.find).parameter(0).toEqualTypeOf<"users">();

      uow.find("users", (b) =>
        b.whereIndex("primary", (eb) => {
          type _EbFirstParameter = Parameters<typeof eb>[0];
          expectTypeOf<_EbFirstParameter>().toEqualTypeOf<"id">();
          return eb("id", "=", "123");
        }),
      );

      uow.find("users", (b) =>
        b.whereIndex("idx_email", (eb) => {
          expectTypeOf(eb).parameter(0).toEqualTypeOf<"email">();
          return eb("email", "=", "123");
        }),
      );

      uow.find("users", (b) =>
        b.whereIndex("idx_name_age", (eb) => {
          expectTypeOf(eb).parameter(0).toEqualTypeOf<"name" | "age">();
          return eb("name", "=", "123");
        }),
      );
    });
  });
});

describe("UpdateBuilder with string ID", () => {
  const testSchema = schema((s) =>
    s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", "string")),
  );

  it("should allow update with string ID", async () => {
    const uow = new UnitOfWork(
      testSchema,
      createMockCompiler(),
      createMockExecutor(),
      createMockDecoder(),
    );

    // Should work with string ID
    uow.update("users", "user-123", (b) => b.set({ name: "New Name" }));

    const ops = uow.getMutationOperations();
    expect(ops).toHaveLength(1);
    expect(ops).toMatchObject([
      {
        type: "update",
        id: "user-123",
        checkVersion: false,
      },
    ]);
  });

  it("should throw when using check() with string ID", async () => {
    const uow = new UnitOfWork(
      testSchema,
      createMockCompiler(),
      createMockExecutor(),
      createMockDecoder(),
    );

    // Should throw because check() is not allowed with string ID
    expect(() => {
      uow.update("users", "user-123", (b) => b.set({ name: "New Name" }).check());
    }).toThrow(
      'Cannot use check() with a string ID on table "users". Version checking requires a FragnoId with version information.',
    );
  });
});

describe("DeleteBuilder with string ID", () => {
  const testSchema = schema((s) =>
    s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", "string")),
  );

  it("should allow delete with string ID", async () => {
    const uow = new UnitOfWork(
      testSchema,
      createMockCompiler(),
      createMockExecutor(),
      createMockDecoder(),
    );

    // Should work with string ID
    uow.delete("users", "user-123");

    const ops = uow.getMutationOperations();
    expect(ops).toMatchObject([
      {
        type: "delete",
        id: "user-123",
        checkVersion: false,
      },
    ]);
  });

  it("should throw when using check() with string ID", async () => {
    const uow = new UnitOfWork(
      testSchema,
      createMockCompiler(),
      createMockExecutor(),
      createMockDecoder(),
    );

    // Should throw because check() is not allowed with string ID
    expect(() => {
      uow.delete("users", "user-123", (b) => b.check());
    }).toThrow(
      'Cannot use check() with a string ID on table "users". Version checking requires a FragnoId with version information.',
    );
  });
});
