import type { SQLProvider } from "../../shared/providers";
import type { AnyColumn } from "../create";

export interface AdditionalColumnMetadata {
  length?: number;
  precision?: number;
  scale?: number;
}

/**
 * Map a database column type to possible schema column types.
 * Used for schema introspection and migration validation.
 *
 * @param dbType - The database column type (e.g., "integer", "varchar")
 * @param provider - The SQL provider (sqlite, postgresql, mysql, etc.)
 * @param additional - Additional metadata like length, precision, scale
 * @returns Array of possible schema types that could map to this database type
 */
export function dbToSchemaType(
  dbType: string,
  provider: SQLProvider,
  additional: AdditionalColumnMetadata,
): (AnyColumn["type"] | "varchar(n)")[] {
  dbType = dbType.toLowerCase();
  if (provider === "sqlite") {
    switch (dbType) {
      case "integer":
        return ["bool", "date", "timestamp", "bigint", "integer"];
      case "text":
        return ["json", "string", "bigint", "varchar(n)"];
      case "real":
      case "numeric":
        return ["decimal"];
      case "blob":
        return ["bigint", "binary"];
      default:
        return [dbType as AnyColumn["type"]];
    }
  }

  if (provider === "postgresql" || provider === "cockroachdb") {
    switch (dbType) {
      case "decimal":
      case "real":
      case "numeric":
      case "double precision":
        return ["decimal"];
      case "timestamp":
      case "timestamptz":
        return ["timestamp"];
      case "varchar": {
        const len = additional.length;
        if (len != null) {
          return [`varchar(${len})`];
        }
        return ["string"];
      }
      case "text":
        return ["string"];
      case "boolean":
      case "bool":
        return ["bool"];
      case "bytea":
        return ["binary"];
      default:
        return [dbType as AnyColumn["type"]];
    }
  }

  if (provider === "mysql") {
    switch (dbType) {
      case "bool":
      case "boolean":
        return ["bool"];
      case "integer":
      case "int":
        return ["integer"];
      case "decimal":
      case "numeric":
      case "float":
      case "double":
        return ["decimal"];
      case "datetime":
        return ["timestamp"];
      case "varchar": {
        const len = additional.length;
        if (len != null) {
          return [`varchar(${len})`];
        }
        return ["string"];
      }
      case "text":
        return ["string"];
      case "longblob":
      case "blob":
      case "mediumblob":
      case "tinyblob":
        return ["binary"];
      default:
        return [dbType as AnyColumn["type"]];
    }
  }

  if (provider === "mssql") {
    switch (dbType) {
      case "int":
        return ["integer"];
      case "decimal":
      case "float":
      case "real":
      case "numeric":
        return ["decimal"];
      case "bit":
        return ["bool"];
      case "datetime":
      case "datetime2":
        return ["timestamp"];
      case "nvarchar":
      case "varchar": {
        const len = additional.length;
        if (len != null) {
          return [`varchar(${len})`];
        }
        return ["string", "json"];
      }
      case "ntext":
      case "text":
      case "varchar(max)":
      case "nvarchar(max)":
        return ["string", "json"];
      case "binary":
      case "varbinary":
        return ["binary"];
      default:
        return [dbType as AnyColumn["type"]];
    }
  }

  throw new Error(`unhandled database provider: ${provider}`);
}

/**
 * Database type literals that can be returned by schemaToDBType
 */
export type DatabaseTypeLiteral =
  // PostgreSQL/CockroachDB types
  | "bigserial"
  | "serial"
  | "boolean"
  | "bool"
  | "json"
  | "text"
  | "bytea"
  | "timestamp"
  | "timestamptz"
  | "bigint"
  | "integer"
  | "decimal"
  | "date"
  // MySQL types
  | "longblob"
  | "datetime"
  // SQLite types
  | "blob"
  | "real"
  // MSSQL types
  | "bit"
  | "int"
  | "varbinary(max)"
  | "varchar(max)"
  // varchar with length parameter
  | `varchar(${number})`;

/**
 * Map a schema column type to the appropriate database column type.
 * Used for generating CREATE TABLE statements and migrations.
 *
 * @param column - The column schema definition
 * @param provider - The SQL provider (sqlite, postgresql, mysql, etc.)
 * @returns The database-specific column type
 */
export function schemaToDBType(
  column: AnyColumn | Pick<AnyColumn, "type">,
  provider: SQLProvider,
): DatabaseTypeLiteral {
  const { type } = column;

  // Handle internal ID columns with auto-increment
  if ("role" in column && column.role === "internal-id") {
    if (provider === "postgresql" || provider === "cockroachdb") {
      return "bigserial";
    }
    if (provider === "mysql") {
      return "bigint";
    }
    if (provider === "sqlite") {
      return "integer"; // SQLite uses INTEGER for auto-increment
    }
    if (provider === "mssql") {
      return "bigint";
    }
  }

  if ("role" in column && column.role === "reference") {
    if (provider === "sqlite") {
      return "integer";
    }
    // Other providers use bigint for references
  }

  if (provider === "sqlite") {
    switch (type) {
      case "integer":
      case "timestamp":
      case "date":
      case "bool":
        return "integer";
      case "binary":
      case "bigint":
        return "blob";
      case "json":
      case "string":
        return "text";
      case "decimal":
        return "real";
      default:
        // sqlite doesn't support varchar
        if (type.startsWith("varchar")) {
          return "text";
        }
    }
  }

  if (provider === "mssql") {
    switch (type) {
      case "bool":
        return "bit";
      case "timestamp":
        return "datetime";
      case "integer":
        return "int";
      case "string":
        return "varchar(max)";
      case "binary":
        return "varbinary(max)";
      // only 2025 preview supports JSON natively
      case "json":
        return "varchar(max)";
      default:
        if (type.startsWith("varchar")) {
          return type as `varchar(${number})`;
        }
        return type;
    }
  }

  if (provider === "postgresql" || provider === "cockroachdb") {
    switch (type) {
      case "bool":
        return "boolean";
      case "json":
        return "json";
      case "string":
        return "text";
      case "binary":
        return "bytea";
      default:
        if (type.startsWith("varchar")) {
          return type as `varchar(${number})`;
        }
        return type;
    }
  }

  if (provider === "mysql") {
    switch (type) {
      case "bool":
        return "boolean";
      case "string":
        return "text";
      case "binary":
        return "longblob";
      default:
        if (type.startsWith("varchar")) {
          return type as `varchar(${number})`;
        }
        return type;
    }
  }

  throw new Error(`cannot handle ${provider} ${type}`);
}
