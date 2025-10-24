import { Kysely, MysqlDialect } from "kysely";
import { describe, expect, it, beforeAll } from "vitest";
import { execute } from "./execute";
import type { MigrationOperation } from "../../../migration-engine/shared";
import type { KyselyConfig } from "../kysely-adapter";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KyselyAny = Kysely<any>;

function assertSingleResult<T>(result: T | T[]): asserts result is T {
  if (Array.isArray(result)) {
    throw new Error("Expected single result, got array");
  }
}

describe("execute() - MySQL", () => {
  let db: KyselyAny;
  let config: KyselyConfig;

  beforeAll(async () => {
    // Create a Kysely instance with a MysqlDialect, but not actually connected to a database
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db = new Kysely({ dialect: new MysqlDialect({} as any) });
    config = { db, provider: "mysql" };
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

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"create table \`test_types\` (\`col_int\` integer not null unique, \`col_bigint\` bigint not null, \`col_decimal\` decimal not null, \`col_bool\` boolean not null, \`col_date\` date not null, \`col_timestamp\` timestamp not null, \`col_json\` json not null, \`col_binary\` longblob not null, \`col_varchar\` varchar(255) not null)"`,
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

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
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

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"create table \`timestamps_test\` (\`id\` integer not null unique, \`created_at\` timestamp default CURRENT_TIMESTAMP not null)"`,
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
        `"create table \`posts\` (\`id\` integer not null unique, \`user_id\` integer not null, \`title\` text not null)"`,
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

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"alter table \`old_name\` rename to \`new_name\`"`,
      );
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
      expect(compiled.sql).toMatchInlineSnapshot(`"drop table \`to_drop\`"`);
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

      const results = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      if (!Array.isArray(results)) {
        throw new Error("Expected array of results");
      }

      expect(results).toHaveLength(2);
      expect(results[0].compile().sql).toMatchInlineSnapshot(
        `"alter table \`test_table\` add column \`col1\` text"`,
      );
      expect(results[1].compile().sql).toMatchInlineSnapshot(
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

      const results = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      if (!Array.isArray(results)) {
        throw new Error("Expected array of results");
      }

      expect(results).toHaveLength(1);
      const compiled = results[0].compile();
      expect(compiled.sql).toMatchInlineSnapshot(
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

      const results = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      if (!Array.isArray(results)) {
        throw new Error("Expected array of results");
      }

      expect(results).toHaveLength(1);
      const compiled = results[0].compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"alter table \`test_table\` drop column \`to_drop\`"`,
      );
    });
  });

  describe("alter-table - update-column", () => {
    it("should generate SQL to update column data type (MySQL doesn't use USING clause)", () => {
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

      const results = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      if (!Array.isArray(results)) {
        throw new Error("Expected array of results");
      }

      expect(results).toHaveLength(1);
      const compiled = results[0].compile();
      expect(compiled.sql).toMatchInlineSnapshot(
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

      const results = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      if (!Array.isArray(results)) {
        throw new Error("Expected array of results");
      }

      expect(results).toHaveLength(1);
      const compiled = results[0].compile();
      expect(compiled.sql).toMatchInlineSnapshot(
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

      const results = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      if (!Array.isArray(results)) {
        throw new Error("Expected array of results");
      }

      expect(results).toHaveLength(1);
      const compiled = results[0].compile();
      expect(compiled.sql).toMatchInlineSnapshot(
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

      const results = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      if (!Array.isArray(results)) {
        throw new Error("Expected array of results");
      }

      expect(results).toHaveLength(1);
      const compiled = results[0].compile();
      expect(compiled.sql).toMatchInlineSnapshot(
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

      const results = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      if (!Array.isArray(results)) {
        throw new Error("Expected array of results");
      }

      expect(results).toHaveLength(1);
      const compiled = results[0].compile();
      expect(compiled.sql).toMatchInlineSnapshot(
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

      const results = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      if (!Array.isArray(results)) {
        throw new Error("Expected array of results");
      }

      expect(results).toHaveLength(1);
      expect(results[0].compile().sql).toMatchInlineSnapshot(
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

      expect(() => {
        execute(operation, config, () => {
          throw new Error("No custom operations");
        });
      }).toThrow(
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

      const results = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      if (!Array.isArray(results)) {
        throw new Error("Expected array of results");
      }

      // No-op should return empty array
      expect(results).toHaveLength(0);
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

      const results = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      if (!Array.isArray(results)) {
        throw new Error("Expected array of results");
      }

      expect(results).toHaveLength(1);
      const compiled = results[0].compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"alter table \`test_table\` modify column \`updated_at\` timestamp default CURRENT_TIMESTAMP not null"`,
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

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
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

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
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

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
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

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
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

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
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

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
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

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
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

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(`"drop index if exists \`idx_email\`"`);
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
        `"create table \`users\` (\`id\` integer not null unique, \`email\` text not null, \`name\` text not null)"`,
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
        `"create unique index \`idx_unique_email\` on \`users\` (\`email\`)"`,
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
        `"create table \`posts\` (\`id\` integer not null unique, \`user_id\` integer not null, \`title\` text not null, \`content\` text not null)"`,
      );

      // 4. Add foreign key
      const addFk = execute(
        {
          type: "add-foreign-key",
          table: "posts",
          value: {
            name: "posts_user_id_fk",
            columns: ["user_id"],
            referencedTable: "users",
            referencedColumns: ["id"],
          },
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(addFk);

      expect(addFk.compile().sql).toMatchInlineSnapshot(
        `"alter table \`posts\` add constraint \`posts_user_id_fk\` foreign key (\`user_id\`) references \`users\` (\`id\`) on delete restrict on update restrict"`,
      );

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
        `"alter table \`posts\` add column \`published\` boolean default false not null"`,
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
        `"alter table \`users\` add column \`age\` integer"`,
      );
      expect(results[1].compile().sql).toMatchInlineSnapshot(
        `"alter table \`users\` rename column \`name\` to \`full_name\`"`,
      );
      expect(results[2].compile().sql).toMatchInlineSnapshot(
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

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toContain("`user-profiles`");
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
      expect(compiled.sql).toContain("`user-name`");
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
        `"create table \`test\` (\`id\` integer not null unique, \`status\` text not null)"`,
      );
    });
  });
});
