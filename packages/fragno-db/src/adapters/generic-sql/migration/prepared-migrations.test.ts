import { describe, expect, test } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../../../schema/create";
import { createColdKysely } from "./cold-kysely";
import { SQLiteSQLGenerator } from "./dialect/sqlite";
import { PostgresSQLGenerator } from "./dialect/postgres";
import { MySQLSQLGenerator } from "./dialect/mysql";
import { createPreparedMigrations } from "./prepared-migrations";
import {
  createNamingResolver,
  schemaNamingStrategy,
  suffixNamingStrategy,
  type SqlNamingStrategy,
} from "../../../naming/sql-naming";

const testSchema = schema("test", (s) => {
  return s
    .addTable("users", (t) => {
      return t.addColumn("id", idColumn()).addColumn("name", column("string"));
    })
    .alterTable("users", (t) => {
      return t
        .addColumn("age", column("integer").nullable())
        .createIndex("name_idx", ["name"])
        .createIndex("age_idx", ["age"]);
    })
    .addTable("posts", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("title", column("string"))
        .addColumn("authorId", referenceColumn());
    })
    .addReference("author", {
      type: "one",
      from: { table: "posts", column: "authorId" },
      to: { table: "users", column: "id" },
    });
});

const nullableSchema = schema("nullable", (s) => {
  return s
    .addTable("users", (t) => {
      return t.addColumn("id", idColumn()).addColumn("name", column("string"));
    })
    .alterTable("users", (t) => {
      return t.alterColumn("name").nullable();
    });
});

const resolver = createNamingResolver(testSchema, "test", suffixNamingStrategy);
const nullableResolver = createNamingResolver(nullableSchema, "nullable", suffixNamingStrategy);

