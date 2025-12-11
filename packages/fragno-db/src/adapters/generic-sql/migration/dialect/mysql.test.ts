import { describe, expect, it } from "vitest";
import type { MigrationOperation } from "../../../../migration-engine/shared";
import { createColdKysely } from "../cold-kysely";
import { MySQLSQLGenerator } from "./mysql";

describe("MySQLSQLGenerator", () => {
  const coldKysely = createColdKysely("mysql");
  const generator = new MySQLSQLGenerator(coldKysely, "mysql");

  /**
   * Helper to compile a single operation and extract the main SQL statement.
   * MySQL wraps operations with FK checks, so the main statement is at index 1.
   */
  function compileOne(operation: MigrationOperation): string {
    const statements = generator.compile([operation]);
    // MySQL wraps with FK checks: [SET FK=0, ...operations..., SET FK=1]
    expect(statements.length).toBeGreaterThanOrEqual(3);
    expect(statements[0].sql).toBe("SET FOREIGN_KEY_CHECKS = 0");
    expect(statements[statements.length - 1].sql).toBe("SET FOREIGN_KEY_CHECKS = 1");
    return statements[1].sql;
  }

  /**
   * Helper to compile a single operation and extract all main SQL statements.
   * For alter-table operations that generate multiple statements.
   */
  function compileMany(operation: MigrationOperation): string[] {
    const statements = generator.compile([operation]);
    expect(statements.length).toBeGreaterThanOrEqual(2);
    expect(statements[0].sql).toBe("SET FOREIGN_KEY_CHECKS = 0");
    expect(statements[statements.length - 1].sql).toBe("SET FOREIGN_KEY_CHECKS = 1");
    // Return everything except FK check statements
    return statements.slice(1, -1).map((s) => s.sql);
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
        `"create table \`users\` (\`id\` integer not null unique, \`name\` text not null, \`email\` text not null)"`,
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
        `"create table \`test_types\` (\`col_int\` integer not null unique, \`col_bigint\` bigint not null, \`col_decimal\` decimal not null, \`col_bool\` boolean not null, \`col_date\` date not null, \`col_timestamp\` datetime not null, \`col_json\` json not null, \`col_binary\` longblob not null, \`col_varchar\` varchar(255) not null)"`,
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
        `"create table \`nullable_test\` (\`id\` integer not null unique, \`optional_name\` text, \`optional_age\` integer)"`,
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
      // Note: MySQL doesn't support defaults on TEXT columns, so 'status' won't have a default
      expect(sql).toMatchInlineSnapshot(
        `"create table \`defaults_test\` (\`id\` integer not null unique, \`status\` text not null, \`count\` integer default 0 not null, \`is_active\` boolean default true not null)"`,
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
        `"create table \`timestamps_test\` (\`id\` integer not null unique, \`created_at\` datetime default CURRENT_TIMESTAMP not null)"`,
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
        `"create table \`posts\` (\`id\` integer not null unique, \`user_id\` integer not null, \`title\` text not null)"`,
      );
    });

    it("should generate SQL for table with internal-id column (auto_increment)", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "users",
        columns: [
          { name: "_internalId", type: "bigint", isNullable: false, role: "internal-id" },
          { name: "name", type: "string", isNullable: false, role: "regular" },
        ],
      };

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(
        `"create table \`users\` (\`_internalId\` bigint not null primary key auto_increment, \`name\` text not null)"`,
      );
    });
  });

  describe("rename-table", () => {
    it("should generate SQL for MySQL rename", () => {
      const operation: MigrationOperation = {
        type: "rename-table",
        from: "old_name",
        to: "new_name",
      };

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(`"alter table \`old_name\` rename to \`new_name\`"`);
    });
  });

  describe("drop-table", () => {
    it("should generate SQL to drop table", () => {
      const operation: MigrationOperation = {
        type: "drop-table",
        name: "to_drop",
      };

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(`"drop table \`to_drop\`"`);
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
        `"alter table \`test_table\` add column \`new_column\` text"`,
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
        `"alter table \`test_table\` add column \`col1\` text"`,
      );
      expect(statements[1]).toMatchInlineSnapshot(
        `"alter table \`test_table\` add column \`col2\` integer default 0 not null"`,
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
        `"alter table \`test_table\` rename column \`old_name\` to \`new_name\`"`,
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
        `"alter table \`test_table\` drop column \`to_drop\`"`,
      );
    });
  });

  describe("alter-table - update-column", () => {
    it("should generate SQL to update column data type (MySQL uses MODIFY COLUMN)", () => {
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

      const statements = compileMany(operation);
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatchInlineSnapshot(
        `"alter table \`test_table\` modify column \`test_col\` integer"`,
      );
    });

    it("should generate SQL to set column NOT NULL", () => {
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

      const statements = compileMany(operation);
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatchInlineSnapshot(
        `"alter table \`test_table\` modify column \`test_col\` text not null"`,
      );
    });

    it("should generate SQL to drop NOT NULL constraint", () => {
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
            updateNullable: true,
            updateDefault: false,
          },
        ],
      };

      const statements = compileMany(operation);
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatchInlineSnapshot(
        `"alter table \`test_table\` modify column \`test_col\` text"`,
      );
    });

    it("should generate SQL to set default value", () => {
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

      const statements = compileMany(operation);
      expect(statements).toHaveLength(1);
      // Note: MySQL doesn't support defaults on TEXT columns
      expect(statements[0]).toMatchInlineSnapshot(
        `"alter table \`test_table\` modify column \`test_col\` text not null"`,
      );
    });

    it("should generate SQL to drop default value", () => {
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
            updateDefault: true,
          },
        ],
      };

      const statements = compileMany(operation);
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatchInlineSnapshot(
        `"alter table \`test_table\` modify column \`test_col\` text"`,
      );
    });

    it("should generate SQL to update multiple properties at once", () => {
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
              isNullable: false,
              role: "regular",
              default: { value: 0 },
            },
            updateDataType: true,
            updateNullable: true,
            updateDefault: true,
          },
        ],
      };

      const statements = compileMany(operation);
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatchInlineSnapshot(
        `"alter table \`test_table\` modify column \`test_col\` integer default 0 not null"`,
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

    it("should handle no-op update-column (no flags set)", () => {
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

      const statements = compileMany(operation);
      // No-op should return empty array (only FK check statements remain)
      expect(statements).toHaveLength(0);
    });

    it("should generate SQL for timestamp default", () => {
      const operation: MigrationOperation = {
        type: "alter-table",
        name: "test_table",
        value: [
          {
            type: "update-column",
            name: "updated_at",
            value: {
              name: "updated_at",
              type: "timestamp",
              isNullable: false,
              role: "regular",
              default: { dbSpecial: "now" },
            },
            updateDataType: false,
            updateNullable: false,
            updateDefault: true,
          },
        ],
      };

      const statements = compileMany(operation);
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatchInlineSnapshot(
        `"alter table \`test_table\` modify column \`updated_at\` datetime default CURRENT_TIMESTAMP not null"`,
      );
    });
  });

  describe("add-foreign-key", () => {
    it("should generate SQL for foreign key constraint", () => {
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

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(
        `"alter table \`posts\` add constraint \`posts_user_id_fk\` foreign key (\`user_id\`) references \`users\` (\`id\`) on delete restrict on update restrict"`,
      );
    });

    it("should generate SQL for composite foreign key", () => {
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

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(
        `"alter table \`posts\` add constraint \`posts_user_fk\` foreign key (\`org_id\`, \`user_id\`) references \`users\` (\`org_id\`, \`user_id\`) on delete restrict on update restrict"`,
      );
    });
  });

  describe("drop-foreign-key", () => {
    it("should generate SQL to drop foreign key constraint", () => {
      const operation: MigrationOperation = {
        type: "drop-foreign-key",
        table: "posts",
        name: "posts_user_id_fk",
      };

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(
        `"alter table \`posts\` drop constraint \`posts_user_id_fk\`"`,
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
      expect(sql).toMatchInlineSnapshot(
        `"create index \`idx_email\` on \`test_table\` (\`email\`)"`,
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

      const sql = compileOne(operation);
      expect(sql).toMatchInlineSnapshot(
        `"create unique index \`idx_unique_email\` on \`test_table\` (\`email\`)"`,
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
        `"create index \`idx_email_name\` on \`test_table\` (\`email\`, \`name\`)"`,
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
        `"create unique index \`idx_unique_email_name\` on \`test_table\` (\`email\`, \`name\`)"`,
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
      expect(sql).toMatchInlineSnapshot(`"drop index if exists \`idx_email\` on \`test_table\`"`);
    });
  });

  describe("complex migration scenarios", () => {
    it("should generate correct SQL for full schema migration", () => {
      // Create multiple operations in sequence
      const createUsersOp: MigrationOperation = {
        type: "create-table",
        name: "users",
        columns: [
          { name: "id", type: "integer", isNullable: false, role: "external-id" },
          { name: "email", type: "string", isNullable: false, role: "regular" },
          { name: "name", type: "string", isNullable: false, role: "regular" },
        ],
      };

      const addIndexOp: MigrationOperation = {
        type: "add-index",
        table: "users",
        columns: ["email"],
        name: "idx_unique_email",
        unique: true,
      };

      const createPostsOp: MigrationOperation = {
        type: "create-table",
        name: "posts",
        columns: [
          { name: "id", type: "integer", isNullable: false, role: "external-id" },
          { name: "user_id", type: "integer", isNullable: false, role: "reference" },
          { name: "title", type: "string", isNullable: false, role: "regular" },
          { name: "content", type: "string", isNullable: false, role: "regular" },
        ],
      };

      const addFkOp: MigrationOperation = {
        type: "add-foreign-key",
        table: "posts",
        value: {
          name: "posts_user_id_fk",
          columns: ["user_id"],
          referencedTable: "users",
          referencedColumns: ["id"],
        },
      };

      const alterPostsOp: MigrationOperation = {
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
      };

      // Compile all operations together
      const statements = generator.compile([
        createUsersOp,
        addIndexOp,
        createPostsOp,
        addFkOp,
        alterPostsOp,
      ]);

      // Should have FK check wrapper + 5 operations
      expect(statements.length).toBe(7);
      expect(statements[0].sql).toBe("SET FOREIGN_KEY_CHECKS = 0");
      expect(statements[1].sql).toMatchInlineSnapshot(
        `"create table \`users\` (\`id\` integer not null unique, \`email\` text not null, \`name\` text not null)"`,
      );
      expect(statements[2].sql).toMatchInlineSnapshot(
        `"create unique index \`idx_unique_email\` on \`users\` (\`email\`)"`,
      );
      expect(statements[3].sql).toMatchInlineSnapshot(
        `"create table \`posts\` (\`id\` integer not null unique, \`user_id\` integer not null, \`title\` text not null, \`content\` text not null)"`,
      );
      expect(statements[4].sql).toMatchInlineSnapshot(
        `"alter table \`posts\` add constraint \`posts_user_id_fk\` foreign key (\`user_id\`) references \`users\` (\`id\`) on delete restrict on update restrict"`,
      );
      expect(statements[5].sql).toMatchInlineSnapshot(
        `"alter table \`posts\` add column \`published\` boolean default false not null"`,
      );
      expect(statements[6].sql).toBe("SET FOREIGN_KEY_CHECKS = 1");
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
      expect(statements[0]).toMatchInlineSnapshot(
        `"alter table \`users\` add column \`age\` integer"`,
      );
      expect(statements[1]).toMatchInlineSnapshot(
        `"alter table \`users\` rename column \`name\` to \`full_name\`"`,
      );
      expect(statements[2]).toMatchInlineSnapshot(
        `"alter table \`users\` drop column \`old_field\`"`,
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

      const sql = compileOne(operation);
      expect(sql).toContain("`user-profiles`");
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
      expect(sql).toContain("`user-name`");
    });

    it("should properly handle string default values (not applied for TEXT columns)", () => {
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
      // MySQL doesn't support defaults on TEXT columns, so the default is not applied
      expect(sql).toMatchInlineSnapshot(
        `"create table \`test\` (\`id\` integer not null unique, \`status\` text not null)"`,
      );
    });
  });

  describe("table name mapping", () => {
    const mapper = {
      toPhysical: (name: string) => `prefix_${name}`,
      toLogical: (name: string) => name.replace("prefix_", ""),
    };

    it("should apply table name mapping to create-table", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "users",
        columns: [{ name: "id", type: "integer", isNullable: false, role: "external-id" }],
      };

      const statements = generator.compile([operation], mapper);
      expect(statements[1].sql).toMatchInlineSnapshot(
        `"create table \`prefix_users\` (\`id\` integer not null unique)"`,
      );
    });

    it("should apply table name mapping to foreign keys", () => {
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

      const statements = generator.compile([operation], mapper);
      expect(statements[1].sql).toMatchInlineSnapshot(
        `"alter table \`prefix_posts\` add constraint \`posts_user_id_fk\` foreign key (\`user_id\`) references \`prefix_users\` (\`id\`) on delete restrict on update restrict"`,
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

      const statements = generator.compile([operation], mapper);
      expect(statements[1].sql).toMatchInlineSnapshot(
        `"create unique index \`idx_email_prefix_users\` on \`prefix_users\` (\`email\`)"`,
      );
    });
  });

  describe("preprocessing", () => {
    it("should wrap operations with FK checks disabled", () => {
      const operations: MigrationOperation[] = [
        {
          type: "create-table",
          name: "users",
          columns: [{ name: "id", type: "string", isNullable: false, role: "external-id" }],
        },
      ];

      const preprocessed = generator.preprocess(operations);
      expect(preprocessed.length).toBe(3);
      expect(preprocessed[0]).toEqual({ type: "custom", sql: "SET FOREIGN_KEY_CHECKS = 0" });
      expect(preprocessed[1]).toEqual(operations[0]);
      expect(preprocessed[2]).toEqual({ type: "custom", sql: "SET FOREIGN_KEY_CHECKS = 1" });
    });

    it("should return empty array for empty operations", () => {
      const preprocessed = generator.preprocess([]);
      expect(preprocessed).toHaveLength(0);
    });
  });

  describe("getDefaultValue", () => {
    it("should return undefined for TEXT column defaults", () => {
      const defaultValue = generator.getDefaultValue({
        name: "description",
        type: "string",
        isNullable: true,
        role: "regular",
        default: { value: "default text" },
      });

      expect(defaultValue).toBeUndefined();
    });

    it("should return literal value for non-TEXT columns", () => {
      const defaultValue = generator.getDefaultValue({
        name: "count",
        type: "integer",
        isNullable: false,
        role: "regular",
        default: { value: 42 },
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
