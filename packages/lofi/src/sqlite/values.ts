import { FragnoId, FragnoReference, type AnyColumn, type AnyTable } from "@fragno-dev/db/schema";

export type SqliteValue = null | string | number | bigint | Uint8Array;

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** Encodes a regular column value with the backend's SQLite storage, except bigint as INTEGER. */
export function encodeSqliteValue(column: AnyColumn, value: unknown): SqliteValue {
  if (value === null || value === undefined) {
    return null;
  }
  switch (column.type) {
    case "date":
    case "timestamp":
      return (value as Date).getTime();
    case "bool":
      return value ? 1 : 0;
    case "json":
      return JSON.stringify(value);
    case "bigint": {
      const bigint = value as bigint;
      // wa-sqlite stores out-of-range bigint bindings as NULL without reporting an error.
      if (bigint < INT64_MIN || bigint > INT64_MAX) {
        throw new RangeError(`Bigint value for ${column.name} does not fit in 64 bits: ${bigint}`);
      }
      return bigint;
    }
    case "integer":
    case "decimal":
    case "string":
    case "text":
    case "binary":
    default: // varchar(n)
      return value as SqliteValue;
  }
}

/**
 * Decodes one replica row into the record shape Fragno queries return: `FragnoId` for the
 * external id, `FragnoReference` for references, and column types restored from storage.
 */
export function decodeLofiSqliteRow(
  table: AnyTable,
  row: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(table.columns)) {
    const value = row[column.name];
    switch (column.role) {
      case "external-id":
        record[key] = new FragnoId({
          externalId: value as string,
          internalId: BigInt(row[table.getInternalIdColumn().name] as number | bigint),
          version: Number(row[table.getVersionColumn().name]),
        });
        break;
      case "internal-id":
        record[key] = BigInt(value as number | bigint);
        break;
      case "version":
        record[key] = Number(value);
        break;
      case "reference":
        record[key] =
          value === null ? null : FragnoReference.fromInternal(BigInt(value as number | bigint));
        break;
      case "regular":
        record[key] = decodeSqliteValue(column, value);
        break;
    }
  }
  return record;
}

export function decodeSqliteValue(column: AnyColumn, value: unknown): unknown {
  if (value === null) {
    return null;
  }
  switch (column.type) {
    case "date":
    case "timestamp":
      return new Date(Number(value));
    case "bool":
      return Number(value) !== 0;
    case "json":
      return JSON.parse(value as string);
    // wa-sqlite returns integers as numbers when they are safe and as bigints otherwise.
    case "bigint":
      return BigInt(value as number | bigint);
    case "integer":
    case "decimal":
      return Number(value);
    case "string":
    case "text":
    case "binary":
    default: // varchar(n)
      return value;
  }
}
