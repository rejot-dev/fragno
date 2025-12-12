import type { AnyColumn } from "../../../schema/create";
import type { Condition } from "../../../query/condition-builder";
import { decodeCursor, serializeCursorValues, type Cursor } from "../../../query/cursor";
import type { DriverConfig } from "../driver-config";

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
 * @returns A Condition object for the cursor, or undefined if no cursor
 * @throws Error if multi-column cursors are not supported by the implementation
 */
export function buildCursorCondition(
  cursor: string | Cursor | undefined,
  indexColumns: AnyColumn[],
  orderDirection: "asc" | "desc",
  isAfter: boolean,
  driverConfig: DriverConfig,
): Condition | undefined {
  if (!cursor || indexColumns.length === 0) {
    return undefined;
  }

  // Decode cursor if it's a string, otherwise use it as-is
  const cursorObj = typeof cursor === "string" ? decodeCursor(cursor) : cursor;
  const serializedValues = serializeCursorValues(cursorObj, indexColumns, driverConfig);

  // Determine comparison operator based on direction and after/before
  const useGreaterThan =
    (isAfter && orderDirection === "asc") || (!isAfter && orderDirection === "desc");

  if (indexColumns.length === 1) {
    // Simple single-column case
    const col = indexColumns[0]!;
    const val = serializedValues[col.ormName];
    const operator = useGreaterThan ? ">" : "<";
    return {
      type: "compare",
      a: col,
      operator,
      b: val,
    };
  } else {
    throw new Error(
      "Multi-column cursor pagination is not yet supported in Generic SQL implementation",
    );
  }
}
