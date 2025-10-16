import type { AnyTable } from "../../schema/create";

/**
 * Determine the ordered list of columns for a join selection.
 *
 * This logic is shared between the compiler (which builds the SQL)
 * and the decoder (which maps the result array back to objects).
 * The order MUST match exactly for the decoder to work correctly.
 *
 * @param targetTable - The table being joined
 * @param select - Selection options (true for all columns, or array of column keys)
 * @returns Array of column ORM names in the order they appear in the SQL/result
 */
export function getOrderedJoinColumns(targetTable: AnyTable, select: true | string[]): string[] {
  const orderedColumns: string[] = [];

  if (select === true) {
    // All columns selected - iterate in the order they appear in targetTable.columns
    for (const col of Object.values(targetTable.columns)) {
      orderedColumns.push(col.ormName);
    }
  } else {
    // Specific columns selected
    for (const colKey of select) {
      const col = targetTable.columns[colKey];
      if (col) {
        orderedColumns.push(col.ormName);
      }
    }
    // Add hidden columns at the end (for FragnoId construction)
    for (const col of Object.values(targetTable.columns)) {
      if (col && col.isHidden && !orderedColumns.includes(col.ormName)) {
        orderedColumns.push(col.ormName);
      }
    }
  }

  return orderedColumns;
}
