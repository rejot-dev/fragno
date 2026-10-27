import { describe, expect, expectTypeOf, it, assert } from "vitest";

import type {
  RawColumnValues,
  TableToColumnValues,
  TableToInsertValues,
  TableToUpdateValues,
} from "../query/mod";
import {
  column,
  FragnoId,
  FragnoReference,
  getTableForeignKey,
  getTableForeignKeys,
  getTableRelations,
  idColumn,
  referenceColumn,
  schema,
  SchemaBuilder,
  type FragnoReferenceTo,
} from "./create";

describe("create", () => {
  it("allows string columns in indexes and rejects text columns", () => {
    expect(() =>
      schema("indexed_strings", (s) =>
        s.addTable("users", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("email", column("string"))
            .createIndex("users_email_idx", ["email"]),
        ),
      ),
    ).not.toThrow();

    expect(() =>
      schema("indexed_text", (s) =>
        s.addTable("posts", (t) =>
          t
            .addColumn("id", idColumn())
            .addColumn("body", column("text"))
            .createIndex("posts_body_idx", ["body"]),
        ),
      ),
    ).toThrow(
      'Index "posts_body_idx" references non-indexable column "body" of type "text". Use column("string") for indexed strings.',
    );
  });

  it("should create a table with columns using callback pattern", () => {
    const userSchema = schema("user", (s) => {
      return s.addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("email", column("string"))
          .createIndex("unique_email", ["email"], { unique: true })
          .addColumn("age", column("integer").nullable());
      });
    });

    const userTable = userSchema.tables.users;
    expect(userTable.columns.id).toBeDefined();
    expect(userTable.columns.name).toBeDefined();
    expect(userTable.columns.email).toBeDefined();
    expect(userTable.columns.age).toBeDefined();
    assert(userTable.columns.age.isNullable);

    // Verify the index was stored as a sub-operation
    const addTableOps = userSchema.operations.filter((op) => op.type === "add-table");
    expect(addTableOps).toHaveLength(1);
    const indexOps = addTableOps[0].operations.filter((op) => op.type === "add-index");
    expect(indexOps).toHaveLength(1);
    assert(indexOps[0].name === "unique_email");
    expect(indexOps[0].columns).toEqual(["email"]);
    assert(indexOps[0].unique);
  });

  it("should create a schema with multiple tables using callback pattern", () => {
    const userSchema = schema("user", (s) => {
      return s
        .addTable("users", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        })
        .addTable("posts", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("title", column("string"))
            .addColumn("content", column("text"));
        });
    });

    assert(userSchema.version === 2); // Two addTable calls
    expect(userSchema.tables.users).toBeDefined();
    expect(userSchema.tables.posts).toBeDefined();
    assert(userSchema.tables.users.name === "users");
    assert(userSchema.tables.posts.name === "posts");
  });

  it("should generate default values for columns", () => {
    const testSchema = schema("test", (s) => {
      return s.addTable("test", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo$((b) => b.now()),
          )
          .addColumn("status", column("string").defaultTo("active"));
      });
    });

    const testTable = testSchema.tables.test;
    const idValue = testTable.columns.id.generateDefaultValue();
    assert(typeof idValue === "string");
    expect(idValue?.length).toBeGreaterThan(0);

    const createdAtValue = testTable.columns.createdAt.generateDefaultValue();
    expect(createdAtValue).toBeInstanceOf(Date);

    const statusValue = testTable.columns.status.generateDefaultValue();
    expect(statusValue).toBe("active");
  });

  it("should increment schema version on each schema-level operation", () => {
    const userSchema = schema("user", (s) => {
      return s
        .addTable("users", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("name", column("string"))
            .addColumn("age", column("integer"));
        })
        .addTable("posts", (t) => {
          return t.addColumn("id", idColumn());
        });
    });

    assert(userSchema.version === 2); // Two addTable calls
  });

  it("should support unique constraints on tables via unique method", () => {
    const userSchema = schema("user", (s) => {
      return s.addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("email", column("string"))
          .addColumn("username", column("string"))
          .createIndex("unique_email_username", ["email", "username"], { unique: true });
      });
    });

    // Verify the unique index was stored as a sub-operation
    const addTableOps = userSchema.operations.filter((op) => op.type === "add-table");
    expect(addTableOps).toHaveLength(1);
    const indexOps = addTableOps[0].operations.filter((op) => op.type === "add-index");
    expect(indexOps).toHaveLength(1);
    assert(indexOps[0].name === "unique_email_username");
    expect(indexOps[0].columns).toEqual(["email", "username"]);
    assert(indexOps[0].unique);
  });

  it("should support creating indexes on tables", () => {
    const userSchema = schema("user", (s) => {
      return s.addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("email", column("string"))
          .addColumn("username", column("string"))
          .createIndex("idx_email", ["email"])
          .createIndex("idx_username_unique", ["username"], { unique: true });
      });
    });

    // Verify both indexes were stored as sub-operations
    const addTableOps = userSchema.operations.filter((op) => op.type === "add-table");
    expect(addTableOps).toHaveLength(1);
    const indexOps = addTableOps[0].operations.filter((op) => op.type === "add-index");
    expect(indexOps).toHaveLength(2);

    const emailIndex = indexOps.find((op) => op.name === "idx_email");
    expect(emailIndex).toBeDefined();
    expect(emailIndex!.columns).toEqual(["email"]);
    assert(!emailIndex!.unique);

    const usernameIndex = indexOps.find((op) => op.name === "idx_username_unique");
    expect(usernameIndex).toBeDefined();
    expect(usernameIndex!.columns).toEqual(["username"]);
    assert(usernameIndex!.unique);
  });

  it("should throw on duplicate table names", () => {
    expect(() =>
      schema("dup", (s) => {
        return s
          .addTable("users", (t) => {
            return t.addColumn("id", idColumn());
          })
          .addTable("users", (t) => {
            return t.addColumn("id", idColumn());
          });
      }),
    ).toThrow(/Duplicate table name "users"/);
  });

  it("should throw on duplicate index names across tables", () => {
    expect(() =>
      schema("dup", (s) => {
        return s
          .addTable("users", (t) => {
            return t.addColumn("id", idColumn()).createIndex("idx_shared", ["id"]);
          })
          .addTable("posts", (t) => {
            return t.addColumn("id", idColumn()).createIndex("idx_shared", ["id"]);
          });
      }),
    ).toThrow(/Duplicate index name "idx_shared"/);
  });

  it("should throw on duplicate index names added via alterTable", () => {
    expect(() =>
      schema("dup", (s) => {
        return s
          .addTable("users", (t) => {
            return t.addColumn("id", idColumn()).createIndex("idx_email", ["id"]);
          })
          .addTable("posts", (t) => {
            return t.addColumn("id", idColumn());
          })
          .alterTable("posts", (t) => {
            return t.createIndex("idx_email", ["id"]);
          });
      }),
    ).toThrow(/Duplicate index name "idx_email"/);
  });

  it("should demonstrate manual many-to-many relation setup", () => {
    const userSchema = schema("user", (s) => {
      return s
        .addTable("users", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        })
        .addTable("tags", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        })
        .addTable("user_tags", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("userId", referenceColumn({ table: "users" }))
            .addColumn("tagId", referenceColumn({ table: "tags" }));
        });
    });

    const junctionTable = userSchema.tables.user_tags;
    const relations = getTableRelations(junctionTable);
    const foreignKeys = getTableForeignKeys(junctionTable);

    expect(relations["user"]).toBeDefined();
    expect(relations["tag"]).toBeDefined();
    expect(foreignKeys["userId"]?.referencedTable).toBe(userSchema.tables.users);
    expect(foreignKeys["tagId"]?.referencedTable).toBe(userSchema.tables.tags);

    const addTableOp = userSchema.operations.find(
      (op): op is Extract<(typeof userSchema.operations)[number], { type: "add-table" }> =>
        op.type === "add-table" && op.tableName === "user_tags",
    );
    expect(addTableOp).toBeDefined();
    expect(addTableOp?.operations.filter((op) => op.type === "add-foreign-key")).toHaveLength(2);
  });

  it("should derive foreign key metadata from reference columns", () => {
    const userSchema = schema("user", (s) => {
      return s
        .addTable("users", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        })
        .addTable("posts", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("title", column("string"))
            .addColumn("authorId", referenceColumn({ table: "users" }));
        });
    });

    const postsTable = userSchema.tables.posts;
    const authorRelation = getTableRelations(postsTable)["author"];
    const authorForeignKey = getTableForeignKey(postsTable, "authorId");

    assert(postsTable.columns.authorId.role === "reference");
    expect(authorRelation).toBeDefined();
    assert(authorRelation?.type === "one");
    expect(authorRelation?.table).toBe(userSchema.tables.users);
    expect(authorRelation?.on).toEqual([["authorId", "id"]]);
    expect(authorForeignKey?.referencedTable).toBe(userSchema.tables.users);
    assert(authorForeignKey?.referencedColumnName === "_internalId");
  });

  it("should target referenced internal ids for foreign keys", () => {
    const catalogSchema = schema("catalog", (s) => {
      return s
        .addTable("products", (t) => {
          return t.addColumn("productId", idColumn()).addColumn("name", column("string"));
        })
        .addTable("orders", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("productRef", referenceColumn({ table: "products" }));
        });
    });

    const productRef = getTableForeignKey(catalogSchema.tables.orders, "productRef");
    expect(productRef?.referencedTable).toBe(catalogSchema.tables.products);
    assert(productRef?.referencedColumnName === "_internalId");
  });

  it("should support multiple reference columns in one table", () => {
    const userSchema = schema("user", (s) => {
      return s
        .addTable("users", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        })
        .addTable("categories", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        })
        .addTable("posts", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("title", column("string"))
            .addColumn("authorId", referenceColumn({ table: "users" }))
            .addColumn("categoryId", referenceColumn({ table: "categories" }));
        });
    });

    const postsTable = userSchema.tables.posts;
    const relations = getTableRelations(postsTable);

    expect(relations["author"]).toBeDefined();
    expect(relations["category"]).toBeDefined();
    expect(getTableForeignKey(postsTable, "authorId")?.referencedTable).toBe(
      userSchema.tables.users,
    );
    expect(getTableForeignKey(postsTable, "categoryId")?.referencedTable).toBe(
      userSchema.tables.categories,
    );
  });

  it("should support self-referencing foreign keys", () => {
    const userSchema = schema("user", (s) => {
      return s.addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("invitedBy", referenceColumn({ table: "users" }).nullable());
      });
    });

    const usersTable = userSchema.tables.users;
    const inviterRelation = getTableRelations(usersTable)["invitedBy"];
    const inviterForeignKey = getTableForeignKey(usersTable, "invitedBy");

    expect(inviterRelation).toBeDefined();
    assert(inviterRelation?.type === "one");
    expect(inviterRelation?.table).toBe(usersTable);
    expect(inviterRelation?.on).toEqual([["invitedBy", "id"]]);
    expect(inviterForeignKey?.referencedTable).toBe(usersTable);
  });

  it("should allow altering an existing table to add columns", () => {
    const userSchema = schema("user", (s) => {
      return s
        .addTable("users", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        })
        .alterTable("users", (t) => {
          return t
            .addColumn("email", column("string"))
            .addColumn("age", column("integer").nullable());
        });
    });

    const usersTable = userSchema.tables.users;

    // Verify the original columns exist
    expect(usersTable.columns.id).toBeDefined();
    expect(usersTable.columns.name).toBeDefined();

    // Verify the new columns were added
    expect(usersTable.columns.email).toBeDefined();
    expect(usersTable.columns.age).toBeDefined();
    assert(usersTable.columns.age.isNullable);

    // Verify the operations were recorded
    const alterTableOps = userSchema.operations.filter((op) => op.type === "alter-table");
    expect(alterTableOps).toHaveLength(1);
    expect(alterTableOps[0].operations).toHaveLength(2);
    assert(alterTableOps[0].operations[0].type === "add-column");
    assert(alterTableOps[0].operations[1].type === "add-column");
    if (alterTableOps[0].operations[0].type === "add-column") {
      assert(alterTableOps[0].operations[0].columnName === "email");
    }
    if (alterTableOps[0].operations[1].type === "add-column") {
      assert(alterTableOps[0].operations[1].columnName === "age");
    }

    // Version should be: 1 (addTable) + 1 (alter-table with 2 columns)
    assert(userSchema.version === 2);
  });

  it("should allow altering an existing table to add indexes", () => {
    const userSchema = schema("user", (s) => {
      return s
        .addTable("users", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("name", column("string"))
            .addColumn("email", column("string"));
        })
        .alterTable("users", (t) => {
          return t
            .createIndex("idx_email", ["email"])
            .createIndex("idx_name_unique", ["name"], { unique: true });
        });
    });

    const alterTableOps = userSchema.operations.filter((op) => op.type === "alter-table");
    expect(alterTableOps).toHaveLength(1);
    const indexOps = alterTableOps[0].operations.filter((op) => op.type === "add-index");
    expect(indexOps).toHaveLength(2);

    // Version should be: 1 (addTable) + 1 (alter-table with indexes as sub-operations)
    assert(userSchema.version === 2);
  });

  it("should allow multiple alterTable calls on the same table", () => {
    const userSchema = schema("user", (s) => {
      return s
        .addTable("users", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        })
        .alterTable("users", (t) => {
          return t.addColumn("email", column("string"));
        })
        .alterTable("users", (t) => {
          return t.addColumn("age", column("integer").nullable());
        });
    });

    const usersTable = userSchema.tables.users;
    const columns = usersTable.columns;

    expectTypeOf(columns.id.$in).toExtend<string | FragnoId | null>();
    expectTypeOf(columns.id.$out).toEqualTypeOf<FragnoId>();

    expectTypeOf(columns.name.$in).toBeString();
    expectTypeOf(columns.name.$out).toBeString();

    expectTypeOf(columns.email.$in).toBeString();
    expectTypeOf(columns.email.$out).toBeString();

    expectTypeOf(columns.age.$in).toExtend<number | null>();
    expectTypeOf(columns.age.$out).toExtend<number | null>();

    // Verify all columns exist
    expect(usersTable.columns.id).toBeDefined();
    expect(usersTable.columns.name).toBeDefined();
    expect(usersTable.columns.email).toBeDefined();
    expect(usersTable.columns.age).toBeDefined();

    // Version should be: 1 (addTable) + 1 (first alter) + 1 (second alter)
    assert(userSchema.version === 3);
  });

  it("should preserve user-defined columns after alterTable type updates", () => {
    const userSchema = schema("user", (s) => {
      return s
        .addTable("users", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("email", column("string"))
            .addColumn("passwordHash", column("string"));
        })
        .alterTable("users", (t) => {
          expectTypeOf(t.alterColumn).parameter(0).toEqualTypeOf<"email" | "passwordHash">();
          return t.alterColumn("passwordHash").nullable();
        });
    });

    type UserColumns = typeof userSchema.tables.users.columns;
    type UserColumnKeys = keyof UserColumns;

    expectTypeOf<UserColumnKeys>().not.toEqualTypeOf<string>();
    expectTypeOf<UserColumnKeys>().toEqualTypeOf<"id" | "email" | "passwordHash">();

    type UpdateValues = TableToUpdateValues<typeof userSchema.tables.users>;
    expectTypeOf<UpdateValues>().toMatchObjectType<{
      email?: string;
      passwordHash?: string | null;
    }>();
  });

  it("should preserve indexes when altering a table", () => {
    const userSchema = schema("user", (s) => {
      return s
        .addTable("users", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("name", column("string"))
            .addColumn("email", column("string"))
            .createIndex("idx_email", ["email"])
            .createIndex("idx_name_unique", ["name"], { unique: true });
        })
        .alterTable("users", (t) => {
          return t.addColumn("age", column("integer").nullable());
        });
    });

    const usersTable = userSchema.tables.users;

    // Verify the new column was added
    expect(usersTable.columns.age).toBeDefined();

    // Verify the original indexes are still present in the table
    expect(usersTable.indexes["idx_email"]).toBeDefined();
    expect(usersTable.indexes["idx_email"].columnNames).toEqual(["email"]);
    assert(!usersTable.indexes["idx_email"].unique);

    expect(usersTable.indexes["idx_name_unique"]).toBeDefined();
    expect(usersTable.indexes["idx_name_unique"].columnNames).toEqual(["name"]);
    assert(usersTable.indexes["idx_name_unique"].unique);
  });

  it("should not duplicate existing indexes when altering a table", () => {
    const userSchema = schema("user", (s) => {
      return s
        .addTable("users", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("name", column("string"))
            .addColumn("email", column("string"))
            .createIndex("idx_email", ["email"])
            .createIndex("idx_name_unique", ["name"], { unique: true });
        })
        .alterTable("users", (t) => {
          return t.addColumn("age", column("integer").nullable());
        });
    });

    // Verify the add-table operation contains both indexes
    const addTableOps = userSchema.operations.filter((op) => op.type === "add-table");
    expect(addTableOps).toHaveLength(1);
    const addTableIndexOps = addTableOps[0].operations.filter((op) => op.type === "add-index");
    expect(addTableIndexOps).toHaveLength(2);

    // Verify the alter-table operation does NOT contain the existing indexes
    const alterTableOps = userSchema.operations.filter((op) => op.type === "alter-table");
    expect(alterTableOps).toHaveLength(1);
    const alterTableIndexOps = alterTableOps[0].operations.filter((op) => op.type === "add-index");
    expect(alterTableIndexOps).toHaveLength(0); // Should be 0, not 2

    // The alter-table should only have the new column
    const alterTableColumnOps = alterTableOps[0].operations.filter(
      (op) => op.type === "add-column",
    );
    expect(alterTableColumnOps).toHaveLength(1);
    if (alterTableColumnOps[0].type === "add-column") {
      assert(alterTableColumnOps[0].columnName === "age");
    }
  });

  it("should only add new indexes when altering a table with additional indexes", () => {
    const userSchema = schema("user", (s) => {
      return s
        .addTable("users", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("name", column("string"))
            .addColumn("email", column("string"))
            .createIndex("idx_email", ["email"]);
        })
        .alterTable("users", (t) => {
          return t
            .addColumn("age", column("integer").nullable())
            .createIndex("idx_name", ["name"]) // New index
            .createIndex("idx_age", ["age"]); // New index on new column
        });
    });

    // Verify the add-table operation contains only the original index
    const addTableOps = userSchema.operations.filter((op) => op.type === "add-table");
    expect(addTableOps).toHaveLength(1);
    const addTableIndexOps = addTableOps[0].operations.filter((op) => op.type === "add-index");
    expect(addTableIndexOps).toHaveLength(1);
    assert(addTableIndexOps[0].name === "idx_email");

    // Verify the alter-table operation contains only the NEW indexes
    const alterTableOps = userSchema.operations.filter((op) => op.type === "alter-table");
    expect(alterTableOps).toHaveLength(1);
    const alterTableIndexOps = alterTableOps[0].operations.filter((op) => op.type === "add-index");
    expect(alterTableIndexOps).toHaveLength(2); // Only the two new indexes

    const indexNames = alterTableIndexOps.map((op) => op.name);
    expect(indexNames).toContain("idx_name");
    expect(indexNames).toContain("idx_age");
    expect(indexNames).not.toContain("idx_email"); // Should not duplicate the original index

    // Verify all three indexes are present in the final table structure
    const usersTable = userSchema.tables.users;
    expect(Object.keys(usersTable.indexes)).toHaveLength(3);
    expect(usersTable.indexes["idx_email"]).toBeDefined();
    expect(usersTable.indexes["idx_name"]).toBeDefined();
    expect(usersTable.indexes["idx_age"]).toBeDefined();
  });

  it("Simple user table types", () => {
    const _userSchema = schema("_user", (s) => {
      return s.addTable("users", (t) => {
        return t.addColumn("id", idColumn()).addColumn("name", column("string"));
      });
    });

    type _UserInsert = TableToInsertValues<typeof _userSchema.tables.users>;
    expectTypeOf<_UserInsert>().toExtend<{
      [x: string]: unknown;
      id?: string | FragnoId | null;
      name: string;
    }>();

    type _UserResult = TableToColumnValues<typeof _userSchema.tables.users>;
    expectTypeOf<_UserResult>().toExtend<{
      id: FragnoId;
      name: string;
    }>();

    type _RawUser = RawColumnValues<typeof _userSchema.tables.users>;
    expectTypeOf<_RawUser>().toEqualTypeOf<{
      id: FragnoId;
      name: string;
    }>();
  });

  it("Simple user table types after alter table statements", () => {
    const _userSchema = schema("_user", (s) => {
      return s
        .addTable("users", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        })
        .addTable("emails", (t) => {
          return t.addColumn("id", idColumn()).addColumn("email", column("string"));
        })
        .alterTable("emails", (t) => {
          return t.addColumn("is_primary", column("bool").defaultTo(false));
        });
    });

    type _UserInsert = TableToInsertValues<typeof _userSchema.tables.users>;
    expectTypeOf<_UserInsert>().toEqualTypeOf<{
      id?: string | FragnoId | null | undefined;
      name: string;
    }>();

    type _UserResult = TableToColumnValues<typeof _userSchema.tables.users>;
    expectTypeOf<_UserResult>().toEqualTypeOf<{
      id: FragnoId;
      name: string;
    }>();
  });
});

