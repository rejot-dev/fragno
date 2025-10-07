import { describe, expect, it } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../schema/create";
import { generateMigrationFromSchema } from "./auto-from-schema";

describe("generateMigrationFromSchema", () => {
  it("should generate create-table operation for new tables", () => {
    const mySchema = schema((s) => {
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

    // Version 0 -> 1: users table created
    // Version 1 -> 2: posts table created
    // We want to generate the migration for version 1 -> 2
    const operations = generateMigrationFromSchema(mySchema, 1, 2);

    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      type: "create-table",
      name: "posts",
      columns: expect.arrayContaining([
        expect.objectContaining({ name: "id" }),
        expect.objectContaining({ name: "title" }),
        expect.objectContaining({ name: "content" }),
      ]),
    });
  });

  it("should generate multiple table operations in sequence", () => {
    const mySchema = schema((s) => {
      return s
        .addTable("users", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        })
        .addTable("posts", (t) => {
          return t.addColumn("id", idColumn()).addColumn("title", column("string"));
        })
        .addTable("comments", (t) => {
          return t.addColumn("id", idColumn()).addColumn("text", column("string"));
        });
    });

    // Generate migrations from version 0 to 3 (all three tables)
    const operations = generateMigrationFromSchema(mySchema, 0, 3);

    expect(operations).toHaveLength(3);
    expect(operations[0]).toMatchObject({
      type: "create-table",
      name: "users",
      columns: expect.arrayContaining([
        expect.objectContaining({ name: "id" }),
        expect.objectContaining({ name: "name" }),
      ]),
    });
    expect(operations[1]).toMatchObject({
      type: "create-table",
      name: "posts",
      columns: expect.arrayContaining([
        expect.objectContaining({ name: "id" }),
        expect.objectContaining({ name: "title" }),
      ]),
    });
    expect(operations[2]).toMatchObject({
      type: "create-table",
      name: "comments",
      columns: expect.arrayContaining([
        expect.objectContaining({ name: "id" }),
        expect.objectContaining({ name: "text" }),
      ]),
    });
  });

  it("should generate add-foreign-key operation for new foreign keys", () => {
    const mySchema = schema((s) => {
      return s
        .addTable("users", (t) => {
          return t.addColumn("id", idColumn());
        })
        .addTable("posts", (t) => {
          return t.addColumn("id", idColumn()).addColumn("authorId", referenceColumn());
        })
        .addReference("posts", "author", {
          columns: ["authorId"],
          targetTable: "users",
          targetColumns: ["id"],
        });
    });

    // Version 0 -> 1: users table
    // Version 1 -> 2: posts table
    // Version 2 -> 3: author foreign key
    const operations = generateMigrationFromSchema(mySchema, 2, 3);

    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      type: "add-foreign-key",
      table: "posts",
    });

    const fkOp = operations[0];
    if (fkOp.type === "add-foreign-key") {
      expect(fkOp.value).toMatchObject({
        name: "posts_users_author_fk",
        referencedTable: "users",
        columns: ["authorId"],
        referencedColumns: ["id"],
      });
    }
  });

  it("should generate add-index operation for indexes added via alterTable", () => {
    const mySchema = schema((s) => {
      return s
        .addTable("users", (t) => {
          return t.addColumn("id", idColumn()).addColumn("email", column("string"));
        })
        .alterTable("users", (t) => {
          return t.createIndex("idx_email", ["email"], { unique: true });
        });
    });

    const operations = generateMigrationFromSchema(mySchema, 0, 2);

    expect(operations).toHaveLength(2);
    expect(operations[0].type).toBe("create-table");
    expect(operations[1]).toMatchObject({
      type: "add-index",
      table: "users",
      name: "idx_email",
      columns: ["email"],
      unique: true,
    });
  });

  it("should generate mixed operations for tables and foreign keys", () => {
    const mySchema = schema((s) => {
      return s
        .addTable("users", (t) => {
          return t.addColumn("id", idColumn()).addColumn("name", column("string"));
        })
        .addTable("posts", (t) => {
          return t.addColumn("id", idColumn()).addColumn("authorId", referenceColumn());
        })
        .addReference("posts", "author", {
          columns: ["authorId"],
          targetTable: "users",
          targetColumns: ["id"],
        });
    });

    // Generate all migrations from scratch
    const operations = generateMigrationFromSchema(mySchema, 0, 3);

    expect(operations).toHaveLength(3);
    expect(operations[0].type).toBe("create-table");
    expect(operations[1].type).toBe("create-table");
    expect(operations[2].type).toBe("add-foreign-key");
  });

  it("should generate mixed operations for tables, indexes, and foreign keys", () => {
    const mySchema = schema((s) => {
      return s
        .addTable("users", (t) => {
          return t.addColumn("id", idColumn()).addColumn("email", column("string"));
        })
        .alterTable("users", (t) => {
          return t.createIndex("idx_email", ["email"], { unique: true });
        })
        .addTable("posts", (t) => {
          return t.addColumn("id", idColumn()).addColumn("authorId", referenceColumn());
        })
        .addReference("posts", "author", {
          columns: ["authorId"],
          targetTable: "users",
          targetColumns: ["id"],
        });
    });

    // Generate all migrations from scratch
    const operations = generateMigrationFromSchema(mySchema, 0, 4);

    expect(operations).toHaveLength(4);
    expect(operations[0].type).toBe("create-table");
    expect(operations[1].type).toBe("add-index");
    expect(operations[2].type).toBe("create-table");
    expect(operations[3].type).toBe("add-foreign-key");
  });

  it("should generate no operations when version range is empty", () => {
    const mySchema = schema((s) => {
      return s.addTable("users", (t) => {
        return t.addColumn("id", idColumn()).addColumn("name", column("string"));
      });
    });

    const operations = generateMigrationFromSchema(mySchema, 1, 1);

    expect(operations).toHaveLength(0);
  });

  it("should throw error when fromVersion exceeds schema version", () => {
    const mySchema = schema((s) => s.addTable("users", (t) => t.addColumn("id", idColumn())));

    expect(() => {
      generateMigrationFromSchema(mySchema, 999, 1000);
    }).toThrow("fromVersion (999) exceeds schema version (1)");
  });

  it("should throw error when toVersion exceeds schema version", () => {
    const mySchema = schema((s) => s.addTable("users", (t) => t.addColumn("id", idColumn())));

    expect(() => {
      generateMigrationFromSchema(mySchema, 0, 999);
    }).toThrow("toVersion (999) exceeds schema version (1)");
  });

  it("should throw error when trying to migrate backwards", () => {
    const mySchema = schema((s) => s.addTable("users", (t) => t.addColumn("id", idColumn())));

    expect(() => {
      generateMigrationFromSchema(mySchema, 1, 0);
    }).toThrow("Cannot migrate backwards");
  });

  it("should throw error for negative fromVersion", () => {
    const mySchema = schema((s) => s.addTable("users", (t) => t.addColumn("id", idColumn())));

    expect(() => {
      generateMigrationFromSchema(mySchema, -1, 1);
    }).toThrow("fromVersion cannot be negative");
  });

  it("should only create constraints for references, not for referenceColumns", () => {
    const mySchema = schema((s) => {
      return s
        .addTable("posts", (t) => {
          return t
            .addColumn("id", idColumn().defaultTo("auto"))
            .addColumn("title", column("string"))
            .addColumn("content", column("string"))
            .addColumn("userId", referenceColumn());
        })
        .addTable("users", (t) => {
          return t
            .addColumn("id", idColumn().defaultTo("auto"))
            .addColumn("name", column("string"));
        })
        .addReference("posts", "author", {
          columns: ["userId"],
          targetTable: "users",
          targetColumns: ["id"],
        })
        .alterTable("posts", (t) => {
          return t
            .addColumn("summary", column("string").nullable())
            .createIndex("idx_title", ["title"]);
        });
    });

    const operations = generateMigrationFromSchema(mySchema, 0, mySchema.version);
    expect(operations.map((o) => o.type)).toEqual([
      "create-table",
      "create-table",
      "add-foreign-key",
      "alter-table",
      "add-index",
    ]);
  });

  it("should not create duplicate foreign key constraints", () => {
    const mySchema = schema((s) => {
      return s
        .addTable("users", (t) => t.addColumn("id", idColumn()))
        .addTable("posts", (t) =>
          t.addColumn("id", idColumn()).addColumn("userId", referenceColumn()),
        )
        .addReference("posts", "author", {
          columns: ["userId"],
          targetTable: "users",
          targetColumns: ["id"],
        });
    });

    const operations = generateMigrationFromSchema(mySchema, 0, mySchema.version);

    // Count foreign key operations
    const fkOps = operations.filter((op) => op.type === "add-foreign-key");
    expect(fkOps).toHaveLength(1); // Should be exactly one, not two
  });
});
