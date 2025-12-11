import type { AnyColumn } from "../../create";
import { SQLTypeMapper, type PostgreSQLDatabaseType } from "../type-mapping";

/**
 * PostgreSQL-specific type mapper.
 *
 * PostgreSQL supports:
 * - BIGSERIAL for auto-increment
 * - BOOLEAN for booleans
 * - JSON for JSON data
 * - TEXT for strings
 * - VARCHAR(n) for variable-length strings
 * - BYTEA for binary data
 * - Full timestamp and date support
 * - BIGINT and INTEGER for integers
 * - DECIMAL for decimals
 */
export class PostgreSQLTypeMapper extends SQLTypeMapper<PostgreSQLDatabaseType> {
  protected getInternalIdType(): PostgreSQLDatabaseType {
    return "bigserial";
  }

  protected mapInteger(_column: AnyColumn | Pick<AnyColumn, "type">): PostgreSQLDatabaseType {
    return "integer";
  }

  protected mapBigint(_column: AnyColumn | Pick<AnyColumn, "type">): PostgreSQLDatabaseType {
    return "bigint";
  }

  protected mapString(): PostgreSQLDatabaseType {
    return "text";
  }

  protected mapVarchar(length: number): PostgreSQLDatabaseType {
    return `varchar(${length})`;
  }

  protected mapBinary(): PostgreSQLDatabaseType {
    return "bytea";
  }

  protected mapBool(): PostgreSQLDatabaseType {
    return "boolean";
  }

  protected mapDecimal(): PostgreSQLDatabaseType {
    return "decimal";
  }

  protected mapTimestamp(): PostgreSQLDatabaseType {
    return "timestamp";
  }

  protected mapDate(): PostgreSQLDatabaseType {
    return "date";
  }

  protected mapJson(): PostgreSQLDatabaseType {
    return "json";
  }
}
