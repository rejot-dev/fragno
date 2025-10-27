import { Kysely, SqliteDialect } from "kysely";
import { describe, expect, it, beforeAll } from "vitest";
import { execute } from "./execute";
import type { MigrationOperation } from "../../../migration-engine/shared";
import type { KyselyConfig } from "../kysely-adapter";
import { SqliteMigrationExecutor } from "./execute-sqlite";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KyselyAny = Kysely<any>;

function assertSingleResult<T>(result: T | T[]): asserts result is T {
  if (Array.isArray(result)) {
    throw new Error("Expected single result, got array");
  }
}

describe("execute() - SQLite", () => {
  let db: KyselyAny;
  let config: KyselyConfig;

  beforeAll(async () => {
    // Create a Kysely instance with a SqliteDialect, but not actually connected to a database
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db = new Kysely({ dialect: new SqliteDialect({} as any) });
    config = { db, provider: "sqlite" };
  });

  describe("create-table", () => {
    it("should generate SQL for simple table with columns", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "users",
        columns: [
          {
            name: "id",
            type: "integer",
            isNullable: false,
            role: "external-id",
          },
          {
            name: "name",
            type: "string",
            isNullable: false,
            role: "regular",
          },
          {
            name: "email",
            type: "string",
            isNullable: false,
            role: "regular",
          },
        ],
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"create table "users" ("id" integer not null unique, "name" text not null, "email" text not null)"`,
      );
    });

    it("should generate SQL for table with various column types", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "test_types",
        columns: [
          { name: "col_int", type: "integer", isNullable: false, role: "external-id" },
          { name: "col_bigint", type: "bigint", isNullable: false, role: "regular" },
          { name: "col_decimal", type: "decimal", isNullable: false, role: "regular" },
          { name: "col_bool", type: "bool", isNullable: false, role: "regular" },
          { name: "col_date", type: "date", isNullable: false, role: "regular" },
          { name: "col_timestamp", type: "timestamp", isNullable: false, role: "regular" },
          { name: "col_json", type: "json", isNullable: false, role: "regular" },
          { name: "col_binary", type: "binary", isNullable: false, role: "regular" },
          { name: "col_varchar", type: "varchar(255)", isNullable: false, role: "regular" },
        ],
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"create table "test_types" ("col_int" integer not null unique, "col_bigint" blob not null, "col_decimal" real not null, "col_bool" integer not null, "col_date" integer not null, "col_timestamp" integer not null, "col_json" text not null, "col_binary" blob not null, "col_varchar" text not null)"`,
      );
    });

    it("should generate SQL for table with nullable columns", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "nullable_test",
        columns: [
          { name: "id", type: "integer", isNullable: false, role: "external-id" },
          { name: "optional_name", type: "string", isNullable: true, role: "regular" },
          { name: "optional_age", type: "integer", isNullable: true, role: "regular" },
        ],
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"create table "nullable_test" ("id" integer not null unique, "optional_name" text, "optional_age" integer)"`,
      );
    });

    it("should generate SQL for table with default values", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "defaults_test",
        columns: [
          { name: "id", type: "integer", isNullable: false, role: "external-id" },
          {
            name: "status",
            type: "string",
            isNullable: false,
            role: "regular",
            default: { value: "pending" },
          },
          {
            name: "count",
            type: "integer",
            isNullable: false,
            role: "regular",
            default: { value: 0 },
          },
          {
            name: "is_active",
            type: "bool",
            isNullable: false,
            role: "regular",
            default: { value: true },
          },
        ],
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"create table "defaults_test" ("id" integer not null unique, "status" text default 'pending' not null, "count" integer default 0 not null, "is_active" integer default true not null)"`,
      );
    });

    it("should generate SQL for table with timestamp default to CURRENT_TIMESTAMP", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "timestamps_test",
        columns: [
          { name: "id", type: "integer", isNullable: false, role: "external-id" },
          {
            name: "created_at",
            type: "timestamp",
            isNullable: false,
            role: "regular",
            default: { dbSpecial: "now" },
          },
        ],
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"create table "timestamps_test" ("id" integer not null unique, "created_at" integer default CURRENT_TIMESTAMP not null)"`,
      );
    });

    it("should generate SQL for table with reference column", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "posts",
        columns: [
          { name: "id", type: "integer", isNullable: false, role: "external-id" },
          { name: "user_id", type: "integer", isNullable: false, role: "reference" },
          { name: "title", type: "string", isNullable: false, role: "regular" },
        ],
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"create table "posts" ("id" integer not null unique, "user_id" integer not null, "title" text not null)"`,
      );
    });

    it("should generate SQL for table with auto-increment internal ID", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "items",
        columns: [
          { name: "id", type: "integer", isNullable: false, role: "external-id" },
          { name: "_internalId", type: "bigint", isNullable: false, role: "internal-id" },
          { name: "name", type: "string", isNullable: false, role: "regular" },
        ],
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"create table "items" ("id" integer not null unique, "_internalId" integer not null primary key autoincrement, "name" text not null)"`,
      );
    });
  });

  describe("rename-table", () => {
    it("should generate SQL for SQLite rename", () => {
      const operation: MigrationOperation = {
        type: "rename-table",
        from: "old_name",
        to: "new_name",
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(`"alter table "old_name" rename to "new_name""`);
    });
  });

  describe("drop-table", () => {
    it("should generate SQL to drop table", () => {
      const operation: MigrationOperation = {
        type: "drop-table",
        name: "to_drop",
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(`"drop table "to_drop""`);
    });
  });

  describe("alter-table - create-column", () => {
    it("should generate SQL to add a new column", () => {
      const operation: MigrationOperation = {
        type: "alter-table",
        name: "test_table",
        value: [
          {
            type: "create-column",
            value: {
              name: "new_column",
              type: "string",
              isNullable: true,
              role: "regular",
            },
          },
        ],
      };

      const results = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      if (!Array.isArray(results)) {
        throw new Error("Expected array of results");
      }

      expect(results).toHaveLength(1);
      const compiled = results[0].compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"alter table "test_table" add column "new_column" text"`,
      );
    });

    it("should generate SQL for multiple columns", () => {
      const operation: MigrationOperation = {
        type: "alter-table",
        name: "test_table",
        value: [
          {
            type: "create-column",
            value: {
              name: "col1",
              type: "string",
              isNullable: true,
              role: "regular",
            },
          },
          {
            type: "create-column",
            value: {
              name: "col2",
              type: "integer",
              isNullable: false,
              role: "regular",
              default: { value: 0 },
            },
          },
        ],
      };

      const results = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      if (!Array.isArray(results)) {
        throw new Error("Expected array of results");
      }

      expect(results).toHaveLength(2);
      expect(results[0].compile().sql).toMatchInlineSnapshot(
        `"alter table "test_table" add column "col1" text"`,
      );
      expect(results[1].compile().sql).toMatchInlineSnapshot(
        `"alter table "test_table" add column "col2" integer default 0 not null"`,
      );
    });
  });

  describe("alter-table - rename-column", () => {
    it("should generate SQL to rename a column", () => {
      const operation: MigrationOperation = {
        type: "alter-table",
        name: "test_table",
        value: [
          {
            type: "rename-column",
            from: "old_name",
            to: "new_name",
          },
        ],
      };

      const results = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      if (!Array.isArray(results)) {
        throw new Error("Expected array of results");
      }

      expect(results).toHaveLength(1);
      const compiled = results[0].compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"alter table "test_table" rename column "old_name" to "new_name""`,
      );
    });
  });

  describe("alter-table - drop-column", () => {
    it("should generate SQL to drop a column", () => {
      const operation: MigrationOperation = {
        type: "alter-table",
        name: "test_table",
        value: [
          {
            type: "drop-column",
            name: "to_drop",
          },
        ],
      };

      const results = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      if (!Array.isArray(results)) {
        throw new Error("Expected array of results");
      }

      expect(results).toHaveLength(1);
      const compiled = results[0].compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"alter table "test_table" drop column "to_drop""`,
      );
    });
  });

  describe("alter-table - update-column", () => {
    it("should throw error when trying to update column (SQLite limitation)", () => {
      const operation: MigrationOperation = {
        type: "alter-table",
        name: "test_table",
        value: [
          {
            type: "update-column",
            name: "test_col",
            value: {
              name: "test_col",
              type: "integer",
              isNullable: true,
              role: "regular",
            },
            updateDataType: true,
            updateNullable: false,
            updateDefault: false,
          },
        ],
      };

      expect(() => {
        execute(operation, config, () => {
          throw new Error("No custom operations");
        });
      }).toThrow("SQLite doesn't support updating columns. Recreate the table instead.");
    });

    it("should throw error when trying to update nullable constraint", () => {
      const operation: MigrationOperation = {
        type: "alter-table",
        name: "test_table",
        value: [
          {
            type: "update-column",
            name: "test_col",
            value: {
              name: "test_col",
              type: "string",
              isNullable: false,
              role: "regular",
            },
            updateDataType: false,
            updateNullable: true,
            updateDefault: false,
          },
        ],
      };

      expect(() => {
        execute(operation, config, () => {
          throw new Error("No custom operations");
        });
      }).toThrow("SQLite doesn't support updating columns. Recreate the table instead.");
    });

    it("should throw error when trying to update default value", () => {
      const operation: MigrationOperation = {
        type: "alter-table",
        name: "test_table",
        value: [
          {
            type: "update-column",
            name: "test_col",
            value: {
              name: "test_col",
              type: "string",
              isNullable: false,
              role: "regular",
              default: { value: "default_value" },
            },
            updateDataType: false,
            updateNullable: false,
            updateDefault: true,
          },
        ],
      };

      expect(() => {
        execute(operation, config, () => {
          throw new Error("No custom operations");
        });
      }).toThrow("SQLite doesn't support updating columns. Recreate the table instead.");
    });

    it("should throw error when trying to update ID column", () => {
      const operation: MigrationOperation = {
        type: "alter-table",
        name: "test_table",
        value: [
          {
            type: "update-column",
            name: "id",
            value: {
              name: "id",
              type: "bigint",
              isNullable: false,
              role: "external-id",
            },
            updateDataType: true,
            updateNullable: false,
            updateDefault: false,
          },
        ],
      };

      expect(() => {
        execute(operation, config, () => {
          throw new Error("No custom operations");
        });
      }).toThrow(
        "ID columns cannot be updated. Not every database supports updating primary keys and often requires workarounds.",
      );
    });

    it("should throw error even for no-op update-column (SQLite limitation)", () => {
      const operation: MigrationOperation = {
        type: "alter-table",
        name: "test_table",
        value: [
          {
            type: "update-column",
            name: "test_col",
            value: {
              name: "test_col",
              type: "string",
              isNullable: true,
              role: "regular",
            },
            updateDataType: false,
            updateNullable: false,
            updateDefault: false,
          },
        ],
      };

      // SQLite throws error before checking if it's a no-op
      expect(() => {
        execute(operation, config, () => {
          throw new Error("No custom operations");
        });
      }).toThrow("SQLite doesn't support updating columns. Recreate the table instead.");
    });
  });

  describe("add-foreign-key", () => {
    it("should throw error when trying to add foreign key (SQLite limitation)", () => {
      const operation: MigrationOperation = {
        type: "add-foreign-key",
        table: "posts",
        value: {
          name: "posts_user_id_fk",
          columns: ["user_id"],
          referencedTable: "users",
          referencedColumns: ["id"],
        },
      };

      expect(() => {
        execute(operation, config, () => {
          throw new Error("No custom operations");
        });
      }).toThrow(
        "SQLite doesn't support modifying foreign keys directly. Use `recreate-table` instead.",
      );
    });

    it("should throw error for composite foreign key", () => {
      const operation: MigrationOperation = {
        type: "add-foreign-key",
        table: "posts",
        value: {
          name: "posts_user_fk",
          columns: ["org_id", "user_id"],
          referencedTable: "users",
          referencedColumns: ["org_id", "user_id"],
        },
      };

      expect(() => {
        execute(operation, config, () => {
          throw new Error("No custom operations");
        });
      }).toThrow(
        "SQLite doesn't support modifying foreign keys directly. Use `recreate-table` instead.",
      );
    });
  });

  describe("drop-foreign-key", () => {
    it("should throw error when trying to drop foreign key (SQLite limitation)", () => {
      const operation: MigrationOperation = {
        type: "drop-foreign-key",
        table: "posts",
        name: "posts_user_id_fk",
      };

      expect(() => {
        execute(operation, config, () => {
          throw new Error("No custom operations");
        });
      }).toThrow(
        "SQLite doesn't support modifying foreign keys directly. Use `recreate-table` instead.",
      );
    });
  });

  describe("add-index", () => {
    it("should generate SQL for regular index", () => {
      const operation: MigrationOperation = {
        type: "add-index",
        table: "test_table",
        columns: ["email"],
        name: "idx_email",
        unique: false,
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"create index "idx_email" on "test_table" ("email")"`,
      );
    });

    it("should generate SQL for unique index", () => {
      const operation: MigrationOperation = {
        type: "add-index",
        table: "test_table",
        columns: ["email"],
        name: "idx_unique_email",
        unique: true,
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"create unique index "idx_unique_email" on "test_table" ("email")"`,
      );
    });

    it("should generate SQL for composite index", () => {
      const operation: MigrationOperation = {
        type: "add-index",
        table: "test_table",
        columns: ["email", "name"],
        name: "idx_email_name",
        unique: false,
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"create index "idx_email_name" on "test_table" ("email", "name")"`,
      );
    });

    it("should generate SQL for unique composite index", () => {
      const operation: MigrationOperation = {
        type: "add-index",
        table: "test_table",
        columns: ["email", "name"],
        name: "idx_unique_email_name",
        unique: true,
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"create unique index "idx_unique_email_name" on "test_table" ("email", "name")"`,
      );
    });
  });

  describe("drop-index", () => {
    it("should generate SQL to drop index", () => {
      const operation: MigrationOperation = {
        type: "drop-index",
        table: "test_table",
        name: "idx_email",
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(`"drop index if exists "idx_email""`);
    });
  });

  describe("custom operations", () => {
    it("should handle custom operations via callback", () => {
      const operation: MigrationOperation = {
        type: "custom",
        customType: "test-operation",
        data: "test-data",
      };

      let customCallbackCalled = false;

      const result = execute(operation, config, (op) => {
        customCallbackCalled = true;
        expect(op).toEqual(operation);

        // Return a kysely query
        return db.schema.createTable("custom_table").addColumn("id", "integer");
      });

      expect(customCallbackCalled).toBe(true);

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toContain("create table");
      expect(compiled.sql).toContain("custom_table");
    });

    it("should support custom operations returning array of nodes", () => {
      const operation: MigrationOperation = {
        type: "custom",
        customType: "multi-operation",
      };

      const results = execute(operation, config, () => {
        return [
          db.schema.createTable("table1").addColumn("id", "integer"),
          db.schema.createTable("table2").addColumn("id", "integer"),
        ];
      });

      if (!Array.isArray(results)) {
        throw new Error("Expected array of results");
      }

      expect(results).toHaveLength(2);
      expect(results[0].compile().sql).toContain("table1");
      expect(results[1].compile().sql).toContain("table2");
    });
  });

  describe("complex migration scenarios", () => {
    it("should generate correct SQL for full schema migration", () => {
      // 1. Create users table
      const createUsers = execute(
        {
          type: "create-table",
          name: "users",
          columns: [
            { name: "id", type: "integer", isNullable: false, role: "external-id" },
            { name: "email", type: "string", isNullable: false, role: "regular" },
            { name: "name", type: "string", isNullable: false, role: "regular" },
          ],
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(createUsers);

      expect(createUsers.compile().sql).toMatchInlineSnapshot(
        `"create table "users" ("id" integer not null unique, "email" text not null, "name" text not null)"`,
      );

      // 2. Add unique index on email
      const addIndex = execute(
        {
          type: "add-index",
          table: "users",
          columns: ["email"],
          name: "idx_unique_email",
          unique: true,
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(addIndex);

      expect(addIndex.compile().sql).toMatchInlineSnapshot(
        `"create unique index "idx_unique_email" on "users" ("email")"`,
      );

      // 3. Create posts table
      const createPosts = execute(
        {
          type: "create-table",
          name: "posts",
          columns: [
            { name: "id", type: "integer", isNullable: false, role: "external-id" },
            { name: "user_id", type: "integer", isNullable: false, role: "reference" },
            { name: "title", type: "string", isNullable: false, role: "regular" },
            { name: "content", type: "string", isNullable: false, role: "regular" },
          ],
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(createPosts);

      expect(createPosts.compile().sql).toMatchInlineSnapshot(
        `"create table "posts" ("id" integer not null unique, "user_id" integer not null, "title" text not null, "content" text not null)"`,
      );

      // 4. Note: Cannot add foreign key after table creation in SQLite
      // Foreign keys must be defined in the CREATE TABLE statement

      // 5. Alter posts table to add a new column
      const alterResults = execute(
        {
          type: "alter-table",
          name: "posts",
          value: [
            {
              type: "create-column",
              value: {
                name: "published",
                type: "bool",
                isNullable: false,
                role: "regular",
                default: { value: false },
              },
            },
          ],
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      if (!Array.isArray(alterResults)) {
        throw new Error("Expected array of results");
      }

      expect(alterResults[0].compile().sql).toMatchInlineSnapshot(
        `"alter table "posts" add column "published" integer default false not null"`,
      );
    });

    it("should handle multiple alter-table operations", () => {
      const operation: MigrationOperation = {
        type: "alter-table",
        name: "users",
        value: [
          {
            type: "create-column",
            value: {
              name: "age",
              type: "integer",
              isNullable: true,
              role: "regular",
            },
          },
          {
            type: "rename-column",
            from: "name",
            to: "full_name",
          },
          {
            type: "drop-column",
            name: "old_field",
          },
        ],
      };

      const results = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      if (!Array.isArray(results)) {
        throw new Error("Expected array of results");
      }

      expect(results).toHaveLength(3);
      expect(results[0].compile().sql).toMatchInlineSnapshot(
        `"alter table "users" add column "age" integer"`,
      );
      expect(results[1].compile().sql).toMatchInlineSnapshot(
        `"alter table "users" rename column "name" to "full_name""`,
      );
      expect(results[2].compile().sql).toMatchInlineSnapshot(
        `"alter table "users" drop column "old_field""`,
      );
    });
  });

  describe("edge cases", () => {
    it("should handle table names with special characters", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "user-profiles",
        columns: [{ name: "id", type: "integer", isNullable: false, role: "external-id" }],
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toContain('"user-profiles"');
    });

    it("should handle column names with special characters", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "test",
        columns: [
          { name: "id", type: "integer", isNullable: false, role: "external-id" },
          { name: "user-name", type: "string", isNullable: false, role: "regular" },
        ],
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toContain('"user-name"');
    });

    it("should properly escape string default values", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "test",
        columns: [
          { name: "id", type: "integer", isNullable: false, role: "external-id" },
          {
            name: "status",
            type: "string",
            isNullable: false,
            role: "regular",
            default: { value: "it's pending" },
          },
        ],
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"create table "test" ("id" integer not null unique, "status" text default 'it''s pending' not null)"`,
      );
    });

    it("should handle boolean values as integers (SQLite stores bools as 0/1)", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "test",
        columns: [
          { name: "id", type: "integer", isNullable: false, role: "external-id" },
          {
            name: "is_active",
            type: "bool",
            isNullable: false,
            role: "regular",
            default: { value: true },
          },
          {
            name: "is_deleted",
            type: "bool",
            isNullable: false,
            role: "regular",
            default: { value: false },
          },
        ],
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"create table "test" ("id" integer not null unique, "is_active" integer default true not null, "is_deleted" integer default false not null)"`,
      );
    });
  });

  describe("SQLite-specific behavior", () => {
    it("should handle bigint as integer (SQLite doesn't have true bigint)", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "test",
        columns: [
          { name: "id", type: "integer", isNullable: false, role: "external-id" },
          { name: "big_number", type: "bigint", isNullable: false, role: "regular" },
        ],
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toContain("integer");
      expect(compiled.sql).not.toContain("bigint");
    });

    it("should handle date/timestamp as integer (SQLite stores dates as integers)", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "test",
        columns: [
          { name: "id", type: "integer", isNullable: false, role: "external-id" },
          { name: "birth_date", type: "date", isNullable: false, role: "regular" },
          { name: "created_at", type: "timestamp", isNullable: false, role: "regular" },
        ],
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"create table "test" ("id" integer not null unique, "birth_date" integer not null, "created_at" integer not null)"`,
      );
    });

    it("should handle JSON as text (SQLite stores JSON as text)", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "test",
        columns: [
          { name: "id", type: "integer", isNullable: false, role: "external-id" },
          { name: "metadata", type: "json", isNullable: false, role: "regular" },
        ],
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"create table "test" ("id" integer not null unique, "metadata" text not null)"`,
      );
    });

    it("should handle binary as blob", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "test",
        columns: [
          { name: "id", type: "integer", isNullable: false, role: "external-id" },
          { name: "file_data", type: "binary", isNullable: false, role: "regular" },
        ],
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"create table "test" ("id" integer not null unique, "file_data" blob not null)"`,
      );
    });

    it("should handle decimal as real", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "test",
        columns: [
          { name: "id", type: "integer", isNullable: false, role: "external-id" },
          { name: "price", type: "decimal", isNullable: false, role: "regular" },
        ],
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"create table "test" ("id" integer not null unique, "price" real not null)"`,
      );
    });
  });

  describe("foreign key limitations", () => {
    it("should document that foreign keys must be in CREATE TABLE for SQLite", () => {
      // This test documents SQLite's limitation:
      // Foreign keys MUST be defined in the CREATE TABLE statement
      // They cannot be added with ALTER TABLE ADD FOREIGN KEY

      const createTableWithFKOperation: MigrationOperation = {
        type: "custom",
        customType: "create-table-with-fk",
      };

      const result = execute(createTableWithFKOperation, config, () => {
        // In practice, you would use Kysely's schema builder to create
        // a table with foreign key constraints inline
        return db.schema
          .createTable("posts")
          .addColumn("id", "integer", (col) => col.notNull().unique())
          .addColumn("user_id", "integer", (col) =>
            col.notNull().references("users.id").onDelete("cascade"),
          )
          .addColumn("title", "text", (col) => col.notNull());
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toContain("create table");
      expect(compiled.sql).toContain("posts");
      expect(compiled.sql).toContain("user_id");
      expect(compiled.sql).toContain("references");
    });
  });

  describe("SQLite FK preprocessing", () => {
    it("should merge add-foreign-key into create-table when both are in same batch", () => {
      const operations: MigrationOperation[] = [
        {
          type: "create-table",
          name: "users",
          columns: [{ name: "id", type: "integer", isNullable: false, role: "internal-id" }],
        },
        {
          type: "create-table",
          name: "posts",
          columns: [
            { name: "id", type: "integer", isNullable: false, role: "internal-id" },
            { name: "author_id", type: "integer", isNullable: false, role: "reference" },
          ],
        },
        {
          type: "add-foreign-key",
          table: "posts",
          value: {
            name: "posts_users_author_fk",
            columns: ["author_id"],
            referencedTable: "users",
            referencedColumns: ["id"],
          },
        },
      ];

      const executor = new SqliteMigrationExecutor(db, "sqlite");
      const preprocessed = executor.preprocessOperations(operations);

      // Should have 2 operations (2 create-table, FK merged into posts table)
      expect(preprocessed).toHaveLength(2);

      // First operation should be create users table
      expect(preprocessed[0]).toMatchObject({
        type: "create-table",
        name: "users",
      });

      // Second operation should be create posts table with inline FK
      expect(preprocessed[1]).toMatchObject({
        type: "create-table",
        name: "posts",
      });

      if (preprocessed[1].type === "create-table") {
        expect(preprocessed[1].metadata?.inlineForeignKeys).toBeDefined();
        expect(preprocessed[1].metadata?.inlineForeignKeys).toHaveLength(1);
        expect(preprocessed[1].metadata?.inlineForeignKeys?.[0]).toMatchObject({
          name: "posts_users_author_fk",
          columns: ["author_id"],
          referencedTable: "users",
          referencedColumns: ["id"],
        });
      }
    });

    it("should generate SQL with inline foreign key constraints", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "posts",
        columns: [
          { name: "id", type: "integer", isNullable: false, role: "internal-id" },
          { name: "author_id", type: "integer", isNullable: false, role: "reference" },
          { name: "title", type: "string", isNullable: false, role: "regular" },
        ],
        metadata: {
          inlineForeignKeys: [
            {
              name: "posts_users_author_fk",
              columns: ["author_id"],
              referencedTable: "users",
              referencedColumns: ["id"],
            },
          ],
        },
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      // Should contain the foreign key constraint
      expect(compiled.sql).toContain("posts_users_author_fk");
      expect(compiled.sql).toContain("foreign key");
      expect(compiled.sql).toContain("author_id");
      expect(compiled.sql).toContain("references");
      expect(compiled.sql).toContain("users");
    });

    it("should keep add-foreign-key operations for existing tables (will throw error)", () => {
      const operations: MigrationOperation[] = [
        {
          type: "create-table",
          name: "users",
          columns: [{ name: "id", type: "integer", isNullable: false, role: "internal-id" }],
        },
        {
          type: "add-foreign-key",
          table: "posts", // posts table doesn't exist in this migration "batch"
          value: {
            name: "posts_users_author_fk",
            columns: ["author_id"],
            referencedTable: "users",
            referencedColumns: ["id"],
          },
        },
      ];

      const executor = new SqliteMigrationExecutor(db, "sqlite");
      const preprocessed = executor.preprocessOperations(operations);

      // Should have 2 operations (create-table + add-foreign-key)
      expect(preprocessed).toHaveLength(2);

      // Second operation should still be add-foreign-key (not merged)
      expect(preprocessed[1]).toMatchObject({
        type: "add-foreign-key",
        table: "posts",
      });
    });

    it("should handle multiple foreign keys on the same table", () => {
      const operations: MigrationOperation[] = [
        {
          type: "create-table",
          name: "users",
          columns: [{ name: "id", type: "integer", isNullable: false, role: "internal-id" }],
        },
        {
          type: "create-table",
          name: "categories",
          columns: [{ name: "id", type: "integer", isNullable: false, role: "internal-id" }],
        },
        {
          type: "create-table",
          name: "posts",
          columns: [
            { name: "id", type: "integer", isNullable: false, role: "internal-id" },
            { name: "author_id", type: "integer", isNullable: false, role: "reference" },
            { name: "category_id", type: "integer", isNullable: false, role: "reference" },
          ],
        },
        {
          type: "add-foreign-key",
          table: "posts",
          value: {
            name: "posts_users_author_fk",
            columns: ["author_id"],
            referencedTable: "users",
            referencedColumns: ["id"],
          },
        },
        {
          type: "add-foreign-key",
          table: "posts",
          value: {
            name: "posts_categories_category_fk",
            columns: ["category_id"],
            referencedTable: "categories",
            referencedColumns: ["id"],
          },
        },
      ];

      const executor = new SqliteMigrationExecutor(db, "sqlite");
      const preprocessed = executor.preprocessOperations(operations);

      // Should have 3 operations (3 create-table, both FKs merged into posts)
      expect(preprocessed).toHaveLength(3);

      // Posts table should have both foreign keys merged
      const postsOp = preprocessed[2];
      expect(postsOp).toMatchObject({
        type: "create-table",
        name: "posts",
      });

      if (postsOp.type === "create-table") {
        expect(postsOp.metadata?.inlineForeignKeys).toBeDefined();
        expect(postsOp.metadata?.inlineForeignKeys).toHaveLength(2);
        expect(postsOp.metadata?.inlineForeignKeys?.[0].name).toBe("posts_users_author_fk");
        expect(postsOp.metadata?.inlineForeignKeys?.[1].name).toBe("posts_categories_category_fk");
      }
    });
  });
});
