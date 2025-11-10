import type { AnySchema, AnyTable } from "../../schema/create";
import type { SQLProvider } from "../../shared/providers";
import type { RetrievalOperation, UOWDecoder } from "../../query/unit-of-work";
import { decodeResult } from "../../query/result-transform";
import { getOrderedJoinColumns } from "./join-column-utils";
import type { DrizzleResult } from "./shared";
import { createCursorFromRecord, Cursor, type CursorResult } from "../../query/cursor";

/**
 * Join information with nested join support
 */
interface JoinInfo {
  relation: { name: string; table: AnyTable };
  options:
    | {
        select: true | string[];
        join?: JoinInfo[];
      }
    | false;
}

/**
 * Recursively transform join arrays to objects, handling nested joins.
 *
 * Drizzle joins use `json_build_array` where nested join data is appended after the parent's columns.
 * For example, if post has columns [id, title, content, _internalId, _version] and a nested author join,
 * the array will be: [id, title, content, _internalId, _version, authorArray]
 *
 * @param value - The join array from Drizzle
 * @param joinInfo - Join metadata including nested joins
 * @param relationName - Name of the current relation (for prefixing column names)
 * @returns Object with flattened keys (relationName:columnName) for all levels
 */
function transformJoinArray(
  value: unknown[],
  joinInfo: JoinInfo,
  relationName: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (joinInfo.options === false) {
    return result;
  }

  const targetTable = joinInfo.relation.table;

  // Get ordered columns using shared utility (must match compiler's column order)
  const orderedSelectedColumns = getOrderedJoinColumns(targetTable, joinInfo.options.select);

  // Map column values to flattened format: relationName:columnName
  for (let i = 0; i < orderedSelectedColumns.length && i < value.length; i++) {
    const columnName = orderedSelectedColumns[i];
    if (columnName) {
      result[`${relationName}:${columnName}`] = value[i];
    }
  }

  // Handle nested joins - they appear after all columns in the array
  if (joinInfo.options.join && joinInfo.options.join.length > 0) {
    let nestedArrayIndex = orderedSelectedColumns.length;

    for (const nestedJoin of joinInfo.options.join) {
      const nestedRelationName = `${relationName}:${nestedJoin.relation.name}`;
      const nestedValue = value[nestedArrayIndex];

      if (Array.isArray(nestedValue)) {
        // Recursively transform nested join
        const nestedResult = transformJoinArray(nestedValue, nestedJoin, nestedRelationName);
        Object.assign(result, nestedResult);
      }

      nestedArrayIndex++;
    }
  }

  return result;
}

/**
 * Drizzle joins using `json_build_array` so the result is a tuple of values that we need to map to
 * the correct columns. This function handles nested joins recursively.
 *
 * @param row - Raw database result row that may contain join arrays
 * @param op - The retrieval operation containing join information
 * @returns Transformed row with join arrays converted to objects
 */
function transformJoinArraysToObjects(
  row: Record<string, unknown>,
  op: {
    type: string;
    table: AnyTable;
    options?: {
      joins?: JoinInfo[];
    };
  },
  provider: SQLProvider,
): Record<string, unknown> {
  // Only process find operations with joins
  if (op.type !== "find" || !op.options?.joins) {
    return row;
  }

  const transformedRow = { ...row };

  for (const join of op.options.joins) {
    const relationName = join.relation.name;
    let value = row[relationName];

    // For SQLite, json_array returns a JSON string that needs to be parsed
    if (provider === "sqlite" && typeof value === "string") {
      try {
        value = JSON.parse(value) as unknown;
      } catch {
        // If parsing fails, skip this join
        continue;
      }
    }

    // Skip if not an array (join didn't return data)
    if (!Array.isArray(value)) {
      continue;
    }

    // Skip if join options are false (join was disabled)
    if (join.options === false) {
      continue;
    }

    // Get the target table for this relation
    const relation = op.table.relations[relationName];
    if (!relation) {
      continue;
    }

    // Recursively transform this join and its nested joins
    const joinResult = transformJoinArray(value, join, relationName);
    Object.assign(transformedRow, joinResult);

    // Remove the original array property
    delete transformedRow[relationName];
  }

  return transformedRow;
}

export function createDrizzleUOWDecoder(provider: SQLProvider): UOWDecoder<DrizzleResult> {
  return (rawResults, ops) => {
    if (rawResults.length !== ops.length) {
      throw new Error("rawResults and ops must have the same length");
    }

    return rawResults.map((result, index) => {
      const op = ops[index] as RetrievalOperation<AnySchema>;
      if (!op) {
        throw new Error("op must be defined");
      }

      // Handle count operations - return the count value directly
      if (op.type === "count") {
        if (result.rows.length > 0 && result.rows[0]) {
          const row = result.rows[0] as Record<string, unknown>;
          const countValue = row["count"] ?? row["count(*)"];

          if (typeof countValue !== "number") {
            throw new Error(`Unexpected result for count, received: ${countValue}`);
          }

          return countValue;
        }
        return 0;
      }

      // Handle find operations - decode each row
      const decodedRows = result.rows.map((row) => {
        const transformedRow = transformJoinArraysToObjects(row, op, provider);
        return decodeResult(transformedRow, op.table, provider);
      });

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

        const cursorResult: CursorResult<unknown> = {
          items,
          cursor,
          hasNextPage,
        };
        return cursorResult;
      }

      return decodedRows;
    });
  };
}
