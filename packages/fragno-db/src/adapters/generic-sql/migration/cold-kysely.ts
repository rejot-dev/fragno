import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";

export type SupportedDatabase = "sqlite" | "postgresql" | "mysql";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KyselyAny = Kysely<any>;

/**
 * Creates a Kysely instance that can only build queries, not execute them.
 * This is used for SQL generation without requiring a database connection.
 */
export function createColdKysely(database: SupportedDatabase): KyselyAny {
  switch (database) {
    case "postgresql":
      return new Kysely({
        dialect: {
          createAdapter: () => new PostgresAdapter(),
          createDriver: () => new DummyDriver(),
          createIntrospector: (db) => new PostgresIntrospector(db),
          createQueryCompiler: () => new PostgresQueryCompiler(),
        },
      });

    case "mysql":
      return new Kysely({
        dialect: {
          createAdapter: () => new MysqlAdapter(),
          createDriver: () => new DummyDriver(),
          createIntrospector: (db) => new MysqlIntrospector(db),
          createQueryCompiler: () => new MysqlQueryCompiler(),
        },
      });

    case "sqlite":
      return new Kysely({
        dialect: {
          createAdapter: () => new SqliteAdapter(),
          createDriver: () => new DummyDriver(),
          createIntrospector: (db) => new SqliteIntrospector(db),
          createQueryCompiler: () => new SqliteQueryCompiler(),
        },
      });
  }
}
