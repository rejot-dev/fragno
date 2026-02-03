import { describe, expect, it } from "vitest";
import type { MigrationOperation } from "../../../../migration-engine/shared";
import { createColdKysely } from "../cold-kysely";
import { SQLiteSQLGenerator } from "./sqlite";
import { sqliteStoragePrisma } from "../../sqlite-storage";
import { column, idColumn, schema } from "../../../../schema/create";
import { createNamingResolver, type SqlNamingStrategy } from "../../../../naming/sql-naming";

describe("SQLiteSQLGenerator", () => {
  const coldKysely = createColdKysely("sqlite");
  const generator = new SQLiteSQLGenerator(coldKysely, "sqlite");

  const prismaGenerator = new SQLiteSQLGenerator(
    coldKysely,
    "sqlite",
    undefined,
    sqliteStoragePrisma,
  );

  /**
   * Helper to compile a single operation and extract the main SQL statement.
   * SQLite preprocessing adds PRAGMA statement, so main statement is at index 1.
   */
  function compileOne(operation: MigrationOperation): string {
    const statements = generator.compile([operation]);
    // SQLite adds PRAGMA defer_foreign_keys at the beginning
    expect(statements.length).toBeGreaterThanOrEqual(2);
    expect(statements[0].sql).toBe("PRAGMA defer_foreign_keys = ON");
    return statements[1].sql;
  }

  /**
   * Helper to compile a single operation and extract all main SQL statements.
   * For alter-table operations that generate multiple statements.
   */
  function compileMany(operation: MigrationOperation): string[] {
    const statements = generator.compile([operation]);
    expect(statements.length).toBeGreaterThanOrEqual(1);
    expect(statements[0].sql).toBe("PRAGMA defer_foreign_keys = ON");
    // Return everything except pragma statement
    return statements.slice(1).map((s) => s.sql);
  }

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

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(
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

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(
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

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(
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

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(
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

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(
        `"create table "timestamps_test" ("id" integer not null unique, "created_at" integer default (cast((julianday('now') - 2440587.5)*86400000 as integer)) not null)"`,
      );
    });

    it("should use text for timestamp/date in prisma storage", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "prisma_timestamps",
        columns: [
          { name: "id", type: "integer", isNullable: false, role: "external-id" },
          { name: "created_at", type: "timestamp", isNullable: false, role: "regular" },
          { name: "published_on", type: "date", isNullable: false, role: "regular" },
        ],
      };

      const statements = prismaGenerator.compile([operation]);
      expect(statements[0].sql).toBe("PRAGMA defer_foreign_keys = ON");
      expect(statements[1].sql).toMatchInlineSnapshot(
        `"create table "prisma_timestamps" ("id" integer not null unique, "created_at" text not null, "published_on" text not null)"`,
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

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(
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

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(
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

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(`"alter table "old_name" rename to "new_name""`);
    });
  });

  describe("drop-table", () => {
    it("should generate SQL to drop table", () => {
      const operation: MigrationOperation = {
        type: "drop-table",
        name: "to_drop",
      };

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(`"drop table "to_drop""`);
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

      const statements = compileMany(operation);
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatchInlineSnapshot(
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

      const statements = compileMany(operation);
      expect(statements).toHaveLength(2);
      expect(statements[0]).toMatchInlineSnapshot(
        `"alter table "test_table" add column "col1" text"`,
      );
      expect(statements[1]).toMatchInlineSnapshot(
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

      const statements = compileMany(operation);
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatchInlineSnapshot(
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

      const statements = compileMany(operation);
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatchInlineSnapshot(
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

      expect(() => generator.compile([operation])).toThrow(
        "SQLite doesn't support updating columns. Recreate the table instead.",
      );
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

      expect(() => generator.compile([operation])).toThrow(
        "SQLite doesn't support updating columns. Recreate the table instead.",
      );
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

      expect(() => generator.compile([operation])).toThrow(
        "SQLite doesn't support updating columns. Recreate the table instead.",
      );
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

      expect(() => generator.compile([operation])).toThrow(
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
      expect(() => generator.compile([operation])).toThrow(
        "SQLite doesn't support updating columns. Recreate the table instead.",
      );
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

      expect(() => generator.compile([operation])).toThrow(
        "SQLite doesn't support modifying foreign keys",
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

      expect(() => generator.compile([operation])).toThrow(
        "SQLite doesn't support modifying foreign keys",
      );
    });
  });

  describe("drop-foreign-key", () => {
    it("should throw error when trying to drop foreign key (SQLite limitation)", () => {
      const operation: MigrationOperation = {
        type: "drop-foreign-key",
        table: "posts",
        name: "posts_user_id_fk",
        referencedTable: "users",
      };

      expect(() => generator.compile([operation])).toThrow(
        "SQLite doesn't support modifying foreign keys",
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

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(`"create index "idx_email" on "test_table" ("email")"`);
    });

    it("should generate SQL for unique index", () => {
      const operation: MigrationOperation = {
        type: "add-index",
        table: "test_table",
        columns: ["email"],
        name: "idx_unique_email",
        unique: true,
      };

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(
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

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(
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

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(
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

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(`"drop index if exists "idx_email" on "test_table""`);
    });
  });

  describe("complex migration scenarios", () => {
    it("should generate correct SQL for full schema migration", () => {
      const operations: MigrationOperation[] = [
        {
          type: "create-table",
          name: "users",
          columns: [
            { name: "id", type: "integer", isNullable: false, role: "external-id" },
            { name: "email", type: "string", isNullable: false, role: "regular" },
            { name: "name", type: "string", isNullable: false, role: "regular" },
          ],
        },
        {
          type: "add-index",
          table: "users",
          columns: ["email"],
          name: "idx_unique_email",
          unique: true,
        },
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
      ];

      const statements = generator.compile(operations);
      // PRAGMA + 4 operations
      expect(statements).toHaveLength(5);
      expect(statements[0].sql).toBe("PRAGMA defer_foreign_keys = ON");
      expect(statements[1].sql).toMatchInlineSnapshot(
        `"create table "users" ("id" integer not null unique, "email" text not null, "name" text not null)"`,
      );
      expect(statements[2].sql).toMatchInlineSnapshot(
        `"create unique index "idx_unique_email" on "users" ("email")"`,
      );
      expect(statements[3].sql).toMatchInlineSnapshot(
        `"create table "posts" ("id" integer not null unique, "user_id" integer not null, "title" text not null, "content" text not null)"`,
      );
      expect(statements[4].sql).toMatchInlineSnapshot(
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

      const statements = compileMany(operation);
      expect(statements).toHaveLength(3);
      expect(statements[0]).toMatchInlineSnapshot(`"alter table "users" add column "age" integer"`);
      expect(statements[1]).toMatchInlineSnapshot(
        `"alter table "users" rename column "name" to "full_name""`,
      );
      expect(statements[2]).toMatchInlineSnapshot(`"alter table "users" drop column "old_field""`);
    });
  });

  describe("edge cases", () => {
    it("should handle table names with special characters", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "user-profiles",
        columns: [{ name: "id", type: "integer", isNullable: false, role: "external-id" }],
      };

      const sql = compileOne(operation);
      expect(sql).toContain('"user-profiles"');
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

      const sql = compileOne(operation);
      expect(sql).toContain('"user-name"');
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

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(
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

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(
        `"create table "test" ("id" integer not null unique, "is_active" integer default true not null, "is_deleted" integer default false not null)"`,
      );
    });
  });

  describe("SQLite-specific behavior", () => {
    it("should handle bigint as blob (SQLite stores bigint as blob)", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "test",
        columns: [
          { name: "id", type: "integer", isNullable: false, role: "external-id" },
          { name: "big_number", type: "bigint", isNullable: false, role: "regular" },
        ],
      };

      const sql = compileOne(operation);
      expect(sql).toContain("blob");
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

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(
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

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(
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

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(
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

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(
        `"create table "test" ("id" integer not null unique, "price" real not null)"`,
      );
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

      const preprocessed = generator.preprocess(operations);

      // PRAGMA + 2 create-table operations (FK merged into posts table)
      expect(preprocessed).toHaveLength(3);

      // First should be pragma
      expect(preprocessed[0]).toEqual({ type: "custom", sql: "PRAGMA defer_foreign_keys = ON" });

      // Second operation should be create users table
      expect(preprocessed[1]).toMatchObject({
        type: "create-table",
        name: "users",
      });

      // Third operation should be create posts table with inline FK
      expect(preprocessed[2]).toMatchObject({
        type: "create-table",
        name: "posts",
      });

      if (preprocessed[2].type === "create-table") {
        const metadata = preprocessed[2].metadata as {
          inlineForeignKeys?: {
            name: string;
            columns: string[];
            referencedTable: string;
            referencedColumns: string[];
          }[];
        };
        expect(metadata?.inlineForeignKeys).toBeDefined();
        expect(metadata?.inlineForeignKeys).toHaveLength(1);
        expect(metadata?.inlineForeignKeys?.[0]).toMatchObject({
          name: "posts_users_author_fk",
          columns: ["author_id"],
          referencedTable: "users",
          referencedColumns: ["id"],
        });
      }
    });

    it("should generate SQL with inline foreign key constraints", () => {
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
            { name: "title", type: "string", isNullable: false, role: "regular" },
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

      const statements = generator.compile(operations);

      // PRAGMA + 2 create-table operations
      expect(statements).toHaveLength(3);
      expect(statements[0].sql).toBe("PRAGMA defer_foreign_keys = ON");

      // Posts table should contain inline FK constraint
      const postsSql = statements[2].sql;
      expect(postsSql).toContain("foreign key");
      expect(postsSql).toContain("author_id");
      expect(postsSql).toContain("references");
      expect(postsSql).toContain("users");
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

      const preprocessed = generator.preprocess(operations);

      // PRAGMA + create-table + add-foreign-key
      expect(preprocessed).toHaveLength(3);

      // Third operation should still be add-foreign-key (not merged)
      expect(preprocessed[2]).toMatchObject({
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

      const preprocessed = generator.preprocess(operations);

      // PRAGMA + 3 create-table operations (both FKs merged into posts)
      expect(preprocessed).toHaveLength(4);

      // Posts table should have both foreign keys merged
      const postsOp = preprocessed[3];
      expect(postsOp).toMatchObject({
        type: "create-table",
        name: "posts",
      });

      if (postsOp.type === "create-table") {
        const metadata = postsOp.metadata as { inlineForeignKeys?: { name: string }[] };
        expect(metadata?.inlineForeignKeys).toBeDefined();
        expect(metadata?.inlineForeignKeys).toHaveLength(2);
        expect(metadata?.inlineForeignKeys?.[0].name).toBe("posts_users_author_fk");
        expect(metadata?.inlineForeignKeys?.[1].name).toBe("posts_categories_category_fk");
      }
    });
  });

  describe("table name mapping", () => {
    const mappingSchema = schema("mapping", (s) =>
      s.addTable("users", (t) =>
        t.addColumn("id", idColumn()).addColumn("email", column("string")),
      ),
    );
    const namingStrategy: SqlNamingStrategy = {
      namespaceScope: "suffix",
      namespaceToSchema: (namespace) => namespace,
      tableName: (logicalTable) => `prefix_${logicalTable}`,
      columnName: (logicalColumn) => logicalColumn,
      indexName: (logicalIndex) => `idx_${logicalIndex}`,
      uniqueIndexName: (logicalIndex) => `uidx_${logicalIndex}`,
      foreignKeyName: ({ referenceName }) => referenceName,
    };
    const resolver = createNamingResolver(mappingSchema, null, namingStrategy);

    it("should apply table name mapping to create-table", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "users",
        columns: [{ name: "id", type: "integer", isNullable: false, role: "external-id" }],
      };

      const statements = generator.compile([operation], resolver);
      expect(statements[1].sql).toMatchInlineSnapshot(
        `"create table "prefix_users" ("id" integer not null unique)"`,
      );
    });

    it("should apply table name mapping to indexes", () => {
      const operation: MigrationOperation = {
        type: "add-index",
        table: "users",
        columns: ["email"],
        name: "idx_email",
        unique: true,
      };

      const statements = generator.compile([operation], resolver);
      expect(statements[1].sql).toMatchInlineSnapshot(
        `"create unique index "uidx_idx_email" on "prefix_users" ("email")"`,
      );
    });
  });

  describe("preprocessing", () => {
    it("should add PRAGMA and handle FK merging", () => {
      const operations: MigrationOperation[] = [
        {
          type: "create-table",
          name: "users",
          columns: [{ name: "id", type: "string", isNullable: false, role: "external-id" }],
        },
      ];

      const preprocessed = generator.preprocess(operations);
      expect(preprocessed.length).toBe(2);
      expect(preprocessed[0]).toEqual({ type: "custom", sql: "PRAGMA defer_foreign_keys = ON" });
      expect(preprocessed[1]).toEqual(operations[0]);
    });

    it("should return empty array for empty operations", () => {
      const preprocessed = generator.preprocess([]);
      expect(preprocessed).toHaveLength(0);
    });
  });

  describe("getDefaultValue", () => {
    it("should return literal value for all column types", () => {
      const defaultValue = generator.getDefaultValue({
        name: "status",
        type: "string",
        isNullable: false,
        role: "regular",
        default: { value: "active" },
      });

      expect(defaultValue).toBeDefined();
    });

    it("should return CURRENT_TIMESTAMP for dbSpecial: now", () => {
      const defaultValue = generator.getDefaultValue({
        name: "created_at",
        type: "timestamp",
        isNullable: false,
        role: "regular",
        default: { dbSpecial: "now" },
      });

      expect(defaultValue).toBeDefined();
    });

    it("should return undefined for runtime defaults", () => {
      const defaultValue = generator.getDefaultValue({
        name: "id",
        type: "string",
        isNullable: false,
        role: "regular",
        default: { runtime: "cuid" },
      });

      expect(defaultValue).toBeUndefined();
    });

    it("should return undefined when no default is set", () => {
      const defaultValue = generator.getDefaultValue({
        name: "name",
        type: "string",
        isNullable: false,
        role: "regular",
      });

      expect(defaultValue).toBeUndefined();
    });
  });
});
