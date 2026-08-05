import { createNamingResolver, type NamingResolver } from "../../naming/sql-naming";
import type { SqlDriverAdapter } from "../../sql-driver/sql-driver-adapter";
import type { DatabaseAdapter } from "../adapters";
import type { SqlAdapter } from "../generic-sql/generic-sql-adapter";
import type {
  MigrationInspector,
  ObservedColumn,
  ObservedForeignKey,
  ObservedIndex,
  ObservedSchema,
} from "./migration-suite-harness";

export abstract class BaseSqlMigrationInspector implements MigrationInspector {
  async inspectSchema({
    adapter,
    schema,
    namespace,
  }: Parameters<MigrationInspector["inspectSchema"]>[0]) {
    const sqlAdapter = asSqlAdapter(adapter);
    const resolver = createNamingResolver(schema, namespace, adapter.namingStrategy);
    const tables: ObservedSchema["tables"] = {};

    for (const [logicalTableName, table] of Object.entries(schema.tables)) {
      const physicalTableName = resolver.getTableName(logicalTableName);
      const exists = await this.tableExists(sqlAdapter.driver, physicalTableName, resolver);
      const columns: Record<string, ObservedColumn> = {};
      const indexes: Record<string, ObservedIndex> = {};

      if (exists) {
        const physicalColumns = await this.inspectColumns(
          sqlAdapter.driver,
          physicalTableName,
          resolver,
        );
        for (const column of Object.values(table.columns)) {
          const physicalColumnName = resolver.getColumnName(logicalTableName, column.name);
          columns[column.name] = physicalColumns[physicalColumnName] ?? { exists: false };
        }

        for (const index of Object.values(table.indexes)) {
          const physicalIndexName = index.unique
            ? resolver.getUniqueIndexName(index.name, logicalTableName)
            : resolver.getIndexName(index.name, logicalTableName);
          indexes[index.name] = (await this.inspectIndex(
            sqlAdapter.driver,
            physicalTableName,
            physicalIndexName,
            resolver,
          )) ?? { exists: false };
        }

        const shardIndexName = resolver.getIndexName(
          `idx_${logicalTableName}_shard`,
          logicalTableName,
        );
        indexes[`idx_${logicalTableName}_shard`] = (await this.inspectIndex(
          sqlAdapter.driver,
          physicalTableName,
          shardIndexName,
          resolver,
        )) ?? { exists: false };
      }

      tables[logicalTableName] = {
        exists,
        columns,
        indexes,
        foreignKeys: exists
          ? await this.inspectForeignKeys(sqlAdapter.driver, physicalTableName, resolver)
          : [],
      };
    }

    return {
      tables,
      settings: await this.inspectSettings(sqlAdapter.driver),
    };
  }

  async bootstrapLegacyV1({
    adapter,
    schema,
    namespace,
  }: Parameters<MigrationInspector["bootstrapLegacyV1"]>[0]) {
    const sqlAdapter = asSqlAdapter(adapter);
    const resolver = createNamingResolver(schema, namespace, adapter.namingStrategy);
    for (const statement of this.legacyCurrentStatements(resolver)) {
      await sqlAdapter.driver.executeQuery({ sql: statement, parameters: [] });
    }
  }

  protected abstract tableExists(
    driver: SqlDriverAdapter,
    tableName: string,
    resolver: NamingResolver,
  ): Promise<boolean>;

  protected abstract inspectColumns(
    driver: SqlDriverAdapter,
    tableName: string,
    resolver: NamingResolver,
  ): Promise<Record<string, ObservedColumn>>;

  protected abstract inspectIndex(
    driver: SqlDriverAdapter,
    tableName: string,
    indexName: string,
    resolver: NamingResolver,
  ): Promise<ObservedIndex | undefined>;

  protected abstract inspectForeignKeys(
    driver: SqlDriverAdapter,
    tableName: string,
    resolver: NamingResolver,
  ): Promise<ObservedForeignKey[]>;

  protected abstract inspectSettings(
    driver: SqlDriverAdapter,
  ): Promise<Record<string, string | undefined>>;

  protected abstract legacyCurrentStatements(resolver: NamingResolver): string[];
}

function asSqlAdapter(adapter: DatabaseAdapter<unknown>): SqlAdapter {
  if (!("driver" in adapter)) {
    throw new Error("Migration suite currently requires a SqlAdapter-compatible adapter");
  }
  return adapter as SqlAdapter;
}

export async function query(
  driver: SqlDriverAdapter,
  sql: string,
  parameters: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const result = await driver.executeQuery({ sql, parameters });
  return result.rows;
}

export function normalizeType(type: string): ObservedColumn["logicalType"] {
  const normalized = type.toLowerCase();
  if (normalized.includes("bool") || normalized === "tinyint") {
    return "boolean";
  }
  if (normalized.includes("bigint") || normalized.includes("bigserial")) {
    return "bigint";
  }
  if (normalized.includes("int") || normalized.includes("serial")) {
    return "integer";
  }
  if (normalized.includes("timestamp") || normalized.includes("datetime")) {
    return "timestamp";
  }
  if (normalized.includes("json")) {
    return "json";
  }
  if (normalized.includes("text")) {
    return "text";
  }
  if (normalized.includes("char") || normalized.includes("varchar")) {
    return "string";
  }
  return undefined;
}

export function normalizeDefault(value: unknown): ObservedColumn["defaultKind"] {
  if (value === null || value === undefined) {
    return "none";
  }
  const text = String(value).toLowerCase();
  if (text.includes("__fragno_global__")) {
    return "global-shard";
  }
  if (/\b0\b/.test(text)) {
    return "zero";
  }
  if (text.includes("current_timestamp") || text.includes("now()")) {
    return "now";
  }
  return "database-specific";
}

export function quoteBare(identifier: string, quote: '"' | "`"): string {
  return `${quote}${identifier.replaceAll(quote, quote + quote)}${quote}`;
}
