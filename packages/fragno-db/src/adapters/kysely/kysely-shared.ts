import { Kysely } from "kysely";
import type { SQLProvider } from "../../shared/providers";
import { MysqlDialect, PostgresDialect, SqliteDialect } from "kysely";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KyselyAny = Kysely<any>;

/**
 * Creates a Kysely instance that can only build queries, not execute them.
 */
export function createKysely(provider: SQLProvider): KyselyAny {
  // oxlint-disable-next-line no-explicit-any
  const fakeObj = {} as any;
  switch (provider) {
    case "postgresql":
    case "cockroachdb":
      return new Kysely({
        dialect: new PostgresDialect(fakeObj),
      });

    case "mysql":
      return new Kysely({
        dialect: new MysqlDialect(fakeObj),
      });

    case "sqlite":
      return new Kysely({
        dialect: new SqliteDialect(fakeObj),
      });
  }

  throw new Error(`Unsupported provider: ${provider}`);
}
