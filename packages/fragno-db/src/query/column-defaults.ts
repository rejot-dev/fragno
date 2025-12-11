import type { AnyColumn } from "../schema/create";
import { createId } from "../id";

/**
 * Generate a runtime default value for a column that has defaultTo$()
 *
 * Only generates values for runtime defaults (defaultTo$), NOT static defaults (defaultTo).
 * Static defaults should be handled by the database via DEFAULT constraints.
 *
 * @param column - The column with a default value configuration
 * @returns The generated default value, or undefined if the column has no runtime default
 *
 * @internal
 */
export function generateRuntimeDefault(column: AnyColumn): unknown {
  // Check if column has a default value configuration
  if (!column.default) {
    return undefined;
  }

  // If it's a static default value (defaultTo), return undefined
  // as the database should handle this via DEFAULT constraint
  if ("value" in column.default) {
    return undefined;
  }

  // If it's a database-level special function (defaultTo(b => b.now())), return undefined
  // as the database should handle this via DEFAULT NOW() or equivalent
  if ("dbSpecial" in column.default) {
    return undefined;
  }

  // Handle runtime defaults (defaultTo$)
  const runtime = column.default.runtime;

  if (runtime === "cuid") {
    return createId();
  }

  if (runtime === "now") {
    return new Date();
  }

  if (typeof runtime === "function") {
    return runtime();
  }

  return undefined;
}
