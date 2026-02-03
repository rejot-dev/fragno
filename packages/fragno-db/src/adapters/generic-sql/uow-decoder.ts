import type { UOWDecoder } from "../../query/unit-of-work/unit-of-work";
import type { RetrievalOperation } from "../../query/unit-of-work/unit-of-work";
import type { AnySchema, AnyTable } from "../../schema/create";
import { decodeResult } from "../../query/value-decoding";
import { createCursorFromRecord, type Cursor, type CursorResult } from "../../query/cursor";
import type { DriverConfig } from "./driver-config";
import type { SQLiteStorageMode } from "./sqlite-storage";
import type { NamingResolver } from "../../naming/sql-naming";

/**
 * Decoder class for Unit of Work retrieval results.
 *
 * Transforms raw database results into application format (e.g., converting raw columns
 * into FragnoId objects with external ID, internal ID, and version).
 */
export class UnitOfWorkDecoder implements UOWDecoder<unknown> {
  readonly #driverConfig: DriverConfig;
  readonly #sqliteStorageMode?: SQLiteStorageMode;
  readonly #resolver?: NamingResolver;

  constructor(
    driverConfig: DriverConfig,
    sqliteStorageMode?: SQLiteStorageMode,
    resolver?: NamingResolver,
  ) {
    this.#driverConfig = driverConfig;
    this.#sqliteStorageMode = sqliteStorageMode;
    this.#resolver = resolver;
  }

  /**
   * Decode raw database results from the retrieval phase
   *
   * @param rawResults - Array of raw result sets from database queries
   * @param operations - Array of retrieval operations that produced these results
   * @returns Decoded results in application format
   */
  decode(rawResults: unknown[], operations: RetrievalOperation<AnySchema>[]): unknown[] {
    if (rawResults.length !== operations.length) {
      throw new Error("rawResults and ops must have the same length");
    }

    return rawResults.map((rows, index) => {
      const op = operations[index];
      if (!op) {
        throw new Error("op must be defined");
      }

      const rowArray = rows as Record<string, unknown>[];
      return this.decodeResultSet(rowArray, op);
    });
  }

  /**
   * Decodes a result set based on the operation type.
   *
   * This is the main entry point for decoding query results, routing to the
   * appropriate decoder based on whether it's a count, cursor, or regular query.
   *
   * @param rows - The raw database rows
   * @param operation - The retrieval operation defining how to decode the result
   * @returns The decoded result (number for count, CursorResult for cursor, array otherwise)
   */
  private decodeResultSet(
    rows: Record<string, unknown>[],
    operation: RetrievalOperation<AnySchema>,
  ): number | Record<string, unknown>[] | CursorResult<unknown> {
    // Handle count operations
    if (operation.type === "count") {
      return this.decodeCountResult(rows);
    }

    const decodedRows = rows.map((row) =>
      decodeResult(
        row,
        operation.table,
        this.#driverConfig,
        this.#sqliteStorageMode,
        this.#resolver,
      ),
    );

    if (operation.withCursor) {
      return this.decodeCursorResult(decodedRows, operation.table, operation);
    }

    return decodedRows;
  }

  /**
   * Decodes a count query result to a number.
   *
   * @param rows - The raw database rows (should contain a single row with a count column)
   * @returns The count as a number
   * @throws If the count value is invalid or missing
   */
  private decodeCountResult(rows: Record<string, unknown>[]): number {
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
   * Handles cursor generation and hasNextPage detection for cursor-paginated queries.
   *
   * Checks if we received more rows than the requested pageSize (we fetch pageSize + 1).
   *
   * @param decodedRows - The already-decoded database rows (pageSize + 1 rows)
   * @param table - The table schema definition (needed for cursor generation)
   * @param operation - The find operation containing pagination options
   * @returns A CursorResult with items, cursor, and hasNextPage
   */
  private decodeCursorResult(
    decodedRows: Record<string, unknown>[],
    table: AnyTable,
    operation: Extract<RetrievalOperation<AnySchema>, { type: "find" }>,
  ): CursorResult<unknown> {
    let cursor: Cursor | undefined;
    let hasNextPage = false;
    let items = decodedRows;

    // Check if there are more results (we fetched pageSize + 1)
    if (
      operation.options.pageSize &&
      operation.options.pageSize > 0 &&
      decodedRows.length > operation.options.pageSize
    ) {
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
          cursor = createCursorFromRecord(lastItem, indexColumns, {
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
}
