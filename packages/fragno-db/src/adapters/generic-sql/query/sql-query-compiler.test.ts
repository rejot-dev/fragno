import { describe, test, expect } from "vitest";
import { Kysely, SqliteDialect } from "kysely";
import Database from "better-sqlite3";
import { schema, column, idColumn, referenceColumn } from "../../../schema/create";
import { createNamingResolver, type SqlNamingStrategy } from "../../../naming/sql-naming";
import { PostgreSQLQueryCompiler } from "./dialect/postgres";
import { MySQLQueryCompiler } from "./dialect/mysql";
import { SQLiteQueryCompiler } from "./dialect/sqlite";
import {
  BetterSQLite3DriverConfig,
  NodePostgresDriverConfig,
  MySQL2DriverConfig,
} from "../driver-config";

// Test schema
const testSchema = schema("test", (s) => {
  return s
    .addTable("users", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("email", column("string"))
        .addColumn("age", column("integer").nullable());
    })
    .addTable("posts", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("title", column("string"))
        .addColumn("content", column("string"))
        .addColumn("userId", referenceColumn());
    });
});

describe("SQLQueryCompiler", () => {
  describe("PostgreSQLQueryCompiler", () => {
    test("compileCount generates correct SQL", () => {
      const db = new Kysely({
        dialect: new SqliteDialect({ database: new Database(":memory:") }),
      });
      const compiler = new PostgreSQLQueryCompiler(db, new NodePostgresDriverConfig());

      const query = compiler.compileCount(testSchema.tables.users, {});

      expect(query.sql).toMatchInlineSnapshot(`"select count(*) as "count" from "users""`);
    });

    test("compileCount with where clause", () => {
      const db = new Kysely({
        dialect: new SqliteDialect({ database: new Database(":memory:") }),
      });
      const compiler = new PostgreSQLQueryCompiler(db, new NodePostgresDriverConfig());

      const query = compiler.compileCount(testSchema.tables.users, {
        where: {
          type: "compare",
          a: testSchema.tables.users.columns.age,
          operator: ">",
          b: 18,
        },
      });

      expect(query.sql).toMatchInlineSnapshot(
        `"select count(*) as "count" from "users" where "users"."age" > ?"`,
      );
    });

    test("compileFindMany generates correct SQL", () => {
      const db = new Kysely({
        dialect: new SqliteDialect({ database: new Database(":memory:") }),
      });
      const compiler = new PostgreSQLQueryCompiler(db, new NodePostgresDriverConfig());

      const query = compiler.compileFindMany(testSchema.tables.users, {
        select: true,
        limit: 10,
      });

      expect(query.sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" limit ?"`,
      );
    });

    test("compileFindMany with orderBy", () => {
      const db = new Kysely({
        dialect: new SqliteDialect({ database: new Database(":memory:") }),
      });
      const compiler = new PostgreSQLQueryCompiler(db, new NodePostgresDriverConfig());

      const query = compiler.compileFindMany(testSchema.tables.users, {
        select: true,
        orderBy: [[testSchema.tables.users.columns.name, "asc"]],
        limit: 5,
      });

      expect(query.sql).toMatchInlineSnapshot(
        `"select "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."_internalId" as "_internalId", "users"."_version" as "_version" from "users" order by "users"."name" asc limit ?"`,
      );
    });

    test("compileCreate generates correct SQL", () => {
      const db = new Kysely({
        dialect: new SqliteDialect({ database: new Database(":memory:") }),
      });
      const compiler = new PostgreSQLQueryCompiler(db, new NodePostgresDriverConfig());

      const query = compiler.compileCreate(testSchema.tables.users, {
        name: "John",
        email: "john@example.com",
        age: 30,
      });

      expect(query.sql).toMatchInlineSnapshot(
        `"insert into "users" ("id", "name", "email", "age") values (?, ?, ?, ?) returning "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."_internalId" as "_internalId", "users"."_version" as "_version""`,
      );
    });

    test("compileUpdate generates correct SQL", () => {
      const db = new Kysely({
        dialect: new SqliteDialect({ database: new Database(":memory:") }),
      });
      const compiler = new PostgreSQLQueryCompiler(db, new NodePostgresDriverConfig());

      const query = compiler.compileUpdate(testSchema.tables.users, {
        set: { name: "Jane" },
        where: {
          type: "compare",
          a: testSchema.tables.users.columns.id,
          operator: "=",
          b: "user123",
        },
      });

      expect(query.sql).toMatchInlineSnapshot(
        `"update "users" set "name" = ?, "_version" = coalesce("_version", 0) + 1 where "users"."id" = ?"`,
      );
    });

    test("compileDelete generates correct SQL", () => {
      const db = new Kysely({
        dialect: new SqliteDialect({ database: new Database(":memory:") }),
      });
      const compiler = new PostgreSQLQueryCompiler(db, new NodePostgresDriverConfig());

      const query = compiler.compileDelete(testSchema.tables.users, {
        where: {
          type: "compare",
          a: testSchema.tables.users.columns.id,
          operator: "=",
          b: "user123",
        },
      });

      expect(query.sql).toMatchInlineSnapshot(`"delete from "users" where "users"."id" = ?"`);
    });
  });

  describe("MySQLQueryCompiler", () => {
    test("compileCreate does not include RETURNING", () => {
      const db = new Kysely({
        dialect: new SqliteDialect({ database: new Database(":memory:") }),
      });
      const compiler = new MySQLQueryCompiler(db, new MySQL2DriverConfig());

      const query = compiler.compileCreate(testSchema.tables.users, {
        name: "John",
        email: "john@example.com",
        age: 30,
      });

      expect(query.sql).toMatchInlineSnapshot(
        `"insert into "users" ("id", "name", "email", "age") values (?, ?, ?, ?)"`,
      );
      expect(query.sql).not.toContain("returning");
    });
  });

  describe("SQLiteQueryCompiler", () => {
    test("compileCreate includes RETURNING", () => {
      const db = new Kysely({
        dialect: new SqliteDialect({ database: new Database(":memory:") }),
      });
      const compiler = new SQLiteQueryCompiler(db, new BetterSQLite3DriverConfig());

      const query = compiler.compileCreate(testSchema.tables.users, {
        name: "John",
        email: "john@example.com",
        age: 30,
      });

      expect(query.sql).toMatchInlineSnapshot(
        `"insert into "users" ("id", "name", "email", "age") values (?, ?, ?, ?) returning "users"."id" as "id", "users"."name" as "name", "users"."email" as "email", "users"."age" as "age", "users"."_internalId" as "_internalId", "users"."_version" as "_version""`,
      );
      expect(query.sql).toContain("returning");
    });

    test("compileUpdate succeeds when version column needs quoting", async () => {
      const db = new Kysely({
        dialect: new SqliteDialect({ database: new Database(":memory:") }),
      });

      await db.schema
        .createTable("users")
        .addColumn("id", "text")
        .addColumn("name", "text")
        .addColumn("users-version", "integer")
        .execute();

      const namingStrategy: SqlNamingStrategy = {
        namespaceScope: "suffix",
        namespaceToSchema: (namespace) => namespace,
        tableName: (logicalTable) => logicalTable,
        columnName: (logicalColumn, logicalTable) =>
          logicalColumn === "_version" ? `${logicalTable}-version` : logicalColumn,
        indexName: (logicalIndex) => logicalIndex,
        uniqueIndexName: (logicalIndex) => logicalIndex,
        foreignKeyName: ({ referenceName }) => referenceName,
      };

      const resolver = createNamingResolver(testSchema, null, namingStrategy);
      const compiler = new SQLiteQueryCompiler(
        db,
        new BetterSQLite3DriverConfig(),
        undefined,
        resolver,
      );

      const query = compiler.compileUpdate(testSchema.tables.users, {
        set: { name: "Jane" },
        where: {
          type: "compare",
          a: testSchema.tables.users.columns.id,
          operator: "=",
          b: "user123",
        },
      });

      expect(query.sql).toContain('coalesce("users-version", 0) + 1');
      try {
        await expect(db.executeQuery(query)).resolves.toBeDefined();
      } finally {
        await db.destroy();
      }
    });
  });
});
