import type { DriverConfig } from "../driver-config";
import type { NamingResolver } from "../../../naming/sql-naming";
import type { SQLiteStorageMode } from "../sqlite-storage";
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
 * @param sqliteStorageMode - Optional SQLite storage mode override
 * @param resolver - Optional naming resolver for namespace prefixing
 * @returns Dialect-specific SQLQueryCompiler instance
 */
export function createSQLQueryCompiler(
  db: AnyKysely,
  driverConfig: DriverConfig,
  sqliteStorageMode?: SQLiteStorageMode,
  resolver?: NamingResolver,
): SQLQueryCompiler {
  switch (driverConfig.databaseType) {
    case "postgresql":
      return new PostgreSQLQueryCompiler(db, driverConfig, sqliteStorageMode, resolver);
    case "mysql":
      return new MySQLQueryCompiler(db, driverConfig, sqliteStorageMode, resolver);
    case "sqlite":
      return new SQLiteQueryCompiler(db, driverConfig, sqliteStorageMode, resolver);
    default: {
      const exhaustiveCheck: never = driverConfig.databaseType;
      throw new Error(`Unsupported database type: ${exhaustiveCheck}`);
    }
  }
}
