import { describe, it, expect, assert, expectTypeOf } from "vitest";
import { column, schema, idColumn, FragnoId } from "../schema/create";
import {
  type UOWCompiler,
  type UOWDecoder,
  createUnitOfWork,
  type InferIdColumnName,
  type IndexColumns,
} from "./unit-of-work";
import { createIndexedBuilder } from "./condition-builder";
import type { AbstractQuery } from "./query";

// Mock compiler and executor for testing
function createMockCompiler(): UOWCompiler<unknown> {
  return {
    compileRetrievalOperation: () => null,
    compileMutationOperation: () => null,
  };
}

function createMockExecutor() {
  return {
    executeRetrievalPhase: async () => [],
    executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
  };
}

function createMockDecoder(): UOWDecoder {
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

    const uow = createUnitOfWork(createMockCompiler(), createMockExecutor(), createMockDecoder());
    uow.forSchema(testSchema).find("users", (b) => b.whereIndex("primary"));

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

    const uow = createUnitOfWork(createMockCompiler(), createMockExecutor(), createMockDecoder());
    uow
      .forSchema(testSchema)
      .find("users", (b) =>
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

    const uow = createUnitOfWork(createMockCompiler(), createMockExecutor(), createMockDecoder());

    const cursor = "eyJpbmRleFZhbHVlcyI6eyJpZCI6InVzZXIxMjMifSwiZGlyZWN0aW9uIjoiZm9yd2FyZCJ9";
    uow
      .forSchema(testSchema)
      .find("users", (b) => b.whereIndex("primary").after(cursor).pageSize(10));

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

    const uow = createUnitOfWork(createMockCompiler(), createMockExecutor(), createMockDecoder());

    const cursor = "eyJpbmRleFZhbHVlcyI6eyJpZCI6InVzZXI0NTYifSwiZGlyZWN0aW9uIjoiYmFja3dhcmQifQ==";
    uow
      .forSchema(testSchema)
      .find("users", (b) => b.whereIndex("primary").before(cursor).pageSize(5));

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

    const uow = createUnitOfWork(createMockCompiler(), createMockExecutor(), createMockDecoder());
    expect(() => {
      uow.forSchema(testSchema).find("users", (b) => b.whereIndex("nonexistent" as "primary"));
    }).toThrow('Index "nonexistent" not found on table "users"');
  });

  it("should throw if finalized without index", () => {
    const testSchema = schema((s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", "string")),
    );

    const uow = createUnitOfWork(createMockCompiler(), createMockExecutor(), createMockDecoder());
    expect(() => {
      uow.forSchema(testSchema).find("users", (b) => b);
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

    const uow = createUnitOfWork(createMockCompiler(), createMockExecutor(), createMockDecoder());
    uow.forSchema(testSchema).find("users", (b) => b.whereIndex("primary").selectCount());

    const ops = uow.getRetrievalOperations();
    expect(ops).toHaveLength(1);
    expect(ops[0]?.type).toBe("count");
  });

  it("should throw when using both select and selectCount", () => {
    const testSchema = schema((s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", "string")),
    );

    const uow = createUnitOfWork(createMockCompiler(), createMockExecutor(), createMockDecoder());

    // select() then selectCount()
    expect(() => {
      uow
        .forSchema(testSchema)
        .find("users", (b) => b.whereIndex("primary").select(["name"]).selectCount());
    }).toThrow(/cannot call selectCount/i);

    // selectCount() then select()
    const uow2 = createUnitOfWork(createMockCompiler(), createMockExecutor(), createMockDecoder());
    expect(() => {
      uow2
        .forSchema(testSchema)
        .find("users", (b) => b.whereIndex("primary").selectCount().select(["name"]));
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

    const uow = createUnitOfWork(createMockCompiler(), createMockExecutor(), createMockDecoder());
    uow
      .forSchema(testSchema)
      .find("users", (b) => b.whereIndex("primary").orderByIndex("idx_created", "desc"));

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
        .addReference("user", {
          type: "one",
          from: { table: "posts", column: "userId" },
          to: { table: "users", column: "id" },
        }),
    );

    const uow = createUnitOfWork(createMockCompiler(), createMockExecutor(), createMockDecoder());

    uow
      .forSchema(testSchema)
      .find("posts", (b) =>
        b.whereIndex("primary").join((jb) => jb["user"]((builder) => builder.select(["name"]))),
      );

    const ops = uow.getRetrievalOperations();
    expect(ops).toHaveLength(1);
    const op = ops[0];
    assert(op.type === "find");
    expect(op.options.joins).toBeDefined();
    expect(op.options.joins).toHaveLength(1);
  });

  it("should support join operations without builder function", () => {
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
        .addReference("user", {
          type: "one",
          from: { table: "posts", column: "userId" },
          to: { table: "users", column: "id" },
        }),
    );

    const uow = createUnitOfWork(createMockCompiler(), createMockExecutor(), createMockDecoder());

    // Join without builder function should use default options
    uow.forSchema(testSchema).find("posts", (b) => b.whereIndex("primary").join((jb) => jb.user()));

    const ops = uow.getRetrievalOperations();
    expect(ops).toHaveLength(1);
    const op = ops[0];
    assert(op.type === "find");
    expect(op.options.joins).toBeDefined();
    expect(op.options.joins).toHaveLength(1);
    const joinOptions = op.options.joins![0]!.options;
    assert(joinOptions !== false);
    expect(joinOptions.select).toBe(true); // Should default to selecting all columns
  });

  it("should support join with whereIndex", () => {
    const testSchema = schema((s) =>
      s
        .addTable("users", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("name", "string")
            .createIndex("idx_name", ["name"]),
        )
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("userId", column("string"))
            .addColumn("title", "string")
            .createIndex("idx_user", ["userId"]),
        )
        .addReference("user", {
          type: "one",
          from: { table: "posts", column: "userId" },
          to: { table: "users", column: "id" },
        }),
    );

    const uow = createUnitOfWork(createMockCompiler(), createMockExecutor(), createMockDecoder());

    uow
      .forSchema(testSchema)
      .find("posts", (b) =>
        b
          .whereIndex("primary")
          .join((jb) =>
            jb["user"]((builder) =>
              builder.whereIndex("idx_name", (eb) => eb("name", "=", "Alice")).select(["name"]),
            ),
          ),
      );

    const ops = uow.getRetrievalOperations();
    expect(ops).toHaveLength(1);
    const op = ops[0];
    assert(op.type === "find");
    expect(op.options.joins).toBeDefined();
    expect(op.options.joins).toHaveLength(1);
    const joinOptions = op.options.joins![0]!.options;
    assert(joinOptions !== false);
    expect(joinOptions.where).toBeDefined();
  });

  it("should support join with orderByIndex", () => {
    const testSchema = schema((s) =>
      s
        .addTable("users", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("name", "string")
            .addColumn("createdAt", "integer")
            .createIndex("idx_created", ["createdAt"]),
        )
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("userId", column("string"))
            .addColumn("title", "string")
            .createIndex("idx_user", ["userId"]),
        )
        .addReference("user", {
          type: "one",
          from: { table: "posts", column: "userId" },
          to: { table: "users", column: "id" },
        }),
    );

    const uow = createUnitOfWork(createMockCompiler(), createMockExecutor(), createMockDecoder());

    uow
      .forSchema(testSchema)
      .find("posts", (b) =>
        b
          .whereIndex("primary")
          .join((jb) => jb["user"]((builder) => builder.orderByIndex("idx_created", "desc"))),
      );

    const ops = uow.getRetrievalOperations();
    expect(ops).toHaveLength(1);
    const op = ops[0];
    assert(op.type === "find");
    expect(op.options.joins).toBeDefined();
    const joinOptions = op.options.joins![0]!.options;
    assert(joinOptions !== false);
    expect(joinOptions.orderBy).toBeDefined();
    expect(joinOptions.orderBy).toHaveLength(1);
  });

  it("should support join with pageSize", () => {
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
        .addReference("user", {
          type: "one",
          from: { table: "posts", column: "userId" },
          to: { table: "users", column: "id" },
        }),
    );

    const uow = createUnitOfWork(createMockCompiler(), createMockExecutor(), createMockDecoder());

    uow
      .forSchema(testSchema)
      .find("posts", (b) =>
        b.whereIndex("primary").join((jb) => jb["user"]((builder) => builder.pageSize(5))),
      );

    const ops = uow.getRetrievalOperations();
    expect(ops).toHaveLength(1);
    const op = ops[0];
    assert(op.type === "find");
    const joinOptions = op.options.joins![0]!.options;
    assert(joinOptions !== false);
    expect(joinOptions.limit).toBe(5);
  });

  it("should support nested joins", () => {
    const testSchema = schema((s) =>
      s
        .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", "string"))
        .addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("userId", column("string"))
            .addColumn("authorId", column("string"))
            .addColumn("title", "string")
            .createIndex("idx_user", ["userId"])
            .createIndex("idx_author", ["authorId"]),
        )
        .addTable("comments", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("postId", column("string"))
            .addColumn("text", "string")
            .createIndex("idx_post", ["postId"]),
        )
        .addReference("user", {
          type: "one",
          from: { table: "posts", column: "userId" },
          to: { table: "users", column: "id" },
        })
        .addReference("post", {
          type: "one",
          from: { table: "comments", column: "postId" },
          to: { table: "posts", column: "id" },
        }),
    );

    const uow = createUnitOfWork(createMockCompiler(), createMockExecutor(), createMockDecoder());

    uow
      .forSchema(testSchema)
      .find("comments", (b) =>
        b
          .whereIndex("primary")
          .join((jb) =>
            jb["post"]((postBuilder) =>
              postBuilder
                .select(["title"])
                .join((jb2) => jb2["user"]((userBuilder) => userBuilder.select(["name"]))),
            ),
          ),
      );

    const ops = uow.getRetrievalOperations();
    expect(ops).toHaveLength(1);
    const op = ops[0];
    assert(op.type === "find");
    expect(op.options.joins).toBeDefined();
    expect(op.options.joins).toHaveLength(1);

    const postJoin = op.options.joins![0]!;
    assert(postJoin.options !== false);
    expect(postJoin.options.join).toBeDefined();
    expect(postJoin.options.join).toHaveLength(1);

    const userJoin = postJoin.options.join![0]!;
    assert(userJoin.options !== false);
    expect(userJoin.relation.name).toBe("user");
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

      const baseUow = createUnitOfWork(
        createMockCompiler(),
        createMockExecutor(),
        createMockDecoder(),
      );
      const uow = baseUow.forSchema(typeTestSchema);
      expectTypeOf<keyof typeof typeTestSchema.tables>().toEqualTypeOf<"users">();
      type _Query = AbstractQuery<typeof typeTestSchema>;
      expectTypeOf<Parameters<_Query["create"]>[0]>().toEqualTypeOf<"users">();

      expectTypeOf<Parameters<typeof uow.find>[0]>().toEqualTypeOf<"users">();

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
    const uow = createUnitOfWork(createMockCompiler(), createMockExecutor(), createMockDecoder());

    // Should work with string ID
    uow.forSchema(testSchema).update("users", "user-123", (b) => b.set({ name: "New Name" }));

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
    const uow = createUnitOfWork(createMockCompiler(), createMockExecutor(), createMockDecoder());

    // Should throw because check() is not allowed with string ID
    expect(() => {
      uow
        .forSchema(testSchema)
        .update("users", "user-123", (b) => b.set({ name: "New Name" }).check());
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
    const uow = createUnitOfWork(createMockCompiler(), createMockExecutor(), createMockDecoder());

    // Should work with string ID
    uow.forSchema(testSchema).delete("users", "user-123");

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
    const uow = createUnitOfWork(createMockCompiler(), createMockExecutor(), createMockDecoder());

    // Should throw because check() is not allowed with string ID
    expect(() => {
      uow.forSchema(testSchema).delete("users", "user-123", (b) => b.check());
    }).toThrow(
      'Cannot use check() with a string ID on table "users". Version checking requires a FragnoId with version information.',
    );
  });
});

