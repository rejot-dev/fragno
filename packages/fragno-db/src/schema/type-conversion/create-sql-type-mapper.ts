import type {
  DriverConfig,
  SQLiteProfile,
  SupportedDatabase,
} from "../../adapters/generic-sql/driver-config";
import { PostgreSQLTypeMapper } from "./dialect/postgres";
import { MySQLTypeMapper } from "./dialect/mysql";
import { SQLiteTypeMapper } from "./dialect/sqlite";

/**
 * Factory function to create a dialect-specific SQL type mapper.
 *
 * Based on the database type, returns the appropriate mapper implementation
 * (PostgreSQL, MySQL, or SQLite).
 *
 * @param database - The database type (sqlite, postgresql, or mysql)
 * @param driverConfig - Optional driver config to customize SQLite storage profile
 * @returns Dialect-specific SQLTypeMapper instance
 */
export function createSQLTypeMapper(
  database: SupportedDatabase,
  driverConfig?: Pick<DriverConfig, "sqliteProfile">,
) {
  const sqliteProfile: SQLiteProfile | undefined =
    database === "sqlite" ? driverConfig?.sqliteProfile : undefined;
  switch (database) {
    case "postgresql":
      return new PostgreSQLTypeMapper(database);
    case "mysql":
      return new MySQLTypeMapper(database);
    case "sqlite":
      return new SQLiteTypeMapper(database, sqliteProfile);
    default: {
      const exhaustiveCheck: never = database;
      throw new Error(`Unsupported database type: ${exhaustiveCheck}`);
    }
  }
}
