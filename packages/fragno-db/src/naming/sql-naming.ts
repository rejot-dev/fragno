import { createHash } from "node:crypto";
import type { AnySchema, AnyTable } from "../schema/create";

export type NamespaceScope = "suffix" | "schema";

export interface SqlNamingStrategy {
  namespaceScope: NamespaceScope;
  namespaceToSchema: (namespace: string) => string;

  tableName: (logicalTable: string, namespace: string | null) => string;
  columnName: (logicalColumn: string, logicalTable: string) => string;

  indexName: (logicalIndex: string, logicalTable: string, namespace: string | null) => string;
  uniqueIndexName: (logicalIndex: string, logicalTable: string, namespace: string | null) => string;
  foreignKeyName: (params: {
    logicalTable: string;
    logicalReferencedTable: string;
    referenceName: string;
    namespace: string | null;
  }) => string;
}

const normalizeNamespace = (namespace: string | null) =>
  namespace && namespace.length > 0 ? namespace : null;

const buildNamespaceSuffix = (namespace: string | null) => {
  const sanitized = normalizeNamespace(namespace);
  return sanitized ? `_${sanitized}` : "";
};

const MAX_IDENTIFIER_LENGTH = 63;
const HASH_LENGTH = 8;

const withHash = (value: string) => {
  const hash = createHash("sha1").update(value).digest("hex").slice(0, 8);
  return `${value}_${hash}`;
};

const truncateWithHash = (value: string) => {
  if (value.length <= MAX_IDENTIFIER_LENGTH) {
    return value;
  }
  const hash = createHash("sha1").update(value).digest("hex").slice(0, HASH_LENGTH);
  return `${value.slice(0, MAX_IDENTIFIER_LENGTH - HASH_LENGTH)}${hash}`;
};

const buildIndexName = (
  prefix: "idx" | "uidx",
  logicalIndex: string,
  logicalTable: string,
  namespace: string | null,
) => {
  const base = `${logicalTable}_${logicalIndex}${buildNamespaceSuffix(namespace)}`;
  return `${prefix}_${withHash(base)}`;
};

export const suffixNamingStrategy: SqlNamingStrategy = {
  namespaceScope: "suffix",
  namespaceToSchema: (namespace) => namespace,
  tableName: (logicalTable, namespace) => {
    const sanitized = normalizeNamespace(namespace);
    return truncateWithHash(sanitized ? `${logicalTable}_${sanitized}` : logicalTable);
  },
  columnName: (logicalColumn) => logicalColumn,
  indexName: (logicalIndex, logicalTable, namespace) =>
    truncateWithHash(buildIndexName("idx", logicalIndex, logicalTable, namespace)),
  uniqueIndexName: (logicalIndex, logicalTable, namespace) =>
    truncateWithHash(buildIndexName("uidx", logicalIndex, logicalTable, namespace)),
  foreignKeyName: ({ logicalTable, logicalReferencedTable, referenceName, namespace }) => {
    const base = `${logicalTable}_${logicalReferencedTable}_${referenceName}${buildNamespaceSuffix(namespace)}`;
    return truncateWithHash(`fk_${withHash(base)}`);
  },
};

export const schemaNamingStrategy: SqlNamingStrategy = {
  namespaceScope: "schema",
  namespaceToSchema: (namespace) => namespace,
  tableName: (logicalTable) => truncateWithHash(logicalTable),
  columnName: (logicalColumn) => logicalColumn,
  indexName: (logicalIndex) => truncateWithHash(logicalIndex),
  uniqueIndexName: (logicalIndex) => truncateWithHash(logicalIndex),
  foreignKeyName: ({ logicalTable, logicalReferencedTable, referenceName }) =>
    truncateWithHash(`fk_${logicalTable}_${logicalReferencedTable}_${referenceName}`),
};

export class NamingResolver {
  readonly #namespace: string | null;
  readonly #strategy: SqlNamingStrategy;
  readonly #tableNameMap: Record<string, string> = {};
  readonly #columnNameMaps = new Map<string, Record<string, string>>();

  constructor(schema: AnySchema, namespace: string | null, strategy: SqlNamingStrategy) {
    this.#namespace = namespace;
    this.#strategy = strategy;

    for (const table of Object.values(schema.tables)) {
      const physicalTable = this.getTableName(table.name);
      this.#tableNameMap[physicalTable] = table.name;

      const columnMap: Record<string, string> = {};
      for (const column of Object.values(table.columns)) {
        const physicalColumn = this.getColumnName(table.name, column.name);
        columnMap[physicalColumn] = column.name;
      }
      this.#columnNameMaps.set(table.name, columnMap);
    }
  }

  get namespace(): string | null {
    return this.#namespace;
  }

  get strategy(): SqlNamingStrategy {
    return this.#strategy;
  }

  getSchemaName(): string | null {
    if (this.#strategy.namespaceScope !== "schema") {
      return null;
    }
    if (!this.#namespace || this.#namespace.length === 0) {
      return null;
    }
    return this.#strategy.namespaceToSchema(this.#namespace);
  }

  getTableName(logicalTable: string): string {
    return this.#strategy.tableName(logicalTable, this.#namespace);
  }

  getColumnName(logicalTable: string, logicalColumn: string): string {
    return this.#strategy.columnName(logicalColumn, logicalTable);
  }

  getIndexName(logicalIndex: string, logicalTable: string): string {
    return this.#strategy.indexName(logicalIndex, logicalTable, this.#namespace);
  }

  getUniqueIndexName(logicalIndex: string, logicalTable: string): string {
    return this.#strategy.uniqueIndexName(logicalIndex, logicalTable, this.#namespace);
  }

  getForeignKeyName(params: {
    logicalTable: string;
    logicalReferencedTable: string;
    referenceName: string;
  }): string {
    return this.#strategy.foreignKeyName({
      ...params,
      namespace: this.#namespace,
    });
  }

  getTableNameMap(): Record<string, string> {
    return { ...this.#tableNameMap };
  }

  getColumnNameMap(table: AnyTable | string): Record<string, string> {
    const tableName = typeof table === "string" ? table : table.name;
    const map = this.#columnNameMaps.get(tableName);
    return map ? { ...map } : {};
  }
}

export const createNamingResolver = (
  schema: AnySchema,
  namespace: string | null,
  strategy: SqlNamingStrategy,
): NamingResolver => new NamingResolver(schema, namespace, strategy);

/**
 * Sanitizes a namespace for use in SQL identifiers and TypeScript exports.
 * Converts dashes to underscores to ensure compatibility with SQL identifiers.
 *
 * @example
 * sanitizeNamespace("my-fragment") // => "my_fragment"
 */
export function sanitizeNamespace(namespace: string): string {
  return namespace.replace(/-/g, "_");
}
