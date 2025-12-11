import type { SupportedDatabase } from "../../adapters/generic-sql/driver-config";
import type { AnyColumn } from "../create";

export interface AdditionalColumnMetadata {
  length?: number;
  precision?: number;
  scale?: number;
}

/**
 * PostgreSQL-specific database types
 */
export type PostgreSQLDatabaseType =
  | "bigserial"
  | "serial"
  | "boolean"
  | "json"
  | "text"
  | "bytea"
  | "timestamp"
  | "timestamptz"
  | "bigint"
  | "integer"
  | "decimal"
  | "date"
  | `varchar(${number})`;

/**
 * MySQL-specific database types
 */
export type MySQLDatabaseType =
  | "bigint"
  | "boolean"
  | "text"
  | "longblob"
  | "integer"
  | "decimal"
  | "date"
  | "datetime"
  | "json"
  | "timestamp"
  | `varchar(${number})`;

/**
 * SQLite-specific database types
 */
export type SQLiteDatabaseType = "integer" | "blob" | "text" | "real";

/**
 * Union of all database-specific types
 */
export type DatabaseTypeLiteral = PostgreSQLDatabaseType | MySQLDatabaseType | SQLiteDatabaseType;

/**
 * Abstract base class for SQL type mapping.
 *
 * Similar to SQLQueryCompiler and SQLGenerator, this class provides a framework
 * for mapping schema column types to database-specific column types.
 *
 * Each database dialect extends this class and implements abstract methods
 * for each column type. The base class handles the switch statement logic.
 *
 * @template TDatabaseType - The specific database type union for this dialect
 */
export abstract class SQLTypeMapper<TDatabaseType extends DatabaseTypeLiteral> {
  protected readonly database: SupportedDatabase;

  constructor(database: SupportedDatabase) {
    this.database = database;
  }

  /**
   * Get the database type for internal ID columns.
   */
  protected abstract getInternalIdType(): TDatabaseType;

  // Abstract methods for each column type that dialects must implement
  protected abstract mapInteger(column: AnyColumn | Pick<AnyColumn, "type">): TDatabaseType;
  protected abstract mapBigint(column: AnyColumn | Pick<AnyColumn, "type">): TDatabaseType;
  protected abstract mapString(): TDatabaseType;
  protected abstract mapVarchar(length: number): TDatabaseType;
  protected abstract mapBinary(): TDatabaseType;
  protected abstract mapBool(): TDatabaseType;
  protected abstract mapDecimal(): TDatabaseType;
  protected abstract mapTimestamp(): TDatabaseType;
  protected abstract mapDate(): TDatabaseType;
  protected abstract mapJson(): TDatabaseType;

  /**
   * Map a column type to a database-specific type.
   * Contains the central switch statement that delegates to abstract methods.
   */
  protected mapColumnType(column: AnyColumn | Pick<AnyColumn, "type">): TDatabaseType {
    const { type } = column;

    // Handle varchar with length parameter
    if (typeof type === "string" && type.startsWith("varchar")) {
      const match = type.match(/^varchar\((\d+)\)$/);
      if (match) {
        const length = parseInt(match[1], 10);
        return this.mapVarchar(length);
      }
      throw new Error(
        `Invalid varchar format: "${type}". Expected format: varchar(number), e.g., varchar(255)`,
      );
    }

    switch (type) {
      case "integer":
        return this.mapInteger(column);
      case "bigint":
        return this.mapBigint(column);
      case "string":
        return this.mapString();
      case "binary":
        return this.mapBinary();
      case "bool":
        return this.mapBool();
      case "decimal":
        return this.mapDecimal();
      case "timestamp":
        return this.mapTimestamp();
      case "date":
        return this.mapDate();
      case "json":
        return this.mapJson();
      default:
        // TypeScript should ensure we never reach here
        throw new Error(`Unsupported column type: ${type}`);
    }
  }

  /**
   * Map a schema column type to the appropriate database column type.
   * Used for generating CREATE TABLE statements and migrations.
   *
   * Handles common cases like internal-id columns,
   * then delegates to mapColumnType for other types.
   *
   * @param column - The column schema definition
   * @returns The database-specific column type
   */
  getDatabaseType(column: AnyColumn | Pick<AnyColumn, "type">): TDatabaseType {
    // Handle internal ID columns with auto-increment
    if ("role" in column && column.role === "internal-id") {
      return this.getInternalIdType();
    }

    // Delegate to type mapping logic
    // This includes reference columns, which should use their specified type
    return this.mapColumnType(column);
  }
}
