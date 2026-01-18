import type { AnyColumn } from "../../create";
import { SQLTypeMapper, type SQLiteDatabaseType } from "../type-mapping";
import type { SQLiteProfile } from "../../../adapters/generic-sql/driver-config";

/**
 * SQLite-specific type mapper.
 *
 * SQLite has a limited type system with only 4 storage classes:
 * - INTEGER for integers, booleans, timestamps, dates (and reference columns)
 * - BLOB for binary data and bigints (except for reference columns)
 * - TEXT for strings, JSON, and varchar
 * - REAL for decimals
 */
export class SQLiteTypeMapper extends SQLTypeMapper<SQLiteDatabaseType> {
  private readonly sqliteProfile: SQLiteProfile;

  constructor(database: "sqlite", sqliteProfile: SQLiteProfile = "fragno") {
    super(database);
    this.sqliteProfile = sqliteProfile;
  }

  protected getInternalIdType(): SQLiteDatabaseType {
    // SQLite uses INTEGER for auto-increment (INTEGER PRIMARY KEY)
    return "integer";
  }

  protected mapInteger(_column: AnyColumn | Pick<AnyColumn, "type">): SQLiteDatabaseType {
    return "integer";
  }

  protected mapBigint(column: AnyColumn | Pick<AnyColumn, "type">): SQLiteDatabaseType {
    // SQLite special case: reference columns should use integer even if type is bigint
    if ("role" in column && column.role === "reference") {
      return "integer";
    }
    if (this.sqliteProfile === "prisma") {
      return "integer";
    }
    return "blob";
  }

  protected mapString(): SQLiteDatabaseType {
    return "text";
  }

  protected mapVarchar(_length: number): SQLiteDatabaseType {
    // SQLite doesn't support varchar - convert to text
    return "text";
  }

  protected mapBinary(): SQLiteDatabaseType {
    return "blob";
  }

  protected mapBool(): SQLiteDatabaseType {
    return "integer";
  }

  protected mapDecimal(): SQLiteDatabaseType {
    return "real";
  }

  protected mapTimestamp(): SQLiteDatabaseType {
    if (this.sqliteProfile === "prisma") {
      return "text";
    }
    return "integer";
  }

  protected mapDate(): SQLiteDatabaseType {
    if (this.sqliteProfile === "prisma") {
      return "text";
    }
    return "integer";
  }

  protected mapJson(): SQLiteDatabaseType {
    return "text";
  }
}