describe("getCreatedIds", () => {
  const testSchema = schema((s) =>
    s.addTable("users", (t) =>
      t.addColumn("id", idColumn()).addColumn("email", "string").addColumn("name", "string"),
    ),
  );

  it("should return created IDs after executeMutations with internal IDs", async () => {
    const executor = {
      executeRetrievalPhase: async () => [],
      executeMutationPhase: async () => ({
        success: true,
        createdInternalIds: [1n, 2n],
      }),
    };

    const uow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());

    uow.forSchema(testSchema).create("users", { email: "user1@example.com", name: "User 1" });
    uow.forSchema(testSchema).create("users", { email: "user2@example.com", name: "User 2" });

    await uow.executeMutations();
    const createdIds = uow.getCreatedIds();

    expect(createdIds).toHaveLength(2);
    expect(createdIds[0].externalId).toBeDefined();
    expect(createdIds[0].internalId).toBe(1n);
    expect(createdIds[0].version).toBe(0);
    expect(createdIds[1].externalId).toBeDefined();
    expect(createdIds[1].internalId).toBe(2n);
    expect(createdIds[1].version).toBe(0);
  });

  it("should return created IDs without internal IDs when not supported", async () => {
    const executor = {
      executeRetrievalPhase: async () => [],
      executeMutationPhase: async () => ({
        success: true,
        createdInternalIds: [null, null],
      }),
    };

    const uow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());

    uow.forSchema(testSchema).create("users", { email: "user1@example.com", name: "User 1" });
    uow.forSchema(testSchema).create("users", { email: "user2@example.com", name: "User 2" });

    await uow.executeMutations();
    const createdIds = uow.getCreatedIds();

    expect(createdIds).toHaveLength(2);
    expect(createdIds[0].externalId).toBeDefined();
    expect(createdIds[0].internalId).toBeUndefined();
    expect(createdIds[1].externalId).toBeDefined();
    expect(createdIds[1].internalId).toBeUndefined();
  });

  it("should preserve user-provided external IDs", async () => {
    const executor = {
      executeRetrievalPhase: async () => [],
      executeMutationPhase: async () => ({
        success: true,
        createdInternalIds: [1n],
      }),
    };

    const uow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());

    uow
      .forSchema(testSchema)
      .create("users", { id: "my-custom-id", email: "user@example.com", name: "User" });

    await uow.executeMutations();
    const createdIds = uow.getCreatedIds();

    expect(createdIds).toHaveLength(1);
    expect(createdIds[0].externalId).toBe("my-custom-id");
    expect(createdIds[0].internalId).toBe(1n);
  });

  it("should only return IDs for create operations, not updates or deletes", async () => {
    const executor = {
      executeRetrievalPhase: async () => [],
      executeMutationPhase: async () => ({
        success: true,
        createdInternalIds: [1n],
      }),
    };

    const uow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());

    uow.forSchema(testSchema).create("users", { email: "user@example.com", name: "User" });
    uow.forSchema(testSchema).update("users", "existing-id", (b) => b.set({ name: "Updated" }));
    uow.forSchema(testSchema).delete("users", "other-id");

    await uow.executeMutations();
    const createdIds = uow.getCreatedIds();

    // Only one create operation, so only one ID returned
    expect(createdIds).toHaveLength(1);
    expect(createdIds[0].internalId).toBe(1n);
  });

  it("should throw when called before executeMutations", () => {
    const uow = createUnitOfWork(createMockCompiler(), createMockExecutor(), createMockDecoder());

    uow.forSchema(testSchema).create("users", { email: "user@example.com", name: "User" });

    expect(() => uow.getCreatedIds()).toThrow(
      "getCreatedIds() can only be called after executeMutations()",
    );
  });
});

