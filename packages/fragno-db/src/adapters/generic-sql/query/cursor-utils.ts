import type { AnyColumn } from "../../../schema/create";
import type { Condition } from "../../../query/condition-builder";
import { decodeCursor, serializeCursorValues, type Cursor } from "../../../query/cursor";
import type { DriverConfig } from "../driver-config";
import type { SQLiteStorageMode } from "../sqlite-storage";

/**
 * Build a cursor condition for pagination.
 *
 * Handles both single-column and multi-column cursor comparisons.
 * For single columns: uses simple comparison (col > value)
 * For multi-columns: builds tuple comparison ((col1, col2) > (val1, val2))
 *
 * @param cursor - The cursor string or object
 * @param indexColumns - Columns used in the index for ordering
 * @param orderDirection - Direction of ordering (asc/desc)
 * @param isAfter - True for "after" cursor (forward pagination), false for "before" (backward)
 * @param driverConfig - The driver configuration for value serialization
 * @param sqliteStorageMode - Optional SQLite storage mode for date/bigint serialization
 * @returns A Condition object for the cursor, or undefined if no cursor
 * @throws Error if multi-column cursors are not supported by the implementation
 */
export function buildCursorCondition(
  cursor: string | Cursor | undefined,
  indexColumns: AnyColumn[],
  orderDirection: "asc" | "desc",
  isAfter: boolean,
  driverConfig: DriverConfig,
  sqliteStorageMode?: SQLiteStorageMode,
): Condition | undefined {
  if (!cursor || indexColumns.length === 0) {
    return undefined;
  }

  // Decode cursor if it's a string, otherwise use it as-is
  const cursorObj = typeof cursor === "string" ? decodeCursor(cursor) : cursor;
  const serializedValues = serializeCursorValues(
    cursorObj,
    indexColumns,
    driverConfig,
    sqliteStorageMode,
  );

  // Determine comparison operator based on direction and after/before
  const useGreaterThan =
    (isAfter && orderDirection === "asc") || (!isAfter && orderDirection === "desc");

  if (indexColumns.length === 1) {
    // Simple single-column case
    const col = indexColumns[0]!;
    const val = serializedValues[col.name];
    const operator = useGreaterThan ? ">" : "<";
    return {
      type: "compare",
      a: col,
      operator,
      b: val,
    };
  }

  const operator = useGreaterThan ? ">" : "<";
  const orConditions: Condition[] = [];
  const isNullish = (value: unknown): value is null | undefined =>
    value === null || value === undefined;
  const buildEqualityCondition = (column: AnyColumn, value: unknown): Condition =>
    isNullish(value)
      ? { type: "compare", a: column, operator: "is", b: null }
      : { type: "compare", a: column, operator: "=", b: value };

  for (let i = 0; i < indexColumns.length; i += 1) {
    const col = indexColumns[i]!;
    const val = serializedValues[col.name];
    const andItems: Condition[] = [];

    for (let j = 0; j < i; j += 1) {
      const prevCol = indexColumns[j]!;
      andItems.push(buildEqualityCondition(prevCol, serializedValues[prevCol.name]));
    }

    andItems.push({
      type: "compare",
      a: col,
      operator,
      b: val,
    });

    orConditions.push(andItems.length === 1 ? andItems[0]! : { type: "and", items: andItems });
  }

  return { type: "or", items: orConditions };
}
