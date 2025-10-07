import { Kysely, PostgresDialect } from "kysely";
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

describe("execute() - PostgreSQL", () => {
  let db: KyselyAny;
  let config: KyselyConfig;

  beforeAll(async () => {
    // Create a Kysely instance with a PostgresDialect, but not actually connected to a database
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db = new Kysely({ dialect: new PostgresDialect({} as any) });
    config = { db, provider: "postgresql" };
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
            role: "id",
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
        `"create table "users" ("id" integer not null primary key, "name" text not null, "email" text not null)"`,
      );
    });

    it("should generate SQL for able with id column with default undefined", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "users",
        columns: [
          {
            name: "id",
            type: "varchar(30)",
            isNullable: false,
            role: "id",
            default: { value: undefined, runtime: "auto" },
          },
        ],
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"create table "users" ("id" varchar(30) not null primary key)"`,
      );
    });

    it("should generate SQL for table with various column types", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "test_types",
        columns: [
          { name: "col_int", type: "integer", isNullable: false, role: "id" },
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
        `"create table "test_types" ("col_int" integer not null primary key, "col_bigint" bigint not null, "col_decimal" decimal not null, "col_bool" boolean not null, "col_date" date not null, "col_timestamp" timestamp not null, "col_json" json not null, "col_binary" bytea not null, "col_varchar" varchar(255) not null)"`,
      );
    });

    it("should generate SQL for table with nullable columns", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "nullable_test",
        columns: [
          { name: "id", type: "integer", isNullable: false, role: "id" },
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
        `"create table "nullable_test" ("id" integer not null primary key, "optional_name" text, "optional_age" integer)"`,
      );
    });

    it("should generate SQL for table with default values", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "defaults_test",
        columns: [
          { name: "id", type: "integer", isNullable: false, role: "id" },
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
        `"create table "defaults_test" ("id" integer not null primary key, "status" text default 'pending' not null, "count" integer default 0 not null, "is_active" boolean default true not null)"`,
      );
    });

    it("should generate SQL for table with timestamp default to CURRENT_TIMESTAMP", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "timestamps_test",
        columns: [
          { name: "id", type: "integer", isNullable: false, role: "id" },
          {
            name: "created_at",
            type: "timestamp",
            isNullable: false,
            role: "regular",
            default: { runtime: "now" },
          },
        ],
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"create table "timestamps_test" ("id" integer not null primary key, "created_at" timestamp default CURRENT_TIMESTAMP not null)"`,
      );
    });

    it("should generate SQL for table with reference column", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "posts",
        columns: [
          { name: "id", type: "integer", isNullable: false, role: "id" },
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
        `"create table "posts" ("id" integer not null primary key, "user_id" integer not null, "title" text not null)"`,
      );
    });
  });

  describe("rename-table", () => {
    it("should generate SQL for PostgreSQL rename", () => {
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
    it("should generate SQL to update column data type (PostgreSQL uses USING clause)", () => {
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
        `"ALTER TABLE "test_table" ALTER COLUMN "test_col" TYPE integer USING ("test_col"::integer)"`,
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
        `"alter table "test_table" alter column "test_col" set not null"`,
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
        `"alter table "test_table" alter column "test_col" drop not null"`,
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
        `"alter table "test_table" alter column "test_col" set default 'default_value'"`,
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
        `"alter table "test_table" alter column "test_col" drop default"`,
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

      expect(results).toHaveLength(3);
      expect(results[0].compile().sql).toMatchInlineSnapshot(
        `"ALTER TABLE "test_table" ALTER COLUMN "test_col" TYPE integer USING ("test_col"::integer)"`,
      );
      expect(results[1].compile().sql).toMatchInlineSnapshot(
        `"alter table "test_table" alter column "test_col" set not null"`,
      );
      expect(results[2].compile().sql).toMatchInlineSnapshot(
        `"alter table "test_table" alter column "test_col" set default 0"`,
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
              role: "id",
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
              default: { runtime: "now" },
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
        `"alter table "test_table" alter column "updated_at" set default CURRENT_TIMESTAMP"`,
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
        `"alter table "posts" add constraint "posts_user_id_fk" foreign key ("user_id") references "users" ("id") on delete restrict on update restrict"`,
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
        `"alter table "posts" add constraint "posts_user_fk" foreign key ("org_id", "user_id") references "users" ("org_id", "user_id") on delete restrict on update restrict"`,
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
        `"alter table "posts" drop constraint if exists "posts_user_id_fk""`,
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
            { name: "id", type: "integer", isNullable: false, role: "id" },
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
        `"create table "users" ("id" integer not null primary key, "email" text not null, "name" text not null)"`,
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
            { name: "id", type: "integer", isNullable: false, role: "id" },
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
        `"create table "posts" ("id" integer not null primary key, "user_id" integer not null, "title" text not null, "content" text not null)"`,
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
        `"alter table "posts" add constraint "posts_user_id_fk" foreign key ("user_id") references "users" ("id") on delete restrict on update restrict"`,
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
        `"alter table "posts" add column "published" boolean default false not null"`,
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
        columns: [{ name: "id", type: "integer", isNullable: false, role: "id" }],
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
          { name: "id", type: "integer", isNullable: false, role: "id" },
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
          { name: "id", type: "integer", isNullable: false, role: "id" },
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
        `"create table "test" ("id" integer not null primary key, "status" text default 'it''s pending' not null)"`,
      );
    });
  });

  describe("real-world complex scenarios", () => {
    it("should handle complete blog schema migration with auto-increment IDs", () => {
      // 1. Create users table with auto-increment ID
      const createUsers = execute(
        {
          type: "create-table",
          name: "users",
          columns: [
            {
              name: "id",
              type: "integer",
              isNullable: false,
              role: "id",
              default: { runtime: "auto" },
            },
            {
              name: "name",
              type: "string",
              isNullable: false,
              role: "regular",
            },
          ],
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(createUsers);
      expect(createUsers.compile().sql).toMatchInlineSnapshot(
        `"create table "users" ("id" integer not null primary key, "name" text not null)"`,
      );

      // 2. Create posts table with auto-increment ID and reference
      const createPosts = execute(
        {
          type: "create-table",
          name: "posts",
          columns: [
            {
              name: "id",
              type: "integer",
              isNullable: false,
              role: "id",
              default: { runtime: "auto" },
            },
            {
              name: "title",
              type: "string",
              isNullable: false,
              role: "regular",
            },
            {
              name: "content",
              type: "string",
              isNullable: false,
              role: "regular",
            },
            {
              name: "userId",
              type: "integer",
              isNullable: false,
              role: "reference",
            },
          ],
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(createPosts);
      expect(createPosts.compile().sql).toMatchInlineSnapshot(
        `"create table "posts" ("id" integer not null primary key, "title" text not null, "content" text not null, "userId" integer not null)"`,
      );

      // 3. Add foreign key reference
      const addReference = execute(
        {
          type: "add-foreign-key",
          table: "posts",
          value: {
            name: "posts_userId_fk",
            columns: ["userId"],
            referencedTable: "users",
            referencedColumns: ["id"],
          },
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(addReference);
      expect(addReference.compile().sql).toMatchInlineSnapshot(
        `"alter table "posts" add constraint "posts_userId_fk" foreign key ("userId") references "users" ("id") on delete restrict on update restrict"`,
      );

      // 4. Alter posts table to add nullable summary column
      const alterPosts = execute(
        {
          type: "alter-table",
          name: "posts",
          value: [
            {
              type: "create-column",
              value: {
                name: "summary",
                type: "string",
                isNullable: true,
                role: "regular",
              },
            },
          ],
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      if (!Array.isArray(alterPosts)) {
        throw new Error("Expected array of results");
      }

      expect(alterPosts).toHaveLength(1);
      expect(alterPosts[0].compile().sql).toMatchInlineSnapshot(
        `"alter table "posts" add column "summary" text"`,
      );

      // 5. Create index on title
      const createIndex = execute(
        {
          type: "add-index",
          table: "posts",
          columns: ["title"],
          name: "idx_title",
          unique: false,
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(createIndex);
      expect(createIndex.compile().sql).toMatchInlineSnapshot(
        `"create index "idx_title" on "posts" ("title")"`,
      );
    });

    it("should handle e-commerce schema with complex relationships", () => {
      // 1. Create customers table
      const createCustomers = execute(
        {
          type: "create-table",
          name: "customers",
          columns: [
            {
              name: "id",
              type: "integer",
              isNullable: false,
              role: "id",
              default: { runtime: "auto" },
            },
            {
              name: "email",
              type: "string",
              isNullable: false,
              role: "regular",
            },
            {
              name: "firstName",
              type: "string",
              isNullable: false,
              role: "regular",
            },
            {
              name: "lastName",
              type: "string",
              isNullable: false,
              role: "regular",
            },
            {
              name: "phone",
              type: "string",
              isNullable: true,
              role: "regular",
            },
            {
              name: "createdAt",
              type: "timestamp",
              isNullable: false,
              role: "regular",
              default: { runtime: "now" },
            },
          ],
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(createCustomers);
      expect(createCustomers.compile().sql).toMatchInlineSnapshot(
        `"create table "customers" ("id" integer not null primary key, "email" text not null, "firstName" text not null, "lastName" text not null, "phone" text, "createdAt" timestamp default CURRENT_TIMESTAMP not null)"`,
      );

      // 2. Create products table
      const createProducts = execute(
        {
          type: "create-table",
          name: "products",
          columns: [
            {
              name: "id",
              type: "integer",
              isNullable: false,
              role: "id",
              default: { runtime: "auto" },
            },
            {
              name: "name",
              type: "string",
              isNullable: false,
              role: "regular",
            },
            {
              name: "description",
              type: "string",
              isNullable: true,
              role: "regular",
            },
            {
              name: "price",
              type: "decimal",
              isNullable: false,
              role: "regular",
            },
            {
              name: "stock",
              type: "integer",
              isNullable: false,
              role: "regular",
              default: { value: 0 },
            },
            {
              name: "isActive",
              type: "bool",
              isNullable: false,
              role: "regular",
              default: { value: true },
            },
          ],
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(createProducts);
      expect(createProducts.compile().sql).toMatchInlineSnapshot(
        `"create table "products" ("id" integer not null primary key, "name" text not null, "description" text, "price" decimal not null, "stock" integer default 0 not null, "isActive" boolean default true not null)"`,
      );

      // 3. Create orders table
      const createOrders = execute(
        {
          type: "create-table",
          name: "orders",
          columns: [
            {
              name: "id",
              type: "integer",
              isNullable: false,
              role: "id",
              default: { runtime: "auto" },
            },
            {
              name: "customerId",
              type: "integer",
              isNullable: false,
              role: "reference",
            },
            {
              name: "status",
              type: "string",
              isNullable: false,
              role: "regular",
              default: { value: "pending" },
            },
            {
              name: "total",
              type: "decimal",
              isNullable: false,
              role: "regular",
            },
            {
              name: "orderDate",
              type: "timestamp",
              isNullable: false,
              role: "regular",
              default: { runtime: "now" },
            },
          ],
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(createOrders);
      expect(createOrders.compile().sql).toMatchInlineSnapshot(
        `"create table "orders" ("id" integer not null primary key, "customerId" integer not null, "status" text default 'pending' not null, "total" decimal not null, "orderDate" timestamp default CURRENT_TIMESTAMP not null)"`,
      );

      // 4. Create order_items table (junction table)
      const createOrderItems = execute(
        {
          type: "create-table",
          name: "order_items",
          columns: [
            {
              name: "id",
              type: "integer",
              isNullable: false,
              role: "id",
              default: { runtime: "auto" },
            },
            {
              name: "orderId",
              type: "integer",
              isNullable: false,
              role: "reference",
            },
            {
              name: "productId",
              type: "integer",
              isNullable: false,
              role: "reference",
            },
            {
              name: "quantity",
              type: "integer",
              isNullable: false,
              role: "regular",
            },
            {
              name: "unitPrice",
              type: "decimal",
              isNullable: false,
              role: "regular",
            },
          ],
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(createOrderItems);
      expect(createOrderItems.compile().sql).toMatchInlineSnapshot(
        `"create table "order_items" ("id" integer not null primary key, "orderId" integer not null, "productId" integer not null, "quantity" integer not null, "unitPrice" decimal not null)"`,
      );

      // 5. Add all foreign key constraints
      const addCustomerFk = execute(
        {
          type: "add-foreign-key",
          table: "orders",
          value: {
            name: "orders_customerId_fk",
            columns: ["customerId"],
            referencedTable: "customers",
            referencedColumns: ["id"],
          },
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(addCustomerFk);
      expect(addCustomerFk.compile().sql).toMatchInlineSnapshot(
        `"alter table "orders" add constraint "orders_customerId_fk" foreign key ("customerId") references "customers" ("id") on delete restrict on update restrict"`,
      );

      const addOrderFk = execute(
        {
          type: "add-foreign-key",
          table: "order_items",
          value: {
            name: "order_items_orderId_fk",
            columns: ["orderId"],
            referencedTable: "orders",
            referencedColumns: ["id"],
          },
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(addOrderFk);
      expect(addOrderFk.compile().sql).toMatchInlineSnapshot(
        `"alter table "order_items" add constraint "order_items_orderId_fk" foreign key ("orderId") references "orders" ("id") on delete restrict on update restrict"`,
      );

      const addProductFk = execute(
        {
          type: "add-foreign-key",
          table: "order_items",
          value: {
            name: "order_items_productId_fk",
            columns: ["productId"],
            referencedTable: "products",
            referencedColumns: ["id"],
          },
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(addProductFk);
      expect(addProductFk.compile().sql).toMatchInlineSnapshot(
        `"alter table "order_items" add constraint "order_items_productId_fk" foreign key ("productId") references "products" ("id") on delete restrict on update restrict"`,
      );

      // 6. Create indexes for performance
      const createEmailIndex = execute(
        {
          type: "add-index",
          table: "customers",
          columns: ["email"],
          name: "idx_customers_email",
          unique: true,
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(createEmailIndex);
      expect(createEmailIndex.compile().sql).toMatchInlineSnapshot(
        `"create unique index "idx_customers_email" on "customers" ("email")"`,
      );

      const createOrderStatusIndex = execute(
        {
          type: "add-index",
          table: "orders",
          columns: ["status", "orderDate"],
          name: "idx_orders_status_date",
          unique: false,
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(createOrderStatusIndex);
      expect(createOrderStatusIndex.compile().sql).toMatchInlineSnapshot(
        `"create index "idx_orders_status_date" on "orders" ("status", "orderDate")"`,
      );
    });

    it("should handle schema evolution with complex column updates", () => {
      // 1. Create initial users table
      const createUsers = execute(
        {
          type: "create-table",
          name: "users",
          columns: [
            {
              name: "id",
              type: "integer",
              isNullable: false,
              role: "id",
              default: { runtime: "auto" },
            },
            {
              name: "username",
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
            {
              name: "age",
              type: "integer",
              isNullable: true,
              role: "regular",
            },
          ],
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(createUsers);
      expect(createUsers.compile().sql).toMatchInlineSnapshot(
        `"create table "users" ("id" integer not null primary key, "username" text not null, "email" text not null, "age" integer)"`,
      );

      // 2. Complex alter table with multiple operations
      const alterUsers = execute(
        {
          type: "alter-table",
          name: "users",
          value: [
            // Add new columns
            {
              type: "create-column",
              value: {
                name: "firstName",
                type: "string",
                isNullable: true,
                role: "regular",
              },
            },
            {
              type: "create-column",
              value: {
                name: "lastName",
                type: "string",
                isNullable: true,
                role: "regular",
              },
            },
            {
              type: "create-column",
              value: {
                name: "birthDate",
                type: "date",
                isNullable: true,
                role: "regular",
              },
            },
            {
              type: "create-column",
              value: {
                name: "isVerified",
                type: "bool",
                isNullable: false,
                role: "regular",
                default: { value: false },
              },
            },
            // Rename column
            {
              type: "rename-column",
              from: "username",
              to: "displayName",
            },
            // Update column (change age to be NOT NULL with default)
            {
              type: "update-column",
              name: "age",
              value: {
                name: "age",
                type: "integer",
                isNullable: false,
                role: "regular",
                default: { value: 0 },
              },
              updateDataType: false,
              updateNullable: true,
              updateDefault: true,
            },
          ],
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      if (!Array.isArray(alterUsers)) {
        throw new Error("Expected array of results");
      }

      expect(alterUsers).toHaveLength(7);
      expect(alterUsers[0].compile().sql).toMatchInlineSnapshot(
        `"alter table "users" add column "firstName" text"`,
      );
      expect(alterUsers[1].compile().sql).toMatchInlineSnapshot(
        `"alter table "users" add column "lastName" text"`,
      );
      expect(alterUsers[2].compile().sql).toMatchInlineSnapshot(
        `"alter table "users" add column "birthDate" date"`,
      );
      expect(alterUsers[3].compile().sql).toMatchInlineSnapshot(
        `"alter table "users" add column "isVerified" boolean default false not null"`,
      );
      expect(alterUsers[4].compile().sql).toMatchInlineSnapshot(
        `"alter table "users" rename column "username" to "displayName""`,
      );
      expect(alterUsers[5].compile().sql).toMatchInlineSnapshot(
        `"alter table "users" alter column "age" set not null"`,
      );
      expect(alterUsers[6].compile().sql).toMatchInlineSnapshot(
        `"alter table "users" alter column "age" set default 0"`,
      );

      // 3. Create indexes after schema changes
      const createIndexes = execute(
        {
          type: "add-index",
          table: "users",
          columns: ["email"],
          name: "idx_users_email",
          unique: true,
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(createIndexes);
      expect(createIndexes.compile().sql).toMatchInlineSnapshot(
        `"create unique index "idx_users_email" on "users" ("email")"`,
      );

      const createCompositeIndex = execute(
        {
          type: "add-index",
          table: "users",
          columns: ["firstName", "lastName"],
          name: "idx_users_name",
          unique: false,
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(createCompositeIndex);
      expect(createCompositeIndex.compile().sql).toMatchInlineSnapshot(
        `"create index "idx_users_name" on "users" ("firstName", "lastName")"`,
      );
    });

    it("should handle content management system schema", () => {
      // 1. Create categories table
      const createCategories = execute(
        {
          type: "create-table",
          name: "categories",
          columns: [
            {
              name: "id",
              type: "integer",
              isNullable: false,
              role: "id",
              default: { runtime: "auto" },
            },
            {
              name: "name",
              type: "string",
              isNullable: false,
              role: "regular",
            },
            {
              name: "slug",
              type: "string",
              isNullable: false,
              role: "regular",
            },
            {
              name: "description",
              type: "string",
              isNullable: true,
              role: "regular",
            },
            {
              name: "parentId",
              type: "integer",
              isNullable: true,
              role: "reference",
            },
            {
              name: "isActive",
              type: "bool",
              isNullable: false,
              role: "regular",
              default: { value: true },
            },
            {
              name: "createdAt",
              type: "timestamp",
              isNullable: false,
              role: "regular",
              default: { runtime: "now" },
            },
            {
              name: "updatedAt",
              type: "timestamp",
              isNullable: false,
              role: "regular",
              default: { runtime: "now" },
            },
          ],
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(createCategories);
      expect(createCategories.compile().sql).toMatchInlineSnapshot(
        `"create table "categories" ("id" integer not null primary key, "name" text not null, "slug" text not null, "description" text, "parentId" integer, "isActive" boolean default true not null, "createdAt" timestamp default CURRENT_TIMESTAMP not null, "updatedAt" timestamp default CURRENT_TIMESTAMP not null)"`,
      );

      // 2. Create articles table
      const createArticles = execute(
        {
          type: "create-table",
          name: "articles",
          columns: [
            {
              name: "id",
              type: "integer",
              isNullable: false,
              role: "id",
              default: { runtime: "auto" },
            },
            {
              name: "title",
              type: "string",
              isNullable: false,
              role: "regular",
            },
            {
              name: "slug",
              type: "string",
              isNullable: false,
              role: "regular",
            },
            {
              name: "excerpt",
              type: "string",
              isNullable: true,
              role: "regular",
            },
            {
              name: "content",
              type: "string",
              isNullable: false,
              role: "regular",
            },
            {
              name: "categoryId",
              type: "integer",
              isNullable: false,
              role: "reference",
            },
            {
              name: "authorId",
              type: "integer",
              isNullable: false,
              role: "reference",
            },
            {
              name: "status",
              type: "string",
              isNullable: false,
              role: "regular",
              default: { value: "draft" },
            },
            {
              name: "publishedAt",
              type: "timestamp",
              isNullable: true,
              role: "regular",
            },
            {
              name: "viewCount",
              type: "integer",
              isNullable: false,
              role: "regular",
              default: { value: 0 },
            },
            {
              name: "createdAt",
              type: "timestamp",
              isNullable: false,
              role: "regular",
              default: { runtime: "now" },
            },
            {
              name: "updatedAt",
              type: "timestamp",
              isNullable: false,
              role: "regular",
              default: { runtime: "now" },
            },
          ],
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(createArticles);
      expect(createArticles.compile().sql).toMatchInlineSnapshot(
        `"create table "articles" ("id" integer not null primary key, "title" text not null, "slug" text not null, "excerpt" text, "content" text not null, "categoryId" integer not null, "authorId" integer not null, "status" text default 'draft' not null, "publishedAt" timestamp, "viewCount" integer default 0 not null, "createdAt" timestamp default CURRENT_TIMESTAMP not null, "updatedAt" timestamp default CURRENT_TIMESTAMP not null)"`,
      );

      // 3. Create tags table
      const createTags = execute(
        {
          type: "create-table",
          name: "tags",
          columns: [
            {
              name: "id",
              type: "integer",
              isNullable: false,
              role: "id",
              default: { runtime: "auto" },
            },
            {
              name: "name",
              type: "string",
              isNullable: false,
              role: "regular",
            },
            {
              name: "slug",
              type: "string",
              isNullable: false,
              role: "regular",
            },
            {
              name: "color",
              type: "string",
              isNullable: true,
              role: "regular",
              default: { value: "#000000" },
            },
          ],
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(createTags);
      expect(createTags.compile().sql).toMatchInlineSnapshot(
        `"create table "tags" ("id" integer not null primary key, "name" text not null, "slug" text not null, "color" text default '#000000')"`,
      );

      // 4. Create article_tags junction table
      const createArticleTags = execute(
        {
          type: "create-table",
          name: "article_tags",
          columns: [
            {
              name: "articleId",
              type: "integer",
              isNullable: false,
              role: "reference",
            },
            {
              name: "tagId",
              type: "integer",
              isNullable: false,
              role: "reference",
            },
          ],
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(createArticleTags);
      expect(createArticleTags.compile().sql).toMatchInlineSnapshot(
        `"create table "article_tags" ("articleId" integer not null, "tagId" integer not null)"`,
      );

      // 5. Add all foreign key constraints
      const addCategorySelfRef = execute(
        {
          type: "add-foreign-key",
          table: "categories",
          value: {
            name: "categories_parentId_fk",
            columns: ["parentId"],
            referencedTable: "categories",
            referencedColumns: ["id"],
          },
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(addCategorySelfRef);
      expect(addCategorySelfRef.compile().sql).toMatchInlineSnapshot(
        `"alter table "categories" add constraint "categories_parentId_fk" foreign key ("parentId") references "categories" ("id") on delete restrict on update restrict"`,
      );

      const addArticleCategoryFk = execute(
        {
          type: "add-foreign-key",
          table: "articles",
          value: {
            name: "articles_categoryId_fk",
            columns: ["categoryId"],
            referencedTable: "categories",
            referencedColumns: ["id"],
          },
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(addArticleCategoryFk);
      expect(addArticleCategoryFk.compile().sql).toMatchInlineSnapshot(
        `"alter table "articles" add constraint "articles_categoryId_fk" foreign key ("categoryId") references "categories" ("id") on delete restrict on update restrict"`,
      );

      const addArticleTagFks = execute(
        {
          type: "add-foreign-key",
          table: "article_tags",
          value: {
            name: "article_tags_articleId_fk",
            columns: ["articleId"],
            referencedTable: "articles",
            referencedColumns: ["id"],
          },
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(addArticleTagFks);
      expect(addArticleTagFks.compile().sql).toMatchInlineSnapshot(
        `"alter table "article_tags" add constraint "article_tags_articleId_fk" foreign key ("articleId") references "articles" ("id") on delete restrict on update restrict"`,
      );

      const addTagFk = execute(
        {
          type: "add-foreign-key",
          table: "article_tags",
          value: {
            name: "article_tags_tagId_fk",
            columns: ["tagId"],
            referencedTable: "tags",
            referencedColumns: ["id"],
          },
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(addTagFk);
      expect(addTagFk.compile().sql).toMatchInlineSnapshot(
        `"alter table "article_tags" add constraint "article_tags_tagId_fk" foreign key ("tagId") references "tags" ("id") on delete restrict on update restrict"`,
      );

      // 6. Create comprehensive indexes
      const createSlugIndexes = execute(
        {
          type: "add-index",
          table: "categories",
          columns: ["slug"],
          name: "idx_categories_slug",
          unique: true,
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(createSlugIndexes);
      expect(createSlugIndexes.compile().sql).toMatchInlineSnapshot(
        `"create unique index "idx_categories_slug" on "categories" ("slug")"`,
      );

      const createArticleSlugIndex = execute(
        {
          type: "add-index",
          table: "articles",
          columns: ["slug"],
          name: "idx_articles_slug",
          unique: true,
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(createArticleSlugIndex);
      expect(createArticleSlugIndex.compile().sql).toMatchInlineSnapshot(
        `"create unique index "idx_articles_slug" on "articles" ("slug")"`,
      );

      const createArticleStatusIndex = execute(
        {
          type: "add-index",
          table: "articles",
          columns: ["status", "publishedAt"],
          name: "idx_articles_status_published",
          unique: false,
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(createArticleStatusIndex);
      expect(createArticleStatusIndex.compile().sql).toMatchInlineSnapshot(
        `"create index "idx_articles_status_published" on "articles" ("status", "publishedAt")"`,
      );

      const createTagSlugIndex = execute(
        {
          type: "add-index",
          table: "tags",
          columns: ["slug"],
          name: "idx_tags_slug",
          unique: true,
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(createTagSlugIndex);
      expect(createTagSlugIndex.compile().sql).toMatchInlineSnapshot(
        `"create unique index "idx_tags_slug" on "tags" ("slug")"`,
      );

      const createArticleTagCompositeIndex = execute(
        {
          type: "add-index",
          table: "article_tags",
          columns: ["articleId", "tagId"],
          name: "idx_article_tags_composite",
          unique: true,
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(createArticleTagCompositeIndex);
      expect(createArticleTagCompositeIndex.compile().sql).toMatchInlineSnapshot(
        `"create unique index "idx_article_tags_composite" on "article_tags" ("articleId", "tagId")"`,
      );
    });
  });
});

describe("execute() - CockroachDB", () => {
  let db: KyselyAny;
  let config: KyselyConfig;

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db = new Kysely({ dialect: new PostgresDialect({} as any) });
    config = { db, provider: "cockroachdb" };
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
            role: "id",
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
        `"create table "users" ("id" integer not null primary key, "name" text not null, "email" text not null)"`,
      );
    });

    it("should generate SQL for table with various column types", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "test_types",
        columns: [
          { name: "col_int", type: "integer", isNullable: false, role: "id" },
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
        `"create table "test_types" ("col_int" integer not null primary key, "col_bigint" bigint not null, "col_decimal" decimal not null, "col_bool" boolean not null, "col_date" date not null, "col_timestamp" timestamp not null, "col_json" json not null, "col_binary" bytea not null, "col_varchar" varchar(255) not null)"`,
      );
    });

    it("should generate SQL for table with default values", () => {
      const operation: MigrationOperation = {
        type: "create-table",
        name: "defaults_test",
        columns: [
          { name: "id", type: "integer", isNullable: false, role: "id" },
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
        `"create table "defaults_test" ("id" integer not null primary key, "status" text default 'pending' not null, "count" integer default 0 not null, "is_active" boolean default true not null)"`,
      );
    });
  });

  describe("alter-table - update-column", () => {
    it("should generate SQL to update column data type (CockroachDB uses USING clause like PostgreSQL)", () => {
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
        `"ALTER TABLE "test_table" ALTER COLUMN "test_col" TYPE integer USING ("test_col"::integer)"`,
      );
    });
  });

  describe("drop-index", () => {
    it("should generate SQL to drop index with CASCADE (CockroachDB specific)", () => {
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
      expect(compiled.sql).toMatchInlineSnapshot(`"drop index if exists "idx_email" cascade"`);
    });

    it("should generate SQL to drop unique index with CASCADE", () => {
      const operation: MigrationOperation = {
        type: "drop-index",
        table: "test_table",
        name: "idx_unique_email",
      };

      const result = execute(operation, config, () => {
        throw new Error("No custom operations");
      });

      assertSingleResult(result);

      const compiled = result.compile();
      expect(compiled.sql).toMatchInlineSnapshot(
        `"drop index if exists "idx_unique_email" cascade"`,
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
        `"alter table "posts" add constraint "posts_user_id_fk" foreign key ("user_id") references "users" ("id") on delete restrict on update restrict"`,
      );
    });
  });

  describe("rename-table", () => {
    it("should generate SQL for CockroachDB rename (same as PostgreSQL)", () => {
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

  describe("complex migration scenarios", () => {
    it("should generate correct SQL for full schema migration", () => {
      // 1. Create users table
      const createUsers = execute(
        {
          type: "create-table",
          name: "users",
          columns: [
            { name: "id", type: "integer", isNullable: false, role: "id" },
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
        `"create table "users" ("id" integer not null primary key, "email" text not null, "name" text not null)"`,
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
            { name: "id", type: "integer", isNullable: false, role: "id" },
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
        `"create table "posts" ("id" integer not null primary key, "user_id" integer not null, "title" text not null, "content" text not null)"`,
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
        `"alter table "posts" add constraint "posts_user_id_fk" foreign key ("user_id") references "users" ("id") on delete restrict on update restrict"`,
      );

      // 5. Drop index with CASCADE (CockroachDB specific)
      const dropIndex = execute(
        {
          type: "drop-index",
          table: "users",
          name: "idx_unique_email",
        },
        config,
        () => {
          throw new Error("No custom operations");
        },
      );

      assertSingleResult(dropIndex);

      expect(dropIndex.compile().sql).toMatchInlineSnapshot(
        `"drop index if exists "idx_unique_email" cascade"`,
      );
    });
  });
});