describe("Phase promises with multiple views", () => {
  it("should return only operations added to the current view when using retrievalPhase promise", async () => {
    // Create two separate schemas
    const schema1 = schema((s) =>
      s.addTable("users", (t) =>
        t.addColumn("id", idColumn()).addColumn("name", "string").addColumn("email", "string"),
      ),
    );

    const schema2 = schema((s) =>
      s.addTable("posts", (t) =>
        t.addColumn("id", idColumn()).addColumn("title", "string").addColumn("content", "string"),
      ),
    );

    // Create a schema namespace map
    const schemaNamespaceMap = new WeakMap<typeof schema1 | typeof schema2, string>();
    schemaNamespaceMap.set(schema1, "namespace1");
    schemaNamespaceMap.set(schema2, "namespace2");

    // Mock executor that returns distinct results
    const executor = {
      executeRetrievalPhase: async () => {
        return [
          [{ id: "user1", name: "Alice", email: "alice@example.com" }],
          [{ id: "user2", name: "Bob", email: "bob@example.com" }],
          [{ id: "post1", title: "Post 1", content: "Content 1" }],
        ];
      },
      executeMutationPhase: async () => ({
        success: true,
        createdInternalIds: [],
      }),
    };

    // Create parent UOW
    const parentUow = createUnitOfWork(
      createMockCompiler(),
      executor,
      createMockDecoder(),
      schemaNamespaceMap,
      "test-uow",
    );

    // Add a find operation via a schema1 view (but don't keep a reference to this view)
    parentUow.forSchema(schema1).find("users", (b) => b.whereIndex("primary"));

    // Create a view for schema1 and add another find operation
    const view1 = parentUow.forSchema(schema1).find("users", (b) => b.whereIndex("primary"));

    // Create a view for schema2 and add a find operation
    const view2 = parentUow.forSchema(schema2).find("posts", (b) => b.whereIndex("primary"));

    // Execute retrieval phase on parent
    const parentResults = await parentUow.executeRetrieve();

    // Parent should have all 3 results
    expect(parentResults).toHaveLength(3);

    // View1's retrievalPhase promise should only contain results from operations added through view1
    // (which is index 1 in the parent's operations)
    const view1Results = await view1.retrievalPhase;
    expect(view1Results).toHaveLength(1);
    expect(view1Results[0]).toEqual([{ id: "user2", name: "Bob", email: "bob@example.com" }]);

    // View2's retrievalPhase promise should only contain results from operations added through view2
    // (which is index 2 in the parent's operations)
    const view2Results = await view2.retrievalPhase;
    expect(view2Results).toHaveLength(1);
    expect(view2Results[0]).toEqual([{ id: "post1", title: "Post 1", content: "Content 1" }]);
  });

  it("should isolate operations when getUnitOfWork is called multiple times with same schema", async () => {
    const testSchema = schema((s) =>
      s.addTable("users", (t) =>
        t.addColumn("id", idColumn()).addColumn("name", "string").addColumn("email", "string"),
      ),
    );

    const executor = {
      executeRetrievalPhase: async () => {
        return [
          [{ id: "user1", name: "Alice", email: "alice@example.com" }],
          [{ id: "user2", name: "Bob", email: "bob@example.com" }],
        ];
      },
      executeMutationPhase: async () => ({
        success: true,
        createdInternalIds: [],
      }),
    };

    const parentUow = createUnitOfWork(
      createMockCompiler(),
      executor,
      createMockDecoder(),
      undefined,
      "test-uow",
    );

    // Simulate what happens in db-fragment-definition-builder when getUnitOfWork(schema) is called twice
    const view1 = parentUow.forSchema(testSchema).find("users", (b) => b.whereIndex("primary"));

    const view2 = parentUow.forSchema(testSchema).find("users", (b) => b.whereIndex("primary"));

    // Execute retrieval
    await parentUow.executeRetrieve();

    // Each view should only see its own operation's results
    const view1Results = await view1.retrievalPhase;
    expect(view1Results).toHaveLength(1);
    expect(view1Results[0]).toEqual([{ id: "user1", name: "Alice", email: "alice@example.com" }]);

    const view2Results = await view2.retrievalPhase;
    expect(view2Results).toHaveLength(1);
    expect(view2Results[0]).toEqual([{ id: "user2", name: "Bob", email: "bob@example.com" }]);
  });

  it("should show that getCreatedIds returns ALL created IDs regardless of which view created them", async () => {
    const schema1 = schema((s) =>
      s.addTable("users", (t) =>
        t.addColumn("id", idColumn()).addColumn("name", "string").addColumn("email", "string"),
      ),
    );

    const schema2 = schema((s) =>
      s.addTable("posts", (t) =>
        t.addColumn("id", idColumn()).addColumn("title", "string").addColumn("content", "string"),
      ),
    );

    const schemaNamespaceMap = new WeakMap<typeof schema1 | typeof schema2, string>();
    schemaNamespaceMap.set(schema1, "namespace1");
    schemaNamespaceMap.set(schema2, "namespace2");

    const executor = {
      executeRetrievalPhase: async () => [],
      executeMutationPhase: async () => ({
        success: true,
        createdInternalIds: [1n, 2n],
      }),
    };

    const parentUow = createUnitOfWork(
      createMockCompiler(),
      executor,
      createMockDecoder(),
      schemaNamespaceMap,
      "test-uow",
    );

    // View1 creates one user
    const view1 = parentUow.forSchema(schema1);
    view1.create("users", { name: "Alice", email: "alice@example.com" });

    // View2 creates one post
    const view2 = parentUow.forSchema(schema2);
    view2.create("posts", { title: "Post 1", content: "Content 1" });

    // Execute mutations
    await parentUow.executeMutations();

    // Both views see ALL created IDs (not filtered by view)
    const view1Ids = view1.getCreatedIds();
    const view2Ids = view2.getCreatedIds();

    expect(view1Ids).toHaveLength(2); // Sees both IDs, not just the one it created
    expect(view2Ids).toHaveLength(2); // Sees both IDs, not just the one it created

    // They're the same array
    expect(view1Ids).toEqual(view2Ids);
  });

  it("should generate unique IDs when multiple views create items", async () => {
    const schema1 = schema((s) =>
      s.addTable("users", (t) =>
        t.addColumn("id", idColumn()).addColumn("name", "string").addColumn("email", "string"),
      ),
    );

    const schema2 = schema((s) =>
      s.addTable("posts", (t) =>
        t.addColumn("id", idColumn()).addColumn("title", "string").addColumn("content", "string"),
      ),
    );

    const schemaNamespaceMap = new WeakMap<typeof schema1 | typeof schema2, string>();
    schemaNamespaceMap.set(schema1, "namespace1");
    schemaNamespaceMap.set(schema2, "namespace2");

    const executor = {
      executeRetrievalPhase: async () => [],
      executeMutationPhase: async () => ({
        success: true,
        createdInternalIds: [1n, 2n],
      }),
    };

    const parentUow = createUnitOfWork(
      createMockCompiler(),
      executor,
      createMockDecoder(),
      schemaNamespaceMap,
      "test-uow",
    );

    // View1 creates a user
    const view1 = parentUow.forSchema(schema1);
    const userId = view1.create("users", { name: "Alice", email: "alice@example.com" });

    // View2 creates a post
    const view2 = parentUow.forSchema(schema2);
    const postId = view2.create("posts", { title: "Post 1", content: "Content 1" });

    // IDs should be unique before execution
    expect(userId.externalId).not.toBe(postId.externalId);
    expect(userId.externalId).toBeTruthy();
    expect(postId.externalId).toBeTruthy();
    expect(userId.internalId).toBeUndefined();
    expect(postId.internalId).toBeUndefined();

    // Execute mutations
    await parentUow.executeMutations();

    // Get the created IDs after execution
    const createdIds = parentUow.getCreatedIds();
    expect(createdIds).toHaveLength(2);

    // Both should have external IDs set (from create operation)
    expect(createdIds[0].externalId).toBe(userId.externalId);
    expect(createdIds[1].externalId).toBe(postId.externalId);

    // Both should now have internal IDs (from database)
    expect(createdIds[0].internalId).toBe(1n);
    expect(createdIds[1].internalId).toBe(2n);

    // IDs should still be unique
    expect(createdIds[0].externalId).not.toBe(createdIds[1].externalId);
  });
});

