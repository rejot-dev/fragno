import type { DriverConfig } from "../driver-config";
import type { TableNameMapper } from "../../shared/table-name-mapper";
import { SQLQueryCompiler, type AnyKysely } from "./sql-query-compiler";
import { PostgreSQLQueryCompiler } from "./dialect/postgres";
import { MySQLQueryCompiler } from "./dialect/mysql";
import { SQLiteQueryCompiler } from "./dialect/sqlite";

/**
 * Factory function to create a dialect-specific SQL query compiler.
 *
 * Based on the database type in DriverConfig, returns the appropriate
 * compiler implementation (PostgreSQL, MySQL, or SQLite).
 *
 * @param db - Kysely database instance
 * @param driverConfig - Driver configuration with database type and capabilities
 * @param mapper - Optional table name mapper for namespace prefixing
 * @returns Dialect-specific SQLQueryCompiler instance
 */
export function createSQLQueryCompiler(
  db: AnyKysely,
  driverConfig: DriverConfig,
  mapper?: TableNameMapper,
): SQLQueryCompiler {
  switch (driverConfig.databaseType) {
    case "postgresql":
      return new PostgreSQLQueryCompiler(db, driverConfig, mapper);
    case "mysql":
      return new MySQLQueryCompiler(db, driverConfig, mapper);
    case "sqlite":
      return new SQLiteQueryCompiler(db, driverConfig, mapper);
    default: {
      const exhaustiveCheck: never = driverConfig.databaseType;
      throw new Error(`Unsupported database type: ${exhaustiveCheck}`);
    }
  }
}
