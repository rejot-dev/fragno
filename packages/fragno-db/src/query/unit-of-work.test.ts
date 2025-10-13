import { describe, it, expect } from "vitest";
import { column, schema, idColumn } from "../schema/create";
import { UnitOfWork, type UOWCompiler, type UOWDecoder } from "./unit-of-work";
import { createIndexedBuilder } from "./condition-builder";
import type { AnySchema } from "../schema/create";

// Mock compiler and executor for testing
function createMockCompiler(): UOWCompiler<AnySchema, unknown> {
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

function createMockDecoder(): UOWDecoder<AnySchema> {
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

  it("should support limit and offset", () => {
    const testSchema = schema((s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", "string")),
    );

    const uow = new UnitOfWork(
      testSchema,
      createMockCompiler(),
      createMockExecutor(),
      createMockDecoder(),
    );
    uow.find("users", (b) => b.whereIndex("primary").limit(10).offset(5));

    const ops = uow.getRetrievalOperations();
    expect(ops).toHaveLength(1);
    expect(ops[0].options.limit).toBe(10);
    expect(ops[0].options.offset).toBe(5);
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
      'Must specify an index using .where() before finalizing find operation on table "users"',
    );
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
