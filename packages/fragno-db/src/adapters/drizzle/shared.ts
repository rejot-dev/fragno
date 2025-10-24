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
 * Creates a table name mapper for a given namespace.
 * Physical names have format: {logicalName}_{namespace}
 */
export function createTableNameMapper(namespace: string): TableNameMapper {
  return {
    toPhysical: (logicalName: string) => `${logicalName}_${namespace}`,
    toLogical: (physicalName: string) => {
      if (physicalName.endsWith(`_${namespace}`)) {
        return physicalName.slice(0, -(namespace.length + 1));
      }
      return physicalName;
    },
  };
}

export interface DrizzleResult {
  rows: Record<string, unknown>[];
  affectedRows: number;
}