describe("PreparedMigrations - PostgreSQL", () => {
  const coldKysely = createColdKysely("postgresql");
  const generator = new PostgresSQLGenerator(coldKysely, "postgresql");
  const resolver = createNamingResolver(testSchema, "test", suffixNamingStrategy);

  test("compile migration 0 -> 1 (create users table)", () => {
    const statements = generator.compile(
      [
        {
          type: "create-table",
          name: "users",
          columns: [
            { name: "id", type: "string", isNullable: false, role: "external-id" },
            { name: "name", type: "string", isNullable: false, role: "regular" },
            { name: "_internalId", type: "bigint", isNullable: false, role: "internal-id" },
            {
              name: "_version",
              type: "integer",
              isNullable: false,
              role: "version",
              default: { value: 0 },
            },
          ],
        },
      ],
      resolver,
    );

    expect(statements.length).toBe(1);
    expect(statements[0].sql).toMatchInlineSnapshot(
      `"create table "users_test" ("id" text not null unique, "name" text not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null)"`,
    );
  });

  test("compile alter table with add column", () => {
    const statements = generator.compile(
      [
        {
          type: "alter-table",
          name: "users",
          value: [
            {
              type: "create-column",
              value: { name: "age", type: "integer", isNullable: true, role: "regular" },
            },
          ],
        },
      ],
      resolver,
    );

    expect(statements.length).toBe(1);
    expect(statements[0].sql).toMatchInlineSnapshot(
      `"alter table "users_test" add column "age" integer"`,
    );
  });

  test("compile add index", () => {
    const statements = generator.compile(
      [
        {
          type: "add-index",
          table: "users",
          name: "name_idx",
          columns: ["name"],
          unique: false,
        },
      ],
      resolver,
    );

    expect(statements.length).toBe(1);
    expect(statements[0].sql).toMatchInlineSnapshot(
      `"create index "idx_users_name_idx_test_92db5054" on "users_test" ("name")"`,
    );
  });

  test("generate version update SQL for new migration", () => {
    const sql = generator.generateVersionUpdateSQL("test_namespace", 0, 1);

    expect(sql.sql).toMatchInlineSnapshot(
      `"insert into "fragno_db_settings" ("id", "key", "value") values ('jprP_43K5uMwxAFiepbbrQ', 'test_namespace.schema_version', '1')"`,
    );
  });

  test("generate version update SQL for existing migration", () => {
    const sql = generator.generateVersionUpdateSQL("test_namespace", 1, 2);

    expect(sql.sql).toMatchInlineSnapshot(
      `"update "fragno_db_settings" set "value" = '2' where "key" = 'test_namespace.schema_version'"`,
    );
  });

  test("compile uses custom naming strategy for columns and constraints", () => {
    const customStrategy: SqlNamingStrategy = {
      namespaceScope: "suffix",
      namespaceToSchema: (namespace) => namespace,
      tableName: (logicalTable, namespace) =>
        namespace ? `tbl_${logicalTable}_${namespace}` : `tbl_${logicalTable}`,
      columnName: (logicalColumn) => `col_${logicalColumn}`,
      indexName: (logicalIndex, _table, namespace) =>
        namespace ? `idx_custom_${logicalIndex}_${namespace}` : `idx_custom_${logicalIndex}`,
      uniqueIndexName: (logicalIndex, _table, namespace) =>
        namespace ? `uidx_custom_${logicalIndex}_${namespace}` : `uidx_custom_${logicalIndex}`,
      foreignKeyName: ({ referenceName, namespace }) =>
        namespace ? `fk_custom_${referenceName}_${namespace}` : `fk_custom_${referenceName}`,
    };
    const customResolver = createNamingResolver(testSchema, "custom", customStrategy);

    const statements = generator.compile(
      [
        {
          type: "create-table",
          name: "users",
          columns: [
            { name: "id", type: "string", isNullable: false, role: "external-id" },
            { name: "name", type: "string", isNullable: false, role: "regular" },
          ],
        },
        {
          type: "create-table",
          name: "posts",
          columns: [
            { name: "id", type: "string", isNullable: false, role: "external-id" },
            { name: "authorId", type: "bigint", isNullable: false, role: "reference" },
          ],
        },
        {
          type: "add-index",
          table: "users",
          name: "name_idx",
          columns: ["name"],
          unique: false,
        },
        {
          type: "add-foreign-key",
          table: "posts",
          value: {
            name: "author",
            columns: ["authorId"],
            referencedTable: "users",
            referencedColumns: ["_internalId"],
          },
        },
      ],
      customResolver,
    );

    const sql = statements.map((stmt) => stmt.sql).join("\\n");
    expect(sql).toContain(`create table "tbl_users_custom"`);
    expect(sql).toContain(`"col_name"`);
    expect(sql).toContain(`create index "idx_custom_name_idx_custom"`);
    expect(sql).toContain(`add constraint "fk_custom_author_custom"`);
  });

  test("compile uses schema naming strategy for schema-scoped namespaces", () => {
    const schemaResolver = createNamingResolver(testSchema, "tenant", schemaNamingStrategy);
    const statements = generator.compile(
      [
        {
          type: "create-table",
          name: "users",
          columns: [{ name: "id", type: "string", isNullable: false, role: "external-id" }],
        },
      ],
      schemaResolver,
    );

    const sql = statements.map((stmt) => stmt.sql).join("\\n");
    expect(sql).toContain(`CREATE SCHEMA IF NOT EXISTS "tenant"`);
    expect(sql).toContain(`create table "tenant"."users"`);
  });
});

