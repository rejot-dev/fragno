import type { AnyColumn } from "../../create";
import { SQLTypeMapper, type MySQLDatabaseType } from "../type-mapping";

/**
 * MySQL-specific type mapper.
 *
 * MySQL supports:
 * - BIGINT for large integers (with AUTO_INCREMENT for internal IDs)
 * - INTEGER for integers
 * - BOOLEAN for booleans (alias for TINYINT(1))
 * - JSON for JSON data (native support in MySQL 5.7+)
 * - TEXT for strings
 * - VARCHAR(n) for variable-length strings
 * - LONGBLOB for binary data
 * - DATETIME for timestamps without timezone
 * - DATE for dates
 * - DECIMAL for decimals
 */
export class MySQLTypeMapper extends SQLTypeMapper<MySQLDatabaseType> {
  protected getInternalIdType(): MySQLDatabaseType {
    // MySQL uses bigint with AUTO_INCREMENT applied separately
    return "bigint";
  }

  protected mapInteger(_column: AnyColumn | Pick<AnyColumn, "type">): MySQLDatabaseType {
    return "integer";
  }

  protected mapBigint(_column: AnyColumn | Pick<AnyColumn, "type">): MySQLDatabaseType {
    return "bigint";
  }

  protected mapString(): MySQLDatabaseType {
    return "text";
  }

  protected mapVarchar(length: number): MySQLDatabaseType {
    return `varchar(${length})`;
  }

  protected mapBinary(): MySQLDatabaseType {
    return "longblob";
  }

  protected mapBool(): MySQLDatabaseType {
    return "boolean";
  }

  protected mapDecimal(): MySQLDatabaseType {
    return "decimal";
  }

  protected mapTimestamp(): MySQLDatabaseType {
    return "datetime";
  }

  protected mapDate(): MySQLDatabaseType {
    return "date";
  }

  protected mapJson(): MySQLDatabaseType {
    return "json";
  }
}
