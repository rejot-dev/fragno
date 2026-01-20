export type SQLiteDateStorage = "epoch-ms" | "iso-text";
export type SQLiteBigintStorage = "blob" | "integer";

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
