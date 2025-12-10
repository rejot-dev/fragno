import { type CompiledQuery } from "kysely";
import type { UOWCompiler } from "../../query/unit-of-work";
import { type TableNameMapper } from "../shared/table-name-mapper";
import type { SQLProvider } from "../../shared/providers";
import {
  MySQL2DriverConfig,
  NodePostgresDriverConfig,
  BetterSQLite3DriverConfig,
} from "../generic-sql/driver-config";
import type { DriverConfig } from "../generic-sql/driver-config";
import { GenericSQLUOWOperationCompiler } from "../generic-sql/query/generic-sql-uow-operation-compiler";
import { createUOWCompilerFromOperationCompiler } from "../shared/uow-operation-compiler";

function getDriverConfig(provider: SQLProvider): DriverConfig {
  switch (provider) {
    case "postgresql":
      return new NodePostgresDriverConfig();
    case "mysql":
      return new MySQL2DriverConfig();
    case "sqlite":
      return new BetterSQLite3DriverConfig();
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

/**
 * Create a Kysely-specific Unit of Work compiler
 *
 * This compiler translates UOW operations into Kysely CompiledQuery objects
 * that can be executed as a batch/transaction.
 *
 * @param pool - Connection pool for acquiring database connections
 * @param provider - SQL provider (postgresql, mysql, sqlite, etc.)
 * @param mapperFactory - Optional factory function to create mappers for namespaces (receives undefined for non-namespaced operations)
 * @returns A UOWCompiler instance for Kysely
 */
export function createKyselyUOWCompiler(
  provider: SQLProvider,
  mapperFactory?: (namespace: string | undefined) => TableNameMapper | undefined,
): UOWCompiler<CompiledQuery> {
  const driverConfig = getDriverConfig(provider);
  const opCompiler = new GenericSQLUOWOperationCompiler(driverConfig, mapperFactory);
  return createUOWCompilerFromOperationCompiler(opCompiler);
}
