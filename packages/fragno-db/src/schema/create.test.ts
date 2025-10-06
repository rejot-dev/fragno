import { describe, expect, expectTypeOf, it } from "vitest";
import { column, compileForeignKey, idColumn, referenceColumn, schema, table } from "./create";

describe("create", () => {
  it("should create a table with columns using callback pattern", () => {
    const userTable = table("users", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("email", column("string"))
        .createIndex("unique_email", ["email"], { unique: true })
        .addColumn("age", column("integer").nullable());
    });

    expect(userTable.columns.id).toBeDefined();
    expect(userTable.columns.name).toBeDefined();
    expect(userTable.columns.email).toBeDefined();
    expect(userTable.columns.age).toBeDefined();
    expect(userTable.columns.age.isNullable).toBe(true);
    expect(userTable.indexes).toEqual([
      {
        name: "unique_email",
        columns: [userTable.columns.email],
        unique: true,
      },
    ]);
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
    const testTable = table("test", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("createdAt", column("timestamp").defaultTo$("now"))
        .addColumn("status", column("string").defaultTo("active"));
    });

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
    const userTable = table("users", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("email", column("string"))
        .addColumn("username", column("string"))
        .createIndex("unique_email_username", ["email", "username"], { unique: true });
    });

    const uniqueIndexes = userTable.indexes.filter((idx) => idx.unique);
    expect(uniqueIndexes).toHaveLength(1);
    expect(uniqueIndexes[0].name).toBe("unique_email_username");
    expect(uniqueIndexes[0].columns).toHaveLength(2);
  });

  it("should support creating indexes on tables", () => {
    const userTable = table("users", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("email", column("string"))
        .addColumn("username", column("string"))
        .createIndex("idx_email", ["email"])
        .createIndex("idx_username_unique", ["username"], { unique: true });
    });

    expect(userTable.indexes).toHaveLength(2);
    expect(userTable.indexes[0]).toEqual({
      name: "idx_email",
      columns: [userTable.columns.email],
      unique: false,
    });
    expect(userTable.indexes[1]).toEqual({
      name: "idx_username_unique",
      columns: [userTable.columns.username],
      unique: true,
    });
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

    // Verify both foreign keys were created
    expect(junctionTable.foreignKeys).toHaveLength(2);
    expect(junctionTable.foreignKeys[0].referencedTable).toBe(userSchema.tables.users);
    expect(junctionTable.foreignKeys[1].referencedTable).toBe(userSchema.tables.tags);
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
    expect(postsTable.columns.authorId.isReference).toBe(true);

    // Verify the relation exists
    const authorRelation = postsTable.relations["author"];
    expect(authorRelation).toBeDefined();
    expect(authorRelation.type).toBe("one");
    expect(authorRelation.table).toBe(userSchema.tables.users);
    expect(authorRelation.on).toEqual([["authorId", "id"]]);

    // Verify the foreign key was created
    expect(postsTable.foreignKeys).toHaveLength(1);
    const fk = postsTable.foreignKeys[0];
    expect(fk.table).toBe(postsTable);
    expect(fk.referencedTable).toBe(userSchema.tables.users);
    expect(fk.columns).toEqual([postsTable.columns.authorId]);
    expect(fk.referencedColumns).toEqual([userSchema.tables.users.columns.id]);

    // Verify the compiled foreign key format
    const compiledFk = compileForeignKey(fk);
    expect(compiledFk).toEqual({
      name: "posts_users_author_fk",
      table: "posts",
      referencedTable: "users",
      columns: ["authorId"],
      referencedColumns: ["id"],
    });
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

    // Verify both foreign keys were created
    expect(postsTable.foreignKeys).toHaveLength(2);
    expect(postsTable.foreignKeys[0].referencedTable).toBe(userSchema.tables.users);
    expect(postsTable.foreignKeys[1].referencedTable).toBe(userSchema.tables.categories);
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

    // Verify the foreign key was created
    expect(usersTable.foreignKeys).toHaveLength(1);
    const fk = usersTable.foreignKeys[0];
    expect(fk.table).toBe(usersTable);
    expect(fk.referencedTable).toBe(usersTable);
    expect(fk.columns).toEqual([usersTable.columns.invitedBy]);
    expect(fk.referencedColumns).toEqual([usersTable.columns.id]);
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
    expect(alterTableOps[0].modifications).toHaveLength(2);
    expect(alterTableOps[0].modifications[0].columnName).toBe("email");
    expect(alterTableOps[0].modifications[1].columnName).toBe("age");

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

    const usersTable = userSchema.tables.users;

    // Verify the indexes were added
    expect(usersTable.indexes).toHaveLength(2);
    expect(usersTable.indexes[0].name).toBe("idx_email");
    expect(usersTable.indexes[0].unique).toBe(false);
    expect(usersTable.indexes[1].name).toBe("idx_name_unique");
    expect(usersTable.indexes[1].unique).toBe(true);

    // Verify the operations were recorded
    const addIndexOps = userSchema.operations.filter((op) => op.type === "add-index");
    expect(addIndexOps).toHaveLength(2);

    // Version should be: 1 (addTable) + 2 (add-index ops)
    expect(userSchema.version).toBe(3);
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
