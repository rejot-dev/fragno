import type { SupportedDatabase } from "../../adapters/generic-sql/driver-config";
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
 * @returns Dialect-specific SQLTypeMapper instance
 */
export function createSQLTypeMapper(database: SupportedDatabase) {
  switch (database) {
    case "postgresql":
      return new PostgreSQLTypeMapper(database);
    case "mysql":
      return new MySQLTypeMapper(database);
    case "sqlite":
      return new SQLiteTypeMapper(database);
    default: {
      const exhaustiveCheck: never = database;
      throw new Error(`Unsupported database type: ${exhaustiveCheck}`);
    }
  }
}
