import type { Kysely } from "kysely";
import type { KyselyConfig } from "../kysely-adapter";
import type { MigrationExecutor } from "./execute-base";
import { SqliteMigrationExecutor } from "./execute-sqlite";
import { PostgresMigrationExecutor } from "./execute-postgres";
import { MysqlMigrationExecutor } from "./execute-mysql";
import { MssqlMigrationExecutor } from "./execute-mssql";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KyselyAny = Kysely<any>;

/**
 * Create a provider-specific migration executor.
 */
export function createMigrationExecutor(config: KyselyConfig): MigrationExecutor {
  const { provider } = config;
  // Resolve db instance synchronously
  // Safe cast: This is only called from synchronous contexts where the db must be available
  const dbOrFactory = config.db;
  let kysely: KyselyAny;

  if (typeof dbOrFactory === "function") {
    const result = dbOrFactory();
    // Check if it's a Promise - if so, this is an error in usage
    if (result && typeof (result as Promise<unknown>).then === "function") {
      throw new Error(
        "Cannot create migration executor with async database factory. " +
          "Database must be initialized before calling preprocessOperations.",
      );
    }
    // Safe cast: We've verified it's not a Promise
    kysely = result as KyselyAny;
  } else {
    kysely = dbOrFactory;
  }

  switch (provider) {
    case "sqlite":
      return new SqliteMigrationExecutor(kysely, provider);
    case "postgresql":
    case "cockroachdb":
      return new PostgresMigrationExecutor(kysely, provider);
    case "mysql":
      return new MysqlMigrationExecutor(kysely, provider);
    case "mssql":
      return new MssqlMigrationExecutor(kysely, provider);
    default: {
      // Ensure exhaustive switch
      const _exhaustive: never = provider;
      throw new Error(`Unsupported provider: ${_exhaustive}`);
    }
  }
}