describe("renameColumn and dropIndex", () => {
  const evolving = schema("evolving", (s) =>
    s
      .addTable("installation", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("organizationId", column("string"))
          .addColumn("note", column("string").nullable())
          .createIndex("idx_org", ["organizationId", "id"])
          .createIndex("idx_note", ["note"]),
      )
      .alterTable("installation", (t) =>
        t
          .renameColumn("organizationId", "ownerId")
          .dropIndex("idx_note")
          .createIndex("idx_note", ["ownerId", "note"], { unique: true }),
      ),
  );

  it("types the table by the new names, including in the indexes that cover a renamed column", () => {
    expectTypeOf<TableToColumnValues<typeof evolving.tables.installation>>().toEqualTypeOf<{
      id: FragnoId;
      ownerId: string;
      note: string | null;
    }>();
    expectTypeOf<
      (typeof evolving.tables.installation.indexes.idx_org.columnNames)[number]
    >().toEqualTypeOf<"ownerId" | "id">();
    expect(evolving.tables.installation.indexes.idx_org.columnNames).toEqual(["ownerId", "id"]);
    expect(evolving.tables.installation.indexes.idx_note).toMatchObject({
      columnNames: ["ownerId", "note"],
      unique: true,
    });
    // One version for the whole change, with renames and drops before what depends on them.
    assert(evolving.version === 2);
    expect(evolving.operations[1]).toMatchObject({
      type: "alter-table",
      operations: [
        { type: "rename-column", from: "organizationId", to: "ownerId" },
        { type: "drop-index", name: "idx_note", unique: false },
        { type: "add-index", name: "idx_note", columns: ["ownerId", "note"], unique: true },
      ],
    });
  });

  it("refuses changes that do not apply to columns and indexes of an existing table", () => {
    const base = () =>
      new SchemaBuilder("refusals").addTable("item", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("label", column("string"))
          .addColumn("parentId", referenceColumn({ table: "item" }).nullable())
          .createIndex("idx_name", ["name"]),
      );

    expect(() =>
      base().alterTable("item", (t) =>
        // @ts-expect-error A column cannot take the name of another.
        t.renameColumn("name", "label"),
      ),
    ).toThrow("Column item.label already exists.");
    expect(() =>
      base().alterTable("item", (t) =>
        // @ts-expect-error ID columns keep their names.
        t.renameColumn("id", "key"),
      ),
    ).toThrow("only regular columns can");
    expect(() => base().alterTable("item", (t) => t.renameColumn("parentId", "ownerId"))).toThrow(
      "only regular columns can",
    );
    expect(() =>
      base().alterTable("item", (t) =>
        t.addColumn("added", column("string").nullable()).renameColumn("added", "renamed"),
      ),
    ).toThrow("only columns of an existing table can be renamed");
    expect(() =>
      base().alterTable("item", (t) =>
        t.createIndex("idx_label", ["label"]).dropIndex("idx_label"),
      ),
    ).toThrow("only indexes of an existing table can be dropped");
    expect(() =>
      new SchemaBuilder("added").addTable("item", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .renameColumn("name", "title"),
      ),
    ).toThrow("only columns of an existing table can be renamed");
  });
});

