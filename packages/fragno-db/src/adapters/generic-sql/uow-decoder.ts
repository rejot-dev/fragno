import type { UOWDecoder } from "../../query/unit-of-work";
import { decodeResult } from "../../query/result-transform";
import type { SQLProvider } from "../../shared/providers";
import { createCursorFromRecord, Cursor, type CursorResult } from "../../query/cursor";

/**
 * Creates a UOWDecoder for Kysely that transforms raw query results into application format.
 *
 * The decoder handles:
 * - Count operations (returning number directly)
 * - Regular queries (decoding rows using provider-specific logic)
 * - Cursor-based pagination (generating cursors and handling hasNextPage)
 *
 * @param provider - SQL provider for proper result decoding
 * @returns A UOWDecoder instance for transforming results
 */
export function createKyselyUOWDecoder(provider: SQLProvider): UOWDecoder<unknown> {
  return (rawResults, ops) => {
    if (rawResults.length !== ops.length) {
      throw new Error("rawResults and ops must have the same length");
    }

    return rawResults.map((rows, index) => {
      const op = ops[index];
      if (!op) {
        throw new Error("op must be defined");
      }

      // Handle count operations differently - return the count number directly
      if (op.type === "count") {
        const rowArray = rows as Record<string, unknown>[];
        const firstRow = rowArray[0];
        if (!firstRow) {
          return 0;
        }
        const count = Number(firstRow["count"]);
        if (Number.isNaN(count)) {
          throw new Error(`Unexpected result for count, received: ${count}`);
        }
        return count;
      }

      // Each result is an array of rows - decode each row
      const rowArray = rows as Record<string, unknown>[];
      const decodedRows = rowArray.map((row) => decodeResult(row, op.table, provider));

      // If cursor generation is requested, wrap in CursorResult
      if (op.withCursor) {
        let cursor: Cursor | undefined;
        let hasNextPage = false;
        let items = decodedRows;

        // Check if there are more results (we fetched pageSize + 1)
        if (op.options.pageSize && decodedRows.length > op.options.pageSize) {
          hasNextPage = true;
          // Trim to requested pageSize
          items = decodedRows.slice(0, op.options.pageSize);

          // Generate cursor from the last item we're returning
          if (op.options.orderByIndex) {
            const lastItem = items[items.length - 1];
            const indexName = op.options.orderByIndex.indexName;

            // Get index columns
            let indexColumns;
            if (indexName === "_primary") {
              indexColumns = [op.table.getIdColumn()];
            } else {
              const index = op.table.indexes[indexName];
              if (index) {
                indexColumns = index.columns;
              }
            }

            if (indexColumns && lastItem) {
              cursor = createCursorFromRecord(lastItem as Record<string, unknown>, indexColumns, {
                indexName: op.options.orderByIndex.indexName,
                orderDirection: op.options.orderByIndex.direction,
                pageSize: op.options.pageSize,
              });
            }
          }
        }

        const result: CursorResult<unknown> = {
          items,
          cursor,
          hasNextPage,
        };
        return result;
      }

      return decodedRows;
    });
  };
}
