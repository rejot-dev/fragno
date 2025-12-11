import type { AnySchema, AnyTable } from "../schema/create";
import type { SQLProvider } from "../shared/providers";
import { decodeResult } from "./value-decoding";
import { createCursorFromRecord, type Cursor, type CursorResult } from "./cursor";
import type { RetrievalOperation } from "./unit-of-work/unit-of-work";

/**
 * Decodes a count query result to a number.
 *
 * @param rows - The raw database rows (should contain a single row with a count column)
 * @returns The count as a number
 * @throws If the count value is invalid or missing
 */
export function decodeCountResult(rows: Record<string, unknown>[]): number {
  const firstRow = rows[0];
  if (!firstRow) {
    return 0;
  }
  const count = Number(firstRow["count"]);
  if (Number.isNaN(count)) {
    throw new Error(`Unexpected result for count, received: ${count}`);
  }
  return count;
}

/**
 * Decodes a regular query result set (array of rows).
 *
 * @param rows - The raw database rows
 * @param table - The table schema definition
 * @param provider - The SQL provider (sqlite, postgresql, mysql, etc.)
 * @returns Array of decoded records in application format
 */
export function decodeRowsResult(
  rows: Record<string, unknown>[],
  table: AnyTable,
  provider: SQLProvider,
): Record<string, unknown>[] {
  return rows.map((row) => decodeResult(row, table, provider));
}

/**
 * Decodes a cursor-paginated query result set.
 *
 * Handles cursor generation and hasNextPage detection by checking if
 * we received more rows than the requested pageSize (we fetch pageSize + 1).
 *
 * @param rows - The raw database rows (pageSize + 1 rows)
 * @param table - The table schema definition
 * @param provider - The SQL provider (sqlite, postgresql, mysql, etc.)
 * @param operation - The find operation containing pagination options
 * @returns A CursorResult with items, cursor, and hasNextPage
 */
export function decodeCursorResult(
  rows: Record<string, unknown>[],
  table: AnyTable,
  provider: SQLProvider,
  operation: Extract<RetrievalOperation<AnySchema>, { type: "find" }>,
): CursorResult<unknown> {
  // Decode all rows first
  const decodedRows = rows.map((row) => decodeResult(row, table, provider));

  let cursor: Cursor | undefined;
  let hasNextPage = false;
  let items = decodedRows;

  // Check if there are more results (we fetched pageSize + 1)
  if (operation.options.pageSize && decodedRows.length > operation.options.pageSize) {
    hasNextPage = true;
    // Trim to requested pageSize
    items = decodedRows.slice(0, operation.options.pageSize);

    // Generate cursor from the last item we're returning
    if (operation.options.orderByIndex) {
      const lastItem = items[items.length - 1];
      const indexName = operation.options.orderByIndex.indexName;

      // Get index columns
      let indexColumns;
      if (indexName === "_primary") {
        indexColumns = [table.getIdColumn()];
      } else {
        const index = table.indexes[indexName];
        if (index) {
          indexColumns = index.columns;
        }
      }

      if (indexColumns && lastItem) {
        cursor = createCursorFromRecord(lastItem as Record<string, unknown>, indexColumns, {
          indexName: operation.options.orderByIndex.indexName,
          orderDirection: operation.options.orderByIndex.direction,
          pageSize: operation.options.pageSize,
        });
      }
    }
  }

  return {
    items,
    cursor,
    hasNextPage,
  };
}

/**
 * Decodes a result set based on the operation type.
 *
 * This is the main entry point for decoding query results, routing to the
 * appropriate decoder based on whether it's a count, cursor, or regular query.
 *
 * @param rows - The raw database rows
 * @param operation - The retrieval operation defining how to decode the result
 * @param provider - The SQL provider (sqlite, postgresql, mysql, etc.)
 * @returns The decoded result (number for count, CursorResult for cursor, array otherwise)
 */
export function decodeResultSet(
  rows: Record<string, unknown>[],
  operation: RetrievalOperation<AnySchema>,
  provider: SQLProvider,
): number | Record<string, unknown>[] | CursorResult<unknown> {
  // Handle count operations
  if (operation.type === "count") {
    return decodeCountResult(rows);
  }

  // Handle cursor-paginated queries
  if (operation.withCursor) {
    return decodeCursorResult(rows, operation.table, provider, operation);
  }

  // Handle regular queries
  return decodeRowsResult(rows, operation.table, provider);
}
