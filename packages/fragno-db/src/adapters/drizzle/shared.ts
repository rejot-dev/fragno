import * as Drizzle from "drizzle-orm";
import type * as MySQL from "drizzle-orm/mysql-core";

export type TableType = MySQL.MySqlTableWithColumns<MySQL.TableConfig>;
export type ColumnType = MySQL.AnyMySqlColumn;
export type DBType = MySQL.MySqlDatabase<
  MySQL.MySqlQueryResultHKT,
  MySQL.PreparedQueryHKTBase,
  Record<string, unknown>,
  Drizzle.TablesRelationalConfig
>;

export function parseDrizzle(drizzle: unknown) {
  const db = drizzle as DBType;
  const drizzleTables = db._.fullSchema as Record<string, TableType>;
  if (!drizzleTables || Object.keys(drizzleTables).length === 0) {
    throw new Error(
      "Drizzle adapter requires query mode, make sure to configure it following their guide: https://orm.drizzle.team/docs/rqb.",
    );
  }

  return [db, drizzleTables] as const;
}

/**
 * Maps logical table names (used by fragment authors) to physical table names (with namespace suffix)
 */
export interface TableNameMapper {
  toPhysical(logicalName: string): string;
  toLogical(physicalName: string): string;
}

/**
 * Sanitize a namespace to be a valid JavaScript identifier
 * Replaces hyphens and other invalid characters with underscores
 */
export function sanitizeNamespace(namespace: string): string {
  return namespace.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Creates a table name mapper for a given namespace.
 * Physical names have format: {logicalName}_{sanitizedNamespace}
 * The namespace is sanitized to match TypeScript export names used in the schema
 */
export function createTableNameMapper(namespace: string): TableNameMapper {
  const sanitized = sanitizeNamespace(namespace);
  return {
    toPhysical: (logicalName: string) => `${logicalName}_${sanitized}`,
    toLogical: (physicalName: string) => {
      if (physicalName.endsWith(`_${sanitized}`)) {
        return physicalName.slice(0, -(sanitized.length + 1));
      }
      return physicalName;
    },
  };
}

export interface DrizzleResult {
  rows: Record<string, unknown>[];
  affectedRows: number;
}
