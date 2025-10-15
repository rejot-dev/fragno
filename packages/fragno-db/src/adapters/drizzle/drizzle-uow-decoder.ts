import type { AnySchema, AnyTable } from "../../schema/create";
import type { SQLProvider } from "../../shared/providers";
import type { RetrievalOperation, UOWDecoder } from "../../query/unit-of-work";
import { decodeResult } from "../../query/result-transform";
import type { DrizzleResult } from "./drizzle-query";

/**
 * Drizzle joins using `json_build_array` so the result is a tuple of values that we need to map to
 * the correct columns.
 *
 * @param row - Raw database result row that may contain join arrays
 * @param op - The retrieval operation containing join information
 * @param drizzleTables - Map of table names to Drizzle table objects
 * @returns Transformed row with join arrays converted to objects
 */
function transformJoinArraysToObjects(
  row: Record<string, unknown>,
  op: {
    type: string;
    table: AnyTable;
    options?: {
      joins?: { relation: { name: string }; options: { select: true | string[] } | false }[];
    };
  },
  drizzleTables: Record<string, unknown>,
): Record<string, unknown> {
  // Only process find operations with joins
  if (op.type !== "find" || !op.options?.joins) {
    return row;
  }

  const transformedRow = { ...row };

  for (const join of op.options.joins) {
    const relationName = join.relation.name;
    const value = row[relationName];

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

    const targetTable = relation.table;
    const drizzleTable = drizzleTables[targetTable.ormName] as Record<string, unknown>;

    if (!drizzleTable) {
      continue;
    }

    // Determine which columns were selected using the EXACT same logic as in drizzle-uow-compiler.ts
    // This ensures the column order matches the SQL array order
    const orderedSelectedColumns: string[] = [];

    if (join.options.select === true) {
      // All columns selected - iterate in the order they appear in targetTable.columns
      for (const col of Object.values(targetTable.columns)) {
        orderedSelectedColumns.push(col.ormName);
      }
    } else {
      // Specific columns selected
      for (const colKey of join.options.select) {
        const col = targetTable.columns[colKey];
        if (col) {
          orderedSelectedColumns.push(col.ormName);
        }
      }
      // Add hidden columns at the end
      for (const col of Object.values(targetTable.columns)) {
        if (col && col.isHidden && !orderedSelectedColumns.includes(col.ormName)) {
          orderedSelectedColumns.push(col.ormName);
        }
      }
    }

    // Map array values to flattened format: relationName:columnName
    // This matches the format expected by decodeResult
    for (let i = 0; i < orderedSelectedColumns.length && i < value.length; i++) {
      const columnName = orderedSelectedColumns[i];
      if (columnName) {
        transformedRow[`${relationName}:${columnName}`] = value[i];
      }
    }

    // Remove the original array property
    delete transformedRow[relationName];
  }

  return transformedRow;
}

export function createDrizzleUOWDecoder<TSchema extends AnySchema>(
  _schema: TSchema,
  drizzleTables: Record<string, unknown>,
  provider: SQLProvider,
): UOWDecoder<TSchema, DrizzleResult> {
  return (rawResults, ops) => {
    if (rawResults.length !== ops.length) {
      throw new Error("rawResults and ops must have the same length");
    }

    return rawResults.map((result, index) => {
      const op = ops[index] as RetrievalOperation<TSchema>;
      if (!op) {
        throw new Error("op must be defined");
      }

      // Handle count operations - return the count value directly
      if (op.type === "count") {
        if (result.rows.length > 0 && result.rows[0]) {
          const row = result.rows[0];
          return (row as Record<string, unknown>)["count"] as number;
        }
        return 0;
      }

      // Handle find operations - decode each row
      return result.rows.map((row) => {
        const transformedRow = transformJoinArraysToObjects(row, op, drizzleTables);
        return decodeResult(transformedRow, op.table, provider);
      });
    });
  };
}