describe("Error Handling", () => {
  const testSchema = schema((s) =>
    s.addTable("users", (t) =>
      t.addColumn("id", idColumn()).addColumn("name", "string").addColumn("email", "string"),
    ),
  );

  it("should throw error from executeRetrieve() when retrieval fails", async () => {
    const executor = {
      executeRetrievalPhase: async () => {
        throw new Error("Database connection failed");
      },
      executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
    };

    const uow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());
    uow.forSchema(testSchema).find("users", (b) => b.whereIndex("primary"));

    await expect(uow.executeRetrieve()).rejects.toThrow("Database connection failed");
  });

  it("should throw error from executeMutations() when mutation fails", async () => {
    const executor = {
      executeRetrievalPhase: async () => [],
      executeMutationPhase: async () => {
        throw new Error("Write conflict");
      },
    };

    const uow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());
    uow.forSchema(testSchema).create("users", { name: "Alice", email: "alice@example.com" });

    await expect(uow.executeMutations()).rejects.toThrow("Write conflict");
  });

  it("should reject retrievalPhase promise when executeRetrieve() fails", async () => {
    const executor = {
      executeRetrievalPhase: async () => {
        throw new Error("Query timeout");
      },
      executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
    };

    const uow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());
    uow.forSchema(testSchema).find("users", (b) => b.whereIndex("primary"));

    // Start executing (this will fail)
    const executePromise = uow.executeRetrieve().catch(() => {
      /* handled */
    });

    // The retrievalPhase promise should also reject
    await expect(uow.retrievalPhase).rejects.toThrow("Query timeout");

    // Wait for execute to complete
    await executePromise;
  });

  it("should reject mutationPhase promise when executeMutations() fails", async () => {
    const executor = {
      executeRetrievalPhase: async () => [],
      executeMutationPhase: async () => {
        throw new Error("Constraint violation");
      },
    };

    const uow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());
    uow.forSchema(testSchema).create("users", { name: "Alice", email: "alice@example.com" });

    // Start executing (this will fail)
    const executePromise = uow.executeMutations().catch(() => {
      /* handled */
    });

    // The mutationPhase promise should also reject
    await expect(uow.mutationPhase).rejects.toThrow("Constraint violation");

    // Wait for execute to complete
    await executePromise;
  });

  it("should not cause unhandled promise rejection when executeRetrieve() fails and coordination promise is not awaited", async () => {
    const executor = {
      executeRetrievalPhase: async () => {
        throw new Error("Table does not exist");
      },
      executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
    };

    const uow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());
    uow.forSchema(testSchema).find("users", (b) => b.whereIndex("primary"));

    // Access the retrievalPhase promise but don't await it
    // This simulates the internal coordination promise that might not be awaited
    const _retrievalPhase = uow.retrievalPhase;

    const errorResolver = Promise.withResolvers<void>();

    // Execute and catch the error from executeRetrieve()
    try {
      await uow.executeRetrieve();
    } catch (error) {
      // Error is caught, this is expected
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Table does not exist");
      errorResolver.resolve();
    }

    await errorResolver.promise;
  });

  it("should not cause unhandled promise rejection when executeMutations() fails and coordination promise is not awaited", async () => {
    const executor = {
      executeRetrievalPhase: async () => [],
      executeMutationPhase: async () => {
        throw new Error("Deadlock detected");
      },
    };

    const uow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());
    uow.forSchema(testSchema).create("users", { name: "Alice", email: "alice@example.com" });

    // Access the mutationPhase promise but don't await it
    // This simulates the internal coordination promise that might not be awaited
    const _mutationPhase = uow.mutationPhase;

    const errorResolver = Promise.withResolvers<void>();

    // Execute and catch the error from executeMutations()
    try {
      await uow.executeMutations();
    } catch (error) {
      // Error is caught, this is expected
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Deadlock detected");
      errorResolver.resolve();
    }

    await errorResolver.promise;
  });

  it("should handle error in executeRetrieve() when coordination promise is never accessed", async () => {
    const executor = {
      executeRetrievalPhase: async () => {
        throw new Error("Connection lost");
      },
      executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
    };

    const uow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());
    uow.forSchema(testSchema).find("users", (b) => b.whereIndex("primary"));

    // Don't access retrievalPhase at all - this is the most common case
    // The internal coordination promise should not cause unhandled rejection
    const errorResolver = Promise.withResolvers<void>();

    // Execute and catch the error
    try {
      await uow.executeRetrieve();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Connection lost");
      errorResolver.resolve();
    }

    await errorResolver.promise;
  });

  it("should handle error in executeMutations() when coordination promise is never accessed", async () => {
    const executor = {
      executeRetrievalPhase: async () => [],
      executeMutationPhase: async () => {
        throw new Error("Transaction aborted");
      },
    };

    const uow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());
    uow.forSchema(testSchema).create("users", { name: "Alice", email: "alice@example.com" });

    // Don't access mutationPhase at all - this is the most common case
    // The internal coordination promise should not cause unhandled rejection
    const errorResolver = Promise.withResolvers<void>();
    // Execute and catch the error
    try {
      await uow.executeMutations();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Transaction aborted");
      errorResolver.resolve();
    }

    await errorResolver.promise;
  });

  it("should handle reset() after retrieval error", async () => {
    const executor = {
      executeRetrievalPhase: async () => {
        throw new Error("First attempt failed");
      },
      executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
    };

    const uow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());
    uow.forSchema(testSchema).find("users", (b) => b.whereIndex("primary"));

    // First attempt fails
    const errorResolver = Promise.withResolvers<void>();
    try {
      await uow.executeRetrieve();
    } catch (error) {
      expect((error as Error).message).toBe("First attempt failed");
      errorResolver.resolve();
    }

    // Reset the UOW
    uow.reset();

    // The UOW should be in a clean state
    expect(uow.state).toBe("building-retrieval");
    expect(uow.getRetrievalOperations()).toHaveLength(0);

    await errorResolver.promise;
  });

  it("should handle reset() after mutation error", async () => {
    const executor = {
      executeRetrievalPhase: async () => [],
      executeMutationPhase: async () => {
        throw new Error("First mutation failed");
      },
    };

    const uow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());
    uow.forSchema(testSchema).create("users", { name: "Alice", email: "alice@example.com" });

    // First attempt fails
    const errorResolver = Promise.withResolvers<void>();
    try {
      await uow.executeMutations();
    } catch (error) {
      expect((error as Error).message).toBe("First mutation failed");
      errorResolver.resolve();
    }

    // Reset the UOW
    uow.reset();

    // The UOW should be in a clean state
    expect(uow.state).toBe("building-retrieval");
    expect(uow.getMutationOperations()).toHaveLength(0);

    await errorResolver.promise;
  });

  it("should support standalone check() operation", () => {
    const uow = createUnitOfWork(createMockCompiler(), createMockExecutor(), createMockDecoder());
    const typedUow = uow.forSchema(testSchema);

    // Create a FragnoId for testing
    const userId = FragnoId.fromExternal("user-123", 5);

    typedUow.check("users", userId);

    const mutationOps = uow.getMutationOperations();
    expect(mutationOps).toHaveLength(1);

    const checkOp = mutationOps[0];
    assert(checkOp);
    assert(checkOp.type === "check");
    expect(checkOp.table).toBe("users");
    expect(checkOp.id).toBe(userId);
  });
});

