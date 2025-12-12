import type { DriverConfig } from "../../adapters/generic-sql/driver-config";
import { SQLSerializer } from "./sql-serializer";
import { SQLiteSerializer } from "./dialect/sqlite-serializer";
import { PostgreSQLSerializer } from "./dialect/postgres-serializer";
import { MySQLSerializer } from "./dialect/mysql-serializer";

// Re-export SQLSerializer for convenience
export { SQLSerializer } from "./sql-serializer";

/**
 * Factory function to create a dialect-specific SQL serializer from a DriverConfig.
 *
 * Based on the database type, returns the appropriate serializer implementation
 * (PostgreSQL, MySQL, or SQLite).
 *
 * @param driverConfig - The driver configuration
 * @returns Dialect-specific SQLSerializer instance
 */
export function createSQLSerializer(driverConfig: DriverConfig): SQLSerializer {
  // TODO: The serializers are pretty lenient in what they accept (lost of typeof checks), it may
  //       be beneficial to implement serializers per DriverConfig, and be less lenient.
  switch (driverConfig.databaseType) {
    case "postgresql":
      return new PostgreSQLSerializer(driverConfig);
    case "mysql":
      return new MySQLSerializer(driverConfig);
    case "sqlite":
      return new SQLiteSerializer(driverConfig);
    default: {
      const exhaustiveCheck: never = driverConfig.databaseType;
      throw new Error(`Unsupported database type: ${exhaustiveCheck}`);
    }
  }
}