describe("idColumn", () => {
  it("should create a table with an id column", () => {
    const idCol = idColumn();
    type _In = typeof idCol.$in;
    type _Out = typeof idCol.$out;
    expectTypeOf<_In>().toEqualTypeOf<string | FragnoId | null>();
    expectTypeOf<_Out>().toEqualTypeOf<FragnoId>();

    expect(idCol.generateDefaultValue()).toBeDefined();
  });
});

describe("referenceColumn", () => {
  it("should create a table with a reference column", () => {
    const _referenceCol = referenceColumn({ table: "users" });
    type _In = typeof _referenceCol.$in;
    type _Out = typeof _referenceCol.$out;
    expectTypeOf<_In>().toEqualTypeOf<string | bigint | FragnoId | FragnoReference>();
    expectTypeOf<_Out>().toEqualTypeOf<FragnoReferenceTo<"users">>();
    expectTypeOf<_Out>().toExtend<FragnoReference>();
  });
});

describe("SchemaBuilder with existing schema", () => {
  it("should initialize with an existing schema", () => {
    const existingSchema = schema("existing", (s) => {
      return s.addTable("users", (t) => {
        return t.addColumn("id", idColumn()).addColumn("name", column("string"));
      });
    });

    const extendedSchema = new SchemaBuilder(existingSchema.name, existingSchema)
      .addTable("posts", (t) => {
        return t.addColumn("id", idColumn()).addColumn("title", column("string"));
      })
      .build();

    expect(extendedSchema.tables.users).toBeDefined();
    expect(extendedSchema.tables.posts).toBeDefined();
    assert(extendedSchema.version === 2); // 1 from original + 1 from new table
    expect(extendedSchema.operations).toHaveLength(2);
  });

  it("should preserve operations from existing schema", () => {
    const existingSchema = schema("existing", (s) => {
      return s
        .addTable("users", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        })
        .addTable("posts", (t) => {
          return t.addColumn("id", idColumn()).addColumn("title", column("string"));
        });
    });

    const extendedSchema = new SchemaBuilder(existingSchema.name, existingSchema)
      .addTable("comments", (t) => {
        return t.addColumn("id", idColumn()).addColumn("text", column("text"));
      })
      .build();

    const addTableOps = extendedSchema.operations.filter(
      (op): op is Extract<(typeof extendedSchema.operations)[number], { type: "add-table" }> =>
        op.type === "add-table",
    );

    expect(addTableOps).toHaveLength(3);
    assert(addTableOps[0]?.tableName === "users");
    assert(addTableOps[1]?.tableName === "posts");
    assert(addTableOps[2]?.tableName === "comments");
  });
});
