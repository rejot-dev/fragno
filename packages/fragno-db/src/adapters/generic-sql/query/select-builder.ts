import type { AnyTable } from "../../../schema/create";
import type { AnySelectClause } from "../../../query/query";

/**
 * Maps a select clause to SQL column names with optional aliases.
 *
 * Converts application-level select clauses (either array of keys or "select all")
 * into SQL-compatible column selections with proper aliasing for relations.
 *
 * @param select - The select clause (array of keys or true for all columns)
 * @param table - The table schema containing column definitions
 * @param options - Optional configuration
 * @param options.relation - Relation name to prefix in aliases (for joined data)
 * @param options.tableName - Override the table name in the SQL (defaults to table.name)
 * @returns Array of SQL select strings in the format "tableName.columnName as alias"
 * @internal
 */
export function mapSelect(
  select: AnySelectClause,
  table: AnyTable,
  options: {
    relation?: string;
    tableName?: string;
  } = {},
): string[] {
  const { relation, tableName = table.name } = options;
  const out: string[] = [];
  const keys = Array.isArray(select) ? select : Object.keys(table.columns);

  for (const key of keys) {
    const col = table.columns[key];

    // Skip hidden columns when explicitly selecting
    if (Array.isArray(select) && col.isHidden) {
      continue;
    }

    // Add the column to the select list
    const name = relation ? `${relation}:${key}` : key;
    out.push(`${tableName}.${col.name} as ${name}`);
  }

  // Always include hidden columns (for FragnoId construction with internal ID and version)
  for (const key in table.columns) {
    const col = table.columns[key];
    if (col.isHidden && !keys.includes(key)) {
      const name = relation ? `${relation}:${key}` : key;
      out.push(`${tableName}.${col.name} as ${name}`);
    }
  }

  return out;
}

/**
 * Result type from compiling a select clause with extensions.
 * @internal
 */
export interface CompiledSelect {
  /**
   * The final select clause to use in the query
   */
  result: AnySelectClause;

  /**
   * Keys that were added to the select clause (not originally requested)
   */
  extendedKeys: string[];

  /**
   * Removes the extended keys from a record (mutates the record).
   * Used to clean up keys that were only needed for join operations.
   *
   * @param record - The record to remove extended keys from
   * @returns The same record with extended keys removed
   */
  removeExtendedKeys: (record: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Builder for extending a select clause with additional keys.
 * @internal
 */
export interface SelectBuilder {
  /**
   * Adds a key to the select clause if not already present.
   * Tracks which keys were added for later removal.
   *
   * @param key - The key to add to the select clause
   */
  extend: (key: string) => void;

  /**
   * Compiles the select clause into its final form.
   *
   * @returns The compiled select information
   */
  compile: () => CompiledSelect;
}

/**
 * Creates a builder that can extend a select clause with additional keys.
 *
 * This is useful when you need to temporarily include columns for join operations
 * or other internal processing, but don't want them in the final result.
 *
 * @param original - The original select clause from the user
 * @returns A select builder with extend() and compile() methods
 * @internal
 */
export function extendSelect(original: AnySelectClause): SelectBuilder {
  const select = Array.isArray(original) ? new Set(original) : true;
  const extendedKeys: string[] = [];

  return {
    extend(key) {
      if (select === true || select.has(key)) {
        return;
      }

      select.add(key);
      extendedKeys.push(key);
    },
    compile() {
      return {
        result: select instanceof Set ? Array.from(select) : true,
        extendedKeys,
        removeExtendedKeys(record) {
          for (const key of extendedKeys) {
            delete record[key];
          }
          return record;
        },
      };
    },
  };
}
