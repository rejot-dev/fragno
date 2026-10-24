import type { AnyColumn, IdColumn } from "@fragno-dev/db/schema";

import { decodeSqliteValue, type SqliteValue } from "./values";

/**
 * How a query decodes one result column: like a regular schema column it selects, or as a plain
 * SQLite integer or text, such as an aggregate, an id, or a computed expression.
 */
export type LofiSqliteResultColumn = AnyColumn | "integer" | "text";

type ResultValue<TColumn> = TColumn extends "integer"
  ? number
  : TColumn extends "text"
    ? string
    : TColumn extends IdColumn
      ? never
      : TColumn extends { $out: infer TOut }
        ? TOut
        : never;

export type LofiSqliteQuery<TColumns extends Record<string, LofiSqliteResultColumn>> = {
  sql: string;
  params: readonly SqliteValue[];
  columns: TColumns;
};

export type LofiSqliteQueryRow<TColumns extends Record<string, LofiSqliteResultColumn>> = {
  [TName in keyof TColumns]: ResultValue<TColumns[TName]>;
};

/**
 * Decodes raw rows with the query's declared columns. SQL is a string the type checker cannot see
 * into, so a declared column missing from the result, or a NULL in a plain integer or text column,
 * throws instead of reading as a value of the wrong type.
 */
export function decodeLofiSqliteQueryRows<TColumns extends Record<string, LofiSqliteResultColumn>>(
  query: LofiSqliteQuery<TColumns>,
  rows: readonly Readonly<Record<string, unknown>>[],
): LofiSqliteQueryRow<TColumns>[] {
  return rows.map((row) => {
    const decoded: Record<string, unknown> = {};
    for (const [name, column] of Object.entries(query.columns)) {
      if (!(name in row)) {
        throw new Error(`Query result has no column "${name}": ${query.sql}`);
      }
      const value = row[name];
      if (typeof column !== "string") {
        decoded[name] = decodeSqliteValue(column, value);
        continue;
      }
      if (value === null) {
        throw new Error(`Query result column "${name}" is NULL: ${query.sql}`);
      }
      decoded[name] = column === "integer" ? Number(value) : value;
    }
    return decoded as LofiSqliteQueryRow<TColumns>;
  });
}
