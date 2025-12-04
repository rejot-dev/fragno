import { describe, expect, test } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../../../schema/create";
import { createColdKysely } from "./cold-kysely";
import { SQLiteSQLGenerator } from "./dialect/sqlite";
import { PostgresSQLGenerator } from "./dialect/postgres";
import { MySQLSQLGenerator } from "./dialect/mysql";
import { createPreparedMigrations } from "./prepared-migrations";

const testSchema = schema((s) => {
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

describe("PreparedMigrations - PostgreSQL", () => {
  const coldKysely = createColdKysely("postgresql");
  const generator = new PostgresSQLGenerator(coldKysely, "postgresql");

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
      { toPhysical: (n) => `${n}_test`, toLogical: (n) => n.replace("_test", "") },
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
      { toPhysical: (n) => `${n}_test`, toLogical: (n) => n.replace("_test", "") },
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
      { toPhysical: (n) => `${n}_test`, toLogical: (n) => n.replace("_test", "") },
    );

    expect(statements.length).toBe(1);
    expect(statements[0].sql).toMatchInlineSnapshot(
      `"create index "name_idx_users_test" on "users_test" ("name")"`,
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
});

describe("PreparedMigrations - SQLite FK Merging", () => {
  const coldKysely = createColdKysely("sqlite");
  const generator = new SQLiteSQLGenerator(coldKysely, "sqlite");

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

    // FK should be merged into posts create-table
    expect(operations.length).toBe(2);
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
      { toPhysical: (n) => `${n}_test`, toLogical: (n) => n.replace("_test", "") },
    );

    expect(statements.length).toBe(2);
    expect(statements[0].sql).toMatchInlineSnapshot(
      `"create table "users_test" ("id" text not null unique)"`,
    );
    expect(statements[1].sql).toMatchInlineSnapshot(
      `"create table "posts_test" ("id" text not null unique, "authorId" integer not null, constraint "posts_users_author_fk" foreign key ("authorId") references "users_test" ("_internalId") on delete restrict on update restrict)"`,
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

    expect(statements[0].sql).toMatchInlineSnapshot(
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
      `"create table \`users\` (\`_internalId\` bigint not null primary key auto_increment)"`,
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
  test("createPreparedMigrations compiles schema to SQL", () => {
    const prepared = createPreparedMigrations({
      schema: testSchema,
      namespace: "test",
      database: "postgresql",
    });

    const migration = prepared.compile({
      fromVersion: 0,
      toVersion: 1,
      updateVersionInMigration: true,
    });

    expect(migration.fromVersion).toBe(0);
    expect(migration.toVersion).toBe(1);
    expect(migration.statements.length).toBe(2);

    const sql = migration.statements.map((s) => s.sql).join("\n\n");
    expect(sql).toMatchInlineSnapshot(`
      "create table "users_test" ("id" varchar(30) not null unique, "name" text not null, "_internalId" bigserial not null primary key, "_version" integer default 0 not null)

      insert into "fragno_db_settings" ("id", "key", "value") values ('BflimUWc1NbCMMDD9SM3gQ', 'test.schema_version', '1')"
    `);
  });

  test("throws error for backward migration", () => {
    const prepared = createPreparedMigrations({
      schema: testSchema,
      namespace: "test",
      database: "postgresql",
    });

    expect(() =>
      prepared.compile({
        fromVersion: 2,
        toVersion: 1,
        updateVersionInMigration: true,
      }),
    ).toThrow("Cannot migrate backwards");
  });

  test("throws error for version beyond schema", () => {
    const prepared = createPreparedMigrations({
      schema: testSchema,
      namespace: "test",
      database: "postgresql",
    });

    expect(() =>
      prepared.compile({
        fromVersion: 0,
        toVersion: 100,
        updateVersionInMigration: true,
      }),
    ).toThrow("exceeds schema version");
  });

  test("returns empty statements for same version", () => {
    const prepared = createPreparedMigrations({
      schema: testSchema,
      namespace: "test",
      database: "postgresql",
    });

    const migration = prepared.compile({
      fromVersion: 2,
      toVersion: 2,
      updateVersionInMigration: true,
    });

    expect(migration.statements.length).toBe(0);
  });
});