describe("PreparedMigrations - SQLite FK Merging", () => {
  const coldKysely = createColdKysely("sqlite");
  const generator = new SQLiteSQLGenerator(coldKysely, "sqlite");
  const resolver = createNamingResolver(testSchema, "test", suffixNamingStrategy);

  test("preprocess merges FK into create-table", () => {
    const operations = generator.preprocess([
      {
        type: "create-table",
        name: "users",
        columns: [{ name: "id", type: "string", isNullable: false, role: "external-id" }],
      },
      {
        type: "create-table",
        name: "posts",
        columns: [
          { name: "id", type: "string", isNullable: false, role: "external-id" },
          { name: "authorId", type: "bigint", isNullable: false, role: "reference" },
        ],
      },
      {
        type: "add-foreign-key",
        table: "posts",
        value: {
          name: "posts_users_author_fk",
          columns: ["authorId"],
          referencedTable: "users",
          referencedColumns: ["_internalId"],
        },
      },
    ]);

    // FK should be merged into posts create-table, plus pragma statement
    expect(operations.length).toBe(3);
    expect(operations[0]).toEqual({ type: "custom", sql: "PRAGMA defer_foreign_keys = ON" });
    const postsOp = operations.find((op) => op.type === "create-table" && op.name === "posts");
    expect(postsOp).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((postsOp as any).metadata?.inlineForeignKeys).toHaveLength(1);
  });

  test("compile creates table with inline FK constraint", () => {
    const statements = generator.compile(
      [
        {
          type: "create-table",
          name: "users",
          columns: [{ name: "id", type: "string", isNullable: false, role: "external-id" }],
        },
        {
          type: "create-table",
          name: "posts",
          columns: [
            { name: "id", type: "string", isNullable: false, role: "external-id" },
            { name: "authorId", type: "bigint", isNullable: false, role: "reference" },
          ],
        },
        {
          type: "add-foreign-key",
          table: "posts",
          value: {
            name: "posts_users_author_fk",
            columns: ["authorId"],
            referencedTable: "users",
            referencedColumns: ["_internalId"],
          },
        },
      ],
      resolver,
    );

    expect(statements.length).toBe(3);
    expect(statements[0].sql).toMatchInlineSnapshot(`"PRAGMA defer_foreign_keys = ON"`);
    expect(statements[1].sql).toMatchInlineSnapshot(
      `"create table "users_test" ("id" text not null unique)"`,
    );
    expect(statements[2].sql).toMatchInlineSnapshot(
      `"create table "posts_test" ("id" text not null unique, "authorId" integer not null, foreign key ("authorId") references "users_test" ("_internalId") on delete restrict on update restrict)"`,
    );
  });

  test("throws error for add-foreign-key on existing table", () => {
    expect(() =>
      generator.compile(
        [
          {
            type: "add-foreign-key",
            table: "posts",
            value: {
              name: "posts_users_fk",
              columns: ["authorId"],
              referencedTable: "users",
              referencedColumns: ["_internalId"],
            },
          },
        ],
        undefined,
      ),
    ).toThrow("SQLite doesn't support modifying foreign keys");
  });

  test("uses autoIncrement for internal-id columns", () => {
    const statements = generator.compile(
      [
        {
          type: "create-table",
          name: "users",
          columns: [
            { name: "_internalId", type: "integer", isNullable: false, role: "internal-id" },
          ],
        },
      ],
      undefined,
    );

    expect(statements[0].sql).toMatchInlineSnapshot(`"PRAGMA defer_foreign_keys = ON"`);
    expect(statements[1].sql).toMatchInlineSnapshot(
      `"create table "users" ("_internalId" integer not null primary key autoincrement)"`,
    );
  });
});

describe("PreparedMigrations - MySQL", () => {
  const coldKysely = createColdKysely("mysql");
  const generator = new MySQLSQLGenerator(coldKysely, "mysql");

  test("preprocess wraps with FK checks disabled", () => {
    const operations = generator.preprocess([
      {
        type: "create-table",
        name: "users",
        columns: [{ name: "id", type: "string", isNullable: false, role: "external-id" }],
      },
    ]);

    expect(operations.length).toBe(3);
    expect(operations[0].type).toBe("custom");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((operations[0] as any).sql).toBe("SET FOREIGN_KEY_CHECKS = 0");
    expect(operations[1].type).toBe("create-table");
    expect(operations[2].type).toBe("custom");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((operations[2] as any).sql).toBe("SET FOREIGN_KEY_CHECKS = 1");
  });

  test("uses autoIncrement for internal-id columns", () => {
    const statements = generator.compile(
      [
        {
          type: "create-table",
          name: "users",
          columns: [
            { name: "_internalId", type: "bigint", isNullable: false, role: "internal-id" },
          ],
        },
      ],
      undefined,
    );

    // MySQL wraps with FK checks, so we have 3 statements
    expect(statements.length).toBe(3);
    expect(statements[0].sql).toMatchInlineSnapshot(`"SET FOREIGN_KEY_CHECKS = 0"`);
    expect(statements[1].sql).toMatchInlineSnapshot(
      `"create table \`users\` (\`_internalId\` bigint not null  auto_increment, constraint \`users__internalId\` primary key (\`_internalId\`))"`,
    );
    expect(statements[2].sql).toMatchInlineSnapshot(`"SET FOREIGN_KEY_CHECKS = 1"`);
  });

  test("returns undefined for TEXT column defaults", () => {
    const defaultValue = generator.getDefaultValue({
      name: "description",
      type: "string",
      isNullable: true,
      role: "regular",
      default: { value: "default text" },
    });

    expect(defaultValue).toBeUndefined();
  });
});

