import type { KyselyConfig } from "../kysely-adapter";
import type { MigrationExecutor } from "./execute-base";
import { SqliteMigrationExecutor } from "./execute-sqlite";
import { PostgresMigrationExecutor } from "./execute-postgres";
import { MysqlMigrationExecutor } from "./execute-mysql";
import { MssqlMigrationExecutor } from "./execute-mssql";

/**
 * Create a provider-specific migration executor.
 */
export function createMigrationExecutor(config: KyselyConfig): MigrationExecutor {
  const { db, provider } = config;
  // Resolve the db instance if it's a function
  const kysely = typeof db === "function" ? db() : db;

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