describe("findFirst convenience method", () => {
  const testSchema = schema((s) =>
    s
      .addTable("users", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("name", "string")
          .addColumn("email", "string")
          .createIndex("idx_email", ["email"])
          .createIndex("idx_name", ["name"]),
      )
      .addTable("posts", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("userId", "string")
          .addColumn("title", "string")
          .createIndex("idx_user", ["userId"]),
      ),
  );

  it("should return a single result instead of an array", async () => {
    const executor = {
      executeRetrievalPhase: async () => {
        return [[{ id: "mock-id", name: "Mock User", email: "mock@example.com" }]];
      },
      executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
    };

    const uow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());

    // Use findFirst instead of find
    const typedUow = uow.forSchema(testSchema).findFirst("users", (b) => b.whereIndex("primary"));

    // Execute retrieval
    await uow.executeRetrieve();
    const results = await typedUow.retrievalPhase;

    // Result should be a single object, not an array
    const [user] = results;
    expect(user).toEqual({ id: "mock-id", name: "Mock User", email: "mock@example.com" });
    expect(Array.isArray(user)).toBe(false);
  });

  it("should return null when no results are found", async () => {
    // Create executor that returns empty results
    const emptyExecutor = {
      executeRetrievalPhase: async () => {
        return [[]]; // Empty array for no results
      },
      executeMutationPhase: async () => {
        return { success: true, createdInternalIds: [] };
      },
    };

    const uow = createUnitOfWork(createMockCompiler(), emptyExecutor, createMockDecoder());

    const typedUow = uow.forSchema(testSchema).findFirst("users", (b) => b.whereIndex("primary"));

    await uow.executeRetrieve();
    const results = await typedUow.retrievalPhase;
    const [user] = results;

    // Should be null when no results
    expect(user).toBeNull();
  });

  it("should automatically set pageSize to 1", () => {
    const uow = createUnitOfWork(createMockCompiler(), createMockExecutor(), createMockDecoder());

    uow.forSchema(testSchema).findFirst("users", (b) => b.whereIndex("primary"));

    // Check that pageSize was set to 1 in the operation
    const ops = uow.getRetrievalOperations();
    expect(ops).toHaveLength(1);
    expect(ops[0]?.type).toBe("find");
    if (ops[0]?.type === "find") {
      expect(ops[0].options.pageSize).toBe(1);
    }
  });

  it("should work with custom select clause", async () => {
    const executor = {
      executeRetrievalPhase: async () => {
        return [[{ id: "mock-id", name: "Mock User" }]];
      },
      executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
    };

    const uow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());

    const typedUow = uow
      .forSchema(testSchema)
      .findFirst("users", (b) => b.whereIndex("primary").select(["id", "name"] as const));

    await uow.executeRetrieve();
    const results = await typedUow.retrievalPhase;
    const [user] = results;

    expect(user).toBeDefined();
    expect(user).not.toBeNull();
    expect(user).toEqual({ id: "mock-id", name: "Mock User" });
  });

  it("should work with where conditions", async () => {
    const executor = {
      executeRetrievalPhase: async () => {
        return [[{ id: "mock-id", name: "Mock User", email: "test@example.com" }]];
      },
      executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
    };

    const uow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());

    const typedUow = uow
      .forSchema(testSchema)
      .findFirst("users", (b) =>
        b.whereIndex("idx_email", (eb) => eb("email", "=", "test@example.com")),
      );

    await uow.executeRetrieve();
    const results = await typedUow.retrievalPhase;
    const [user] = results;

    expect(user).toEqual({ id: "mock-id", name: "Mock User", email: "test@example.com" });
  });

  it("should handle multiple findFirst operations in the same UOW", async () => {
    const executor = {
      executeRetrievalPhase: async () => {
        return [
          [{ id: "user-1", name: "User 1", email: "user1@example.com" }],
          [{ id: "post-1", userId: "user-1", title: "Post 1" }],
        ];
      },
      executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
    };

    const uow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());

    const typedUow = uow
      .forSchema(testSchema)
      .findFirst("users", (b) => b.whereIndex("primary"))
      .findFirst("posts", (b) => b.whereIndex("primary"));

    await uow.executeRetrieve();
    const results = await typedUow.retrievalPhase;
    const [user, post] = results;

    // Both should be single objects, not arrays
    expect(user).toEqual({ id: "user-1", name: "User 1", email: "user1@example.com" });
    expect(post).toEqual({ id: "post-1", userId: "user-1", title: "Post 1" });
    expect(Array.isArray(user)).toBe(false);
    expect(Array.isArray(post)).toBe(false);
  });

  it("should handle mix of find and findFirst operations", async () => {
    const executor = {
      executeRetrievalPhase: async () => {
        return [
          [{ id: "user-1", name: "User 1", email: "user1@example.com" }],
          [
            { id: "post-1", userId: "user-1", title: "Post 1" },
            { id: "post-2", userId: "user-1", title: "Post 2" },
          ],
        ];
      },
      executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
    };

    const uow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());

    const typedUow = uow
      .forSchema(testSchema)
      .findFirst("users", (b) => b.whereIndex("primary")) // Single result
      .find("posts", (b) => b.whereIndex("primary")); // Array of results

    await uow.executeRetrieve();
    const results = await typedUow.retrievalPhase;
    const [user, posts] = results;

    // User should be a single object
    expect(user).toEqual({ id: "user-1", name: "User 1", email: "user1@example.com" });
    expect(Array.isArray(user)).toBe(false);

    // Posts should be an array
    expect(Array.isArray(posts)).toBe(true);
    expect(posts).toHaveLength(2);
  });

  it("should work with orderByIndex", async () => {
    const executor = {
      executeRetrievalPhase: async () => {
        return [[{ id: "user-1", name: "Alice", email: "alice@example.com" }]];
      },
      executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
    };

    const uow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());

    const typedUow = uow
      .forSchema(testSchema)
      .findFirst("users", (b) => b.whereIndex("idx_name").orderByIndex("idx_name", "asc"));

    await uow.executeRetrieve();
    const results = await typedUow.retrievalPhase;
    const [user] = results;

    expect(user).toEqual({ id: "user-1", name: "Alice", email: "alice@example.com" });
    expect(Array.isArray(user)).toBe(false);
  });

  it("should work without explicit builder function", async () => {
    const executor = {
      executeRetrievalPhase: async () => {
        return [[{ id: "user-1", name: "User 1", email: "user1@example.com" }]];
      },
      executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
    };

    const uow = createUnitOfWork(createMockCompiler(), executor, createMockDecoder());

    // findFirst without builder function should use primary index by default
    const typedUow = uow.forSchema(testSchema).findFirst("users");

    await uow.executeRetrieve();
    const results = await typedUow.retrievalPhase;
    const [user] = results;

    expect(user).toEqual({ id: "user-1", name: "User 1", email: "user1@example.com" });
    expect(Array.isArray(user)).toBe(false);

    // Verify the operation used the primary index
    const ops = uow.getRetrievalOperations();
    expect(ops[0]?.indexName).toBe("_primary");
  });
});