describe("PreparedMigrations - Integration", () => {
  test("createPreparedMigrations - execute with version tracking", async () => {
    const executedStatements: string[] = [];
    let transactionStarted = false;

    // Create a mock driver that captures SQL statements
    const mockDriver = {
      async executeQuery(query: { sql: string }) {
        executedStatements.push(query.sql);
        return { rows: [] };
      },
      async transaction(
        callback: (tx: {
          executeQuery: (q: { sql: string }) => Promise<{ rows: [] }>;
        }) => Promise<void>,
      ) {
        transactionStarted = true;
        await callback({
          async executeQuery(query: { sql: string }) {
            executedStatements.push(query.sql);
            return { rows: [] };
          },
        });
      },
      async destroy() {},
    };

    const prepared = createPreparedMigrations({
      schema: testSchema,
      namespace: "test",
      database: "postgresql",
      resolver,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      driver: mockDriver as any,
    });

    await prepared.execute(0, 1);

    expect(transactionStarted).toBe(true);
    expect(executedStatements.length).toBe(2);
    expect(executedStatements[0]).toMatchInlineSnapshot(
      `"create table "users_test" ("id" varchar(30) not null unique, "name" text not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null)"`,
    );
    expect(executedStatements[1]).toMatchInlineSnapshot(
      `"insert into "fragno_db_settings" ("id", "key", "value") values ('BflimUWc1NbCMMDD9SM3gQ', 'test.schema_version', '1')"`,
    );
  });

  test("execute with updateVersionInMigration=false skips version update", async () => {
    const executedStatements: string[] = [];

    const mockDriver = {
      async executeQuery(query: { sql: string }) {
        executedStatements.push(query.sql);
        return { rows: [] };
      },
      async transaction(
        callback: (tx: {
          executeQuery: (q: { sql: string }) => Promise<{ rows: [] }>;
        }) => Promise<void>,
      ) {
        await callback({
          async executeQuery(query: { sql: string }) {
            executedStatements.push(query.sql);
            return { rows: [] };
          },
        });
      },
      async destroy() {},
    };

    const prepared = createPreparedMigrations({
      schema: testSchema,
      namespace: "test",
      database: "postgresql",
      resolver,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      driver: mockDriver as any,
    });

    await prepared.execute(0, 1, { updateVersionInMigration: false });

    // Should only have the create table statement, no version update
    expect(executedStatements.length).toBe(1);
    expect(executedStatements[0]).toContain('create table "users_test"');
  });

  test("throws error for backward migration", async () => {
    const mockDriver = {
      async executeQuery() {
        return { rows: [] };
      },
      async transaction() {},
      async destroy() {},
    };

    const prepared = createPreparedMigrations({
      schema: testSchema,
      namespace: "test",
      database: "postgresql",
      resolver,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(() => prepared.executeWithDriver(mockDriver as any, 2, 1)).rejects.toThrow(
      "Cannot migrate backwards",
    );
  });

  test("throws error for version beyond schema", async () => {
    const mockDriver = {
      async executeQuery() {
        return { rows: [] };
      },
      async transaction() {},
      async destroy() {},
    };

    const prepared = createPreparedMigrations({
      schema: testSchema,
      namespace: "test",
      database: "postgresql",
      resolver,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(() => prepared.executeWithDriver(mockDriver as any, 0, 100)).rejects.toThrow(
      "exceeds schema version",
    );
  });

  test("returns early for same version (no statements executed)", async () => {
    const executedStatements: string[] = [];

    const mockDriver = {
      async executeQuery(query: { sql: string }) {
        executedStatements.push(query.sql);
        return { rows: [] };
      },
      async transaction(
        callback: (tx: {
          executeQuery: (q: { sql: string }) => Promise<{ rows: [] }>;
        }) => Promise<void>,
      ) {
        await callback({
          async executeQuery(query: { sql: string }) {
            executedStatements.push(query.sql);
            return { rows: [] };
          },
        });
      },
      async destroy() {},
    };

    const prepared = createPreparedMigrations({
      schema: testSchema,
      namespace: "test",
      database: "postgresql",
      resolver,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      driver: mockDriver as any,
    });

    await prepared.execute(2, 2);

    // No statements should be executed
    expect(executedStatements.length).toBe(0);
  });

  test("throws error when execute is called without driver", async () => {
    const prepared = createPreparedMigrations({
      schema: testSchema,
      namespace: "test",
      database: "postgresql",
      resolver,
      // No driver provided
    });

    await expect(() => prepared.execute(0, 1)).rejects.toThrow(
      "Driver not provided. Cannot execute migration. Use `executeWithDriver` instead.",
    );
  });
});

describe("PreparedMigrations - Multi-step Migration Scenarios", () => {
  test("PostgreSQL: migration 0 -> 2 (create users table and add age + indexes)", () => {
    const prepared = createPreparedMigrations({
      schema: testSchema,
      namespace: "test",
      database: "postgresql",
      resolver,
    });

    const sql = prepared.getSQL(0, 2, { updateVersionInMigration: true });
    expect(sql).toMatchInlineSnapshot(`
      "create table "users_test" ("id" varchar(30) not null unique, "name" text not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      alter table "users_test" add column "age" integer;

      create index "idx_users_name_idx_test_92db5054" on "users_test" ("name");

      create index "idx_users_age_idx_test_1c69311d" on "users_test" ("age");

      insert into "fragno_db_settings" ("id", "key", "value") values ('BflimUWc1NbCMMDD9SM3gQ', 'test.schema_version', '2');"
    `);
  });

  test("PostgreSQL: migration 0 -> 4 (full schema with posts and FK)", () => {
    const prepared = createPreparedMigrations({
      schema: testSchema,
      namespace: "test",
      database: "postgresql",
      resolver,
    });

    const sql = prepared.getSQL(0, 4, { updateVersionInMigration: true });
    expect(sql).toMatchInlineSnapshot(`
      "create table "users_test" ("id" varchar(30) not null unique, "name" text not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      alter table "users_test" add column "age" integer;

      create index "idx_users_name_idx_test_92db5054" on "users_test" ("name");

      create index "idx_users_age_idx_test_1c69311d" on "users_test" ("age");

      create table "posts_test" ("id" varchar(30) not null unique, "title" text not null, "authorId" bigint not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      alter table "posts_test" add constraint "fk_posts_users_author_test_8d48035c" foreign key ("authorId") references "users_test" ("_internalId") on delete restrict on update restrict;

      insert into "fragno_db_settings" ("id", "key", "value") values ('BflimUWc1NbCMMDD9SM3gQ', 'test.schema_version', '4');"
    `);
  });

  test("PostgreSQL: migration 1 -> 2 (add age column and indexes only)", () => {
    const prepared = createPreparedMigrations({
      schema: testSchema,
      namespace: "test",
      database: "postgresql",
      resolver,
    });

    const sql = prepared.getSQL(1, 2, { updateVersionInMigration: true });
    expect(sql).toMatchInlineSnapshot(`
      "alter table "users_test" add column "age" integer;

      create index "idx_users_name_idx_test_92db5054" on "users_test" ("name");

      create index "idx_users_age_idx_test_1c69311d" on "users_test" ("age");

      update "fragno_db_settings" set "value" = '2' where "key" = 'test.schema_version';"
    `);
  });

  test("PostgreSQL: migration 2 -> 3 (add posts table)", () => {
    const prepared = createPreparedMigrations({
      schema: testSchema,
      namespace: "test",
      database: "postgresql",
      resolver,
    });

    const sql = prepared.getSQL(2, 3, { updateVersionInMigration: true });
    expect(sql).toMatchInlineSnapshot(`
      "create table "posts_test" ("id" varchar(30) not null unique, "title" text not null, "authorId" bigint not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);

      update "fragno_db_settings" set "value" = '3' where "key" = 'test.schema_version';"
    `);
  });

  test("SQLite: migration 0 -> 4 with FK merging", () => {
    const prepared = createPreparedMigrations({
      schema: testSchema,
      namespace: "test",
      database: "sqlite",
      resolver,
    });

    const sql = prepared.getSQL(0, 4, { updateVersionInMigration: true });
    expect(sql).toMatchInlineSnapshot(`
      "PRAGMA defer_foreign_keys = ON;

      create table "users_test" ("id" text not null unique, "name" text not null, "_internalId" integer not null primary key autoincrement, "_version" integer default 0 not null);

      alter table "users_test" add column "age" integer;

      create index "idx_users_name_idx_test_92db5054" on "users_test" ("name");

      create index "idx_users_age_idx_test_1c69311d" on "users_test" ("age");

      create table "posts_test" ("id" text not null unique, "title" text not null, "authorId" integer not null, "_internalId" integer not null primary key autoincrement, "_version" integer default 0 not null, foreign key ("authorId") references "users_test" ("_internalId") on delete restrict on update restrict);

      insert into "fragno_db_settings" ("id", "key", "value") values ('BflimUWc1NbCMMDD9SM3gQ', 'test.schema_version', '4');"
    `);
  });

  test("MySQL: migration 0 -> 4 with FK checks disabled", () => {
    const prepared = createPreparedMigrations({
      schema: testSchema,
      namespace: "test",
      database: "mysql",
      resolver,
    });

    const sql = prepared.getSQL(0, 4, { updateVersionInMigration: true });
    expect(sql).toMatchInlineSnapshot(`
      "SET FOREIGN_KEY_CHECKS = 0;

      create table \`users_test\` (\`id\` varchar(30) not null unique, \`name\` text not null, \`_internalId\` bigint not null  auto_increment, \`_version\` integer default 0 not null, constraint \`users_test__internalId\` primary key (\`_internalId\`));

      alter table \`users_test\` add column \`age\` integer;

      create index \`idx_users_name_idx_test_92db5054\` on \`users_test\` (\`name\`);

      create index \`idx_users_age_idx_test_1c69311d\` on \`users_test\` (\`age\`);

      create table \`posts_test\` (\`id\` varchar(30) not null unique, \`title\` text not null, \`authorId\` bigint not null, \`_internalId\` bigint not null  auto_increment, \`_version\` integer default 0 not null, constraint \`posts_test__internalId\` primary key (\`_internalId\`));

      alter table \`posts_test\` add constraint \`fk_posts_users_author_test_8d48035c\` foreign key (\`authorId\`) references \`users_test\` (\`_internalId\`) on delete restrict on update restrict;

      SET FOREIGN_KEY_CHECKS = 1;

      insert into \`fragno_db_settings\` (\`id\`, \`key\`, \`value\`) values ('BflimUWc1NbCMMDD9SM3gQ', 'test.schema_version', '4');"
    `);
  });

  test("PostgreSQL: migration 1 -> 2 (make column nullable)", () => {
    const prepared = createPreparedMigrations({
      schema: nullableSchema,
      namespace: "nullable",
      database: "postgresql",
      resolver: nullableResolver,
    });

    const sql = prepared.getSQL(1, 2, { updateVersionInMigration: false });
    expect(sql).toMatchInlineSnapshot(
      `"alter table "users_nullable" alter column "name" drop not null;"`,
    );
  });

  test("MySQL: migration 1 -> 2 (make column nullable)", () => {
    const prepared = createPreparedMigrations({
      schema: nullableSchema,
      namespace: "nullable",
      database: "mysql",
      resolver: nullableResolver,
    });

    const sql = prepared.getSQL(1, 2, { updateVersionInMigration: false });
    expect(sql).toMatchInlineSnapshot(`
      "SET FOREIGN_KEY_CHECKS = 0;

      alter table \`users_nullable\` modify column \`name\` text;

      SET FOREIGN_KEY_CHECKS = 1;"
    `);
  });

  test("SQLite: migration 1 -> 2 (make column nullable)", () => {
    const prepared = createPreparedMigrations({
      schema: nullableSchema,
      namespace: "nullable",
      database: "sqlite",
      resolver: nullableResolver,
    });

    const sql = prepared.getSQL(1, 2, { updateVersionInMigration: false });
    expect(sql).toMatchInlineSnapshot(`
      "PRAGMA defer_foreign_keys = ON;

      PRAGMA foreign_keys = OFF;

      alter table "users_nullable" rename to "users_nullable__fragno_tmp_414fdd";

      create table "users_nullable" ("id" text not null unique, "name" text, "_internalId" integer not null primary key autoincrement, "_version" integer default 0 not null);

      insert into "users_nullable" ("id", "name", "_internalId", "_version") select "id", "name", "_internalId", "_version" from "users_nullable__fragno_tmp_414fdd";

      drop table "users_nullable__fragno_tmp_414fdd";

      PRAGMA foreign_keys = ON;"
    `);
  });

  test("compile returns CompiledMigration with statements array", () => {
    const prepared = createPreparedMigrations({
      schema: testSchema,
      namespace: "test",
      database: "postgresql",
      resolver,
    });

    const compiled = prepared.compile(0, 2, { updateVersionInMigration: true });
    expect(compiled.statements).toBeDefined();
    expect(compiled.statements.length).toBeGreaterThan(0);
    // Should have: create table, add column, 2 indexes, version insert
    expect(compiled.statements.length).toBe(5);
  });

  test("getSQL with updateVersionInMigration=false excludes version statement", () => {
    const prepared = createPreparedMigrations({
      schema: testSchema,
      namespace: "test",
      database: "postgresql",
      resolver,
    });

    const sql = prepared.getSQL(0, 1, { updateVersionInMigration: false });
    expect(sql).not.toContain("fragno_db_settings");
    expect(sql).toMatchInlineSnapshot(
      `"create table "users_test" ("id" varchar(30) not null unique, "name" text not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null);"`,
    );
  });
});
