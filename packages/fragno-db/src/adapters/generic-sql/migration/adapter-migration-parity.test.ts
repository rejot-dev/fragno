import { describe, expect, it } from "vitest";
import {
  DummyDriver,
  MysqlAdapter,
  MysqlQueryCompiler,
  PostgresAdapter,
  PostgresQueryCompiler,
  SqliteAdapter,
  SqliteQueryCompiler,
} from "kysely";
import { KyselyAdapter } from "../../kysely/kysely-adapter";
import { DrizzleAdapter } from "../../drizzle/drizzle-adapter";
import type { Dialect } from "../../../sql-driver/sql-driver";
import {
  MySQL2DriverConfig,
  NodePostgresDriverConfig,
  SQLocalDriverConfig,
} from "../driver-config";
import { column, idColumn, referenceColumn, schema } from "../../../schema/create";

const paritySchema = schema((s) => {
  return s
    .addTable("users", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("email", column("string"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("users_email_idx", ["email"], { unique: true });
    })
    .alterTable("users", (t) => {
      return t.addColumn("age", column("integer").nullable()).createIndex("users_age_idx", ["age"]);
    })
    .addTable("posts", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("authorId", referenceColumn())
        .addColumn("title", column("string"))
        .addColumn("isPublished", column("bool").defaultTo(false))
        .createIndex("posts_author_idx", ["authorId"]);
    })
    .addReference("author", {
      type: "one",
      from: { table: "posts", column: "authorId" },
      to: { table: "users", column: "id" },
    });
});

function createDummyDialect(database: "postgresql" | "mysql" | "sqlite"): Dialect {
  switch (database) {
    case "postgresql":
      return {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      };
    case "mysql":
      return {
        createAdapter: () => new MysqlAdapter(),
        createDriver: () => new DummyDriver(),
        createQueryCompiler: () => new MysqlQueryCompiler(),
      };
    case "sqlite":
      return {
        createAdapter: () => new SqliteAdapter(),
        createDriver: () => new DummyDriver(),
        createQueryCompiler: () => new SqliteQueryCompiler(),
      };
  }
}

function getMigrationSql(adapter: KyselyAdapter | DrizzleAdapter, namespace: string): string[] {
  const prepared = adapter.prepareMigrations(paritySchema, namespace);
  const migration = prepared.compile(0, paritySchema.version, {
    updateVersionInMigration: false,
  });
  return migration.statements.map((statement) => statement.sql);
}

describe("migration SQL parity across adapters", () => {
  const cases = [
    {
      name: "postgresql",
      driverConfig: new NodePostgresDriverConfig(),
    },
    {
      name: "sqlite",
      driverConfig: new SQLocalDriverConfig(),
    },
    {
      name: "mysql",
      driverConfig: new MySQL2DriverConfig(),
    },
  ] as const;

  for (const testCase of cases) {
    it(`generates identical SQL for ${testCase.name}`, () => {
      const dialect = createDummyDialect(testCase.name);
      const namespace = "parity";

      const kyselyAdapter = new KyselyAdapter({
        dialect,
        driverConfig: testCase.driverConfig,
      });
      const drizzleAdapter = new DrizzleAdapter({
        dialect,
        driverConfig: testCase.driverConfig,
      });

      const kyselySql = getMigrationSql(kyselyAdapter, namespace);
      const drizzleSql = getMigrationSql(drizzleAdapter, namespace);

      console.log(kyselySql);

      expect(kyselySql).toEqual(drizzleSql);
    });
  }
});
