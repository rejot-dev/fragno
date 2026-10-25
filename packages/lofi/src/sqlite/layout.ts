import { suffixNamingStrategy } from "@fragno-dev/db/naming";
import { getTableForeignKey, type AnyColumn, type AnyTable } from "@fragno-dev/db/schema";

import { normalizeLofiSchemaName } from "../local/projection";
import type { LofiSchemaRegistration } from "../types";
import { encodeSqliteValue, type SqliteValue } from "./values";

/**
 * Bump when the physical layout changes. Replicas are named by this version, so a bump opens a
 * fresh database and replays the outbox instead of migrating.
 */
export const LOFI_SQLITE_LAYOUT_VERSION = 3;

/** Physical table of one registered Fragno table. */
export type SqliteTableLayout = {
  sqlName: string;
  table: AnyTable;
  /** Per reference column, a subquery that maps the referenced external id to its internal id. */
  referenceLookups: ReadonlyMap<string, string>;
};

/**
 * Names a replica table like the backend's SQLite table: `<table>_<namespace>`, where the
 * namespace is the schema name the outbox reports.
 */
export function lofiSqliteTableName(registration: LofiSchemaRegistration, table: string): string {
  return suffixNamingStrategy.tableName(table, registeredSchemaName(registration));
}

export function registeredSchemaName(registration: LofiSchemaRegistration): string {
  return registration.schemaName ?? normalizeLofiSchemaName(registration.schema.name);
}

export function createSqliteTableLayouts(
  registration: LofiSchemaRegistration,
): Map<string, SqliteTableLayout> {
  const layouts = new Map<string, SqliteTableLayout>();
  for (const table of Object.values(registration.schema.tables)) {
    const referenceLookups = new Map<string, string>();
    for (const column of Object.values(table.columns)) {
      if (column.role !== "reference") {
        continue;
      }
      const foreignKey = getTableForeignKey(table, column.name);
      if (!foreignKey) {
        throw new Error(`Reference column has no foreign key: ${table.name}.${column.name}`);
      }
      const referenced = foreignKey.referencedTable;
      referenceLookups.set(
        column.name,
        `(SELECT ${quoteSqliteIdentifier(referenced.getInternalIdColumn().name)} FROM ${quoteSqliteIdentifier(
          lofiSqliteTableName(registration, referenced.name),
        )} WHERE ${quoteSqliteIdentifier(referenced.getIdColumn().name)} = ?)`,
      );
    }
    layouts.set(table.name, {
      sqlName: lofiSqliteTableName(registration, table.name),
      table,
      referenceLookups,
    });
  }
  return layouts;
}

/**
 * Mirrors the backend's SQLite tables with two deliberate differences: the replica has no foreign
 * keys, because it may mirror only some schemas, and every index is non-unique, because a row
 * deleted without an outbox mutation stays in the replica while a new row reuses its unique values.
 */
export function createSqliteTableStatements(
  registration: LofiSchemaRegistration,
  layout: SqliteTableLayout,
): string[] {
  const namespace = registeredSchemaName(registration);
  const columns = Object.values(layout.table.columns).map(
    (column) => `${quoteSqliteIdentifier(column.name)} ${columnDefinition(column)}`,
  );
  const statements = [
    `CREATE TABLE IF NOT EXISTS ${quoteSqliteIdentifier(layout.sqlName)} (${columns.join(", ")})`,
  ];
  for (const index of Object.values(layout.table.indexes)) {
    const indexName = index.unique
      ? suffixNamingStrategy.uniqueIndexName(index.name, layout.table.name, namespace)
      : suffixNamingStrategy.indexName(index.name, layout.table.name, namespace);
    statements.push(
      `CREATE INDEX IF NOT EXISTS ${quoteSqliteIdentifier(indexName)} ON ${quoteSqliteIdentifier(
        layout.sqlName,
      )} (${index.columnNames.map(quoteSqliteIdentifier).join(", ")})`,
    );
  }
  return statements;
}

export function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

const COLUMN_DEFINITIONS: Record<AnyColumn["role"], (column: AnyColumn) => string> = {
  // AUTOINCREMENT never reuses a deleted row's id, so dangling references cannot be adopted.
  "internal-id": () => "INTEGER PRIMARY KEY AUTOINCREMENT",
  "external-id": () => "TEXT NOT NULL UNIQUE",
  version: () => "INTEGER NOT NULL DEFAULT 0",
  reference: () => "INTEGER",
  regular: (column) => `${sqliteStorageType(column)}${defaultClause(column)}`,
};

/**
 * A regular column's fixed default, as the backend's migration declares it. Creates that leave the
 * column out get it, as rows did on the backend: an outbox entry written before the column existed
 * does not mention it. Defaults computed by the database or by application code have no fixed
 * value; the backend gives rows from before such a column NULL, or the migration's time, which the
 * outbox does not carry.
 */
function defaultClause(column: AnyColumn): string {
  const fixed = column.default;
  if (!fixed || !("value" in fixed) || fixed.value === undefined) {
    return "";
  }
  const literal = sqliteLiteral(encodeSqliteValue(column, fixed.value));
  return literal === null ? "" : ` DEFAULT ${literal}`;
}

function sqliteLiteral(value: SqliteValue): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (value instanceof Uint8Array) {
    return `X'${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}'`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return null;
  }
  return String(value);
}

function columnDefinition(column: AnyColumn): string {
  return COLUMN_DEFINITIONS[column.role](column);
}

function sqliteStorageType(column: AnyColumn): string {
  switch (column.type) {
    case "integer":
    case "bigint":
    case "bool":
    case "date":
    case "timestamp":
      return "INTEGER";
    case "decimal":
      return "REAL";
    case "binary":
      return "BLOB";
    case "string":
    case "text":
    case "json":
    default: // varchar(n)
      return "TEXT";
  }
}
