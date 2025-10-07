import { describe, expect, expectTypeOf, it } from "vitest";
import { column, idColumn, referenceColumn, schema } from "./create";

describe("create", () => {
  it("should create a table with columns using callback pattern", () => {
    const userSchema = schema((s) => {
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
    expect(userTable.columns.age.isNullable).toBe(true);

    // Verify the index was stored as a sub-operation
    const addTableOps = userSchema.operations.filter((op) => op.type === "add-table");
    expect(addTableOps).toHaveLength(1);
    const indexOps = addTableOps[0].operations.filter((op) => op.type === "add-index");
    expect(indexOps).toHaveLength(1);
    expect(indexOps[0].name).toBe("unique_email");
    expect(indexOps[0].columns).toEqual(["email"]);
    expect(indexOps[0].unique).toBe(true);
  });

  it("should create a schema with multiple tables using callback pattern", () => {
    const userSchema = schema((s) => {
      return s
        .addTable("users", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        })
        .addTable("posts", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("title", column("string"))
            .addColumn("content", column("string"));
        });
    });

    expect(userSchema.version).toBe(2); // Two addTable calls
    expect(userSchema.tables.users).toBeDefined();
    expect(userSchema.tables.posts).toBeDefined();
    expect(userSchema.tables.users.ormName).toBe("users");
    expect(userSchema.tables.posts.ormName).toBe("posts");
  });

  it("should generate default values for columns", () => {
    const testSchema = schema((s) => {
      return s.addTable("test", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("createdAt", column("timestamp").defaultTo$("now"))
          .addColumn("status", column("string").defaultTo("active"));
      });
    });

    const testTable = testSchema.tables.test;
    const idValue = testTable.columns.id.generateDefaultValue();
    expect(typeof idValue).toBe("string");
    expect(idValue?.length).toBeGreaterThan(0);

    const createdAtValue = testTable.columns.createdAt.generateDefaultValue();
    expect(createdAtValue).toBeInstanceOf(Date);

    const statusValue = testTable.columns.status.generateDefaultValue();
    expect(statusValue).toBe("active");
  });

  it("should increment schema version on each schema-level operation", () => {
    const userSchema = schema((s) => {
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

    expect(userSchema.version).toBe(2); // Two addTable calls
  });

  it("should support unique constraints on tables via unique method", () => {
    const userSchema = schema((s) => {
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
    expect(indexOps[0].name).toBe("unique_email_username");
    expect(indexOps[0].columns).toEqual(["email", "username"]);
    expect(indexOps[0].unique).toBe(true);
  });

  it("should support creating indexes on tables", () => {
    const userSchema = schema((s) => {
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
    expect(emailIndex!.unique).toBe(false);

    const usernameIndex = indexOps.find((op) => op.name === "idx_username_unique");
    expect(usernameIndex).toBeDefined();
    expect(usernameIndex!.columns).toEqual(["username"]);
    expect(usernameIndex!.unique).toBe(true);
  });

  it("should demonstrate manual many-to-many relation setup", () => {
    // For many-to-many, create a junction table manually
    const userSchema = schema((s) => {
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
            .addColumn("userId", referenceColumn())
            .addColumn("tagId", referenceColumn());
        })
        .addReference("user_tags", "user", {
          columns: ["userId"],
          targetTable: "users",
          targetColumns: ["id"],
        })
        .addReference("user_tags", "tag", {
          columns: ["tagId"],
          targetTable: "tags",
          targetColumns: ["id"],
        });
    });

    const junctionTable = userSchema.tables.user_tags;

    // Verify the junction table has both relations
    expect(junctionTable.relations["user"]).toBeDefined();
    expect(junctionTable.relations["tag"]).toBeDefined();

    // Verify both foreign keys were created as operations
    const addReferenceOps = userSchema.operations.filter((op) => op.type === "add-reference");
    expect(addReferenceOps).toHaveLength(2);

    const userRef = addReferenceOps.find((op) => op.referenceName === "user");
    expect(userRef).toBeDefined();
    expect(userRef!.tableName).toBe("user_tags");
    expect(userRef!.config.columns).toEqual(["userId"]);
    expect(userRef!.config.targetTable).toBe("users");
    expect(userRef!.config.targetColumns).toEqual(["id"]);

    const tagRef = addReferenceOps.find((op) => op.referenceName === "tag");
    expect(tagRef).toBeDefined();
    expect(tagRef!.tableName).toBe("user_tags");
    expect(tagRef!.config.columns).toEqual(["tagId"]);
    expect(tagRef!.config.targetTable).toBe("tags");
    expect(tagRef!.config.targetColumns).toEqual(["id"]);
  });

  it("should create a foreign key reference using addReference", () => {
    const userSchema = schema((s) => {
      return s
        .addTable("users", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        })
        .addTable("posts", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("title", column("string"))
            .addColumn("authorId", referenceColumn());
        })
        .addReference("posts", "author", {
          columns: ["authorId"],
          targetTable: "users",
          targetColumns: ["id"],
        });
    });

    const postsTable = userSchema.tables.posts;

    // Verify the authorId column is marked as a reference
    expect(postsTable.columns.authorId.role).toBe("reference");

    // Verify the relation exists
    const authorRelation = postsTable.relations["author"];
    expect(authorRelation).toBeDefined();
    expect(authorRelation.type).toBe("one");
    expect(authorRelation.table).toBe(userSchema.tables.users);
    expect(authorRelation.on).toEqual([["authorId", "id"]]);

    // Verify the foreign key was created as an operation
    const addReferenceOps = userSchema.operations.filter((op) => op.type === "add-reference");
    expect(addReferenceOps).toHaveLength(1);
    expect(addReferenceOps[0].tableName).toBe("posts");
    expect(addReferenceOps[0].referenceName).toBe("author");
    expect(addReferenceOps[0].config.columns).toEqual(["authorId"]);
    expect(addReferenceOps[0].config.targetTable).toBe("users");
    expect(addReferenceOps[0].config.targetColumns).toEqual(["id"]);
  });

  it("should support multiple references by calling addReference multiple times", () => {
    const userSchema = schema((s) => {
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
            .addColumn("authorId", referenceColumn())
            .addColumn("categoryId", referenceColumn());
        })
        .addReference("posts", "author", {
          columns: ["authorId"],
          targetTable: "users",
          targetColumns: ["id"],
        })
        .addReference("posts", "category", {
          columns: ["categoryId"],
          targetTable: "categories",
          targetColumns: ["id"],
        });
    });

    const postsTable = userSchema.tables.posts;

    // Verify both relations exist
    expect(postsTable.relations["author"]).toBeDefined();
    expect(postsTable.relations["category"]).toBeDefined();

    // Verify both foreign keys were created as operations
    const addReferenceOps = userSchema.operations.filter((op) => op.type === "add-reference");
    expect(addReferenceOps).toHaveLength(2);

    const authorRef = addReferenceOps.find((op) => op.referenceName === "author");
    expect(authorRef).toBeDefined();
    expect(authorRef!.tableName).toBe("posts");
    expect(authorRef!.config.columns).toEqual(["authorId"]);
    expect(authorRef!.config.targetTable).toBe("users");
    expect(authorRef!.config.targetColumns).toEqual(["id"]);

    const categoryRef = addReferenceOps.find((op) => op.referenceName === "category");
    expect(categoryRef).toBeDefined();
    expect(categoryRef!.tableName).toBe("posts");
    expect(categoryRef!.config.columns).toEqual(["categoryId"]);
    expect(categoryRef!.config.targetTable).toBe("categories");
    expect(categoryRef!.config.targetColumns).toEqual(["id"]);
  });

  it("should support self-referencing foreign keys", () => {
    const userSchema = schema((s) => {
      return s
        .addTable("users", (t) => {
          return t
            .addColumn("id", idColumn())
            .addColumn("name", column("string"))
            .addColumn("invitedBy", referenceColumn().nullable());
        })
        .addReference("users", "inviter", {
          columns: ["invitedBy"],
          targetTable: "users",
          targetColumns: ["id"],
        });
    });

    const usersTable = userSchema.tables.users;

    // Verify the self-referencing relation exists
    const inviterRelation = usersTable.relations["inviter"];
    expect(inviterRelation).toBeDefined();
    expect(inviterRelation.type).toBe("one");
    expect(inviterRelation.table).toBe(usersTable);
    expect(inviterRelation.on).toEqual([["invitedBy", "id"]]);

    // Verify the foreign key was created as an operation
    const addReferenceOps = userSchema.operations.filter((op) => op.type === "add-reference");
    expect(addReferenceOps).toHaveLength(1);
    expect(addReferenceOps[0].tableName).toBe("users");
    expect(addReferenceOps[0].referenceName).toBe("inviter");
    expect(addReferenceOps[0].config.columns).toEqual(["invitedBy"]);
    expect(addReferenceOps[0].config.targetTable).toBe("users");
    expect(addReferenceOps[0].config.targetColumns).toEqual(["id"]);
  });

  it("should allow altering an existing table to add columns", () => {
    const userSchema = schema((s) => {
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
    expect(usersTable.columns.age.isNullable).toBe(true);

    // Verify the operations were recorded
    const alterTableOps = userSchema.operations.filter((op) => op.type === "alter-table");
    expect(alterTableOps).toHaveLength(1);
    expect(alterTableOps[0].operations).toHaveLength(2);
    expect(alterTableOps[0].operations[0].type).toBe("add-column");
    expect(alterTableOps[0].operations[1].type).toBe("add-column");
    if (alterTableOps[0].operations[0].type === "add-column") {
      expect(alterTableOps[0].operations[0].columnName).toBe("email");
    }
    if (alterTableOps[0].operations[1].type === "add-column") {
      expect(alterTableOps[0].operations[1].columnName).toBe("age");
    }

    // Version should be: 1 (addTable) + 1 (alter-table with 2 columns)
    expect(userSchema.version).toBe(2);
  });

  it("should allow altering an existing table to add indexes", () => {
    const userSchema = schema((s) => {
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
    expect(userSchema.version).toBe(2);
  });

  it("should allow multiple alterTable calls on the same table", () => {
    const userSchema = schema((s) => {
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

    expectTypeOf(columns.id.$in).toBeString();
    expectTypeOf(columns.id.$out).toBeString();

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
    expect(userSchema.version).toBe(3);
  });
});

describe("idColumn", () => {
  it("should create a table with an id column", () => {
    const idCol = idColumn();
    type _In = typeof idCol.$in;
    type _Out = typeof idCol.$out;
    expectTypeOf<_In>().toBeString();
    expectTypeOf<_Out>().toBeString();

    expect(idCol.generateDefaultValue()).toBeDefined();
  });
});
