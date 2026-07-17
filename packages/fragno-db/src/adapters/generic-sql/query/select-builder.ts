import { sql, type AliasedRawBuilder, type RawBuilder } from "kysely";

import type { NamingResolver } from "../../../naming/sql-naming";
import type { AnySelectClause } from "../../../query/mod";
import type { AnyColumn, AnyTable } from "../../../schema/create";
import type { DriverConfig } from "../driver-config";

export type MappedSelectColumn = {
  column: AnyColumn;
  reference: string;
  alias: string;
};

export type ProjectedSelectExpression = AliasedRawBuilder<unknown, string>;

/** Resolves logical selections to physical column references while preserving column metadata. */
export function mapSelectColumns(
  select: AnySelectClause,
  table: AnyTable,
  resolver: NamingResolver | undefined,
  options: {
    relation?: string;
    tableName?: string;
  } = {},
): MappedSelectColumn[] {
  const { relation, tableName = table.name } = options;
  const out: MappedSelectColumn[] = [];
  const keys = Array.isArray(select) ? select : Object.keys(table.columns);

  const addColumn = (key: string, column: AnyColumn): void => {
    const alias = relation ? `${relation}:${key}` : key;
    const columnName = resolver ? resolver.getColumnName(table.name, column.name) : column.name;
    out.push({ column, reference: `${tableName}.${columnName}`, alias });
  };

  for (const key of keys) {
    const column = table.columns[key];

    // Skip hidden columns when explicitly selecting
    if (Array.isArray(select) && column.isHidden) {
      continue;
    }

    addColumn(key, column);
  }

  // Always include hidden columns (for FragnoId construction with internal ID and version)
  for (const key in table.columns) {
    const column = table.columns[key];
    if (column.isHidden && !keys.includes(key)) {
      addColumn(key, column);
    }
  }

  return out;
}

/**
 * Projects a selected value into the result shape expected by its serializer.
 * MySQL DATE values are cast before mysql2 can interpret the timezone-less value as an instant.
 */
export function projectSelectedColumnValue(
  column: AnyColumn,
  reference: string,
  driverConfig: DriverConfig,
): RawBuilder<unknown> {
  const columnReference = sql.ref(reference);
  if (driverConfig.databaseType === "mysql" && column.type === "date") {
    return sql<string>`cast(${columnReference} as char)`;
  }
  return columnReference;
}

export function projectSelectedColumn(
  mappedColumn: MappedSelectColumn,
  driverConfig: DriverConfig,
): ProjectedSelectExpression {
  return projectSelectedColumnValue(mappedColumn.column, mappedColumn.reference, driverConfig).as(
    mappedColumn.alias,
  );
}

/** Maps selected columns to SQL strings for mutation RETURNING clauses. */
export function mapSelect(
  select: AnySelectClause,
  table: AnyTable,
  resolver: NamingResolver | undefined,
  options: {
    relation?: string;
    tableName?: string;
  } = {},
): string[] {
  return mapSelectColumns(select, table, resolver, options).map(
    ({ reference, alias }) => `${reference} as ${alias}`,
  );
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
