import type { AnyColumn } from "../../schema/create";

export type SQLiteDateStorage = "epoch-ms" | "iso-text";
export type SQLiteBigintStorage = "blob" | "integer";

export const SQLITE_JSON_BLOB_HEX_PREFIX = "__fragno_sqlite_blob_hex__:";

export interface SQLiteStorageMode {
  timestampStorage: SQLiteDateStorage;
  dateStorage: SQLiteDateStorage;
  bigintStorage: SQLiteBigintStorage;
}

export const sqliteStorageDefault: SQLiteStorageMode = {
  timestampStorage: "epoch-ms",
  dateStorage: "epoch-ms",
  bigintStorage: "blob",
};

export const sqliteStoragePrisma: SQLiteStorageMode = {
  timestampStorage: "iso-text",
  dateStorage: "iso-text",
  bigintStorage: "integer",
};

export const isSQLiteBlobStoredColumn = (
  column: AnyColumn,
  storageMode: SQLiteStorageMode = sqliteStorageDefault,
): boolean =>
  column.type === "binary" ||
  (column.type === "bigint" &&
    column.role !== "internal-id" &&
    column.role !== "reference" &&
    storageMode.bigintStorage === "blob");

export const decodeSQLiteJsonBlobValue = (value: string): Uint8Array => {
  if (!value.startsWith(SQLITE_JSON_BLOB_HEX_PREFIX)) {
    throw new Error("SQLite joined BLOB value is missing its Fragno encoding prefix.");
  }

  const hex = value.slice(SQLITE_JSON_BLOB_HEX_PREFIX.length);
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new Error("SQLite joined BLOB value contains invalid hexadecimal data.");
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};
