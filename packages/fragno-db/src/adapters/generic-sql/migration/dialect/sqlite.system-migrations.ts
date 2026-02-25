import type {
  SystemMigration,
  SystemMigrationContext,
} from "../../../../migration-engine/system-migrations";
import { GLOBAL_SHARD_SENTINEL } from "../../../../sharding";

const SHARD_COLUMN_NAME = "_shard";
const SHARD_COLUMN_TYPE = "varchar(128)";

const quoteSqliteIdentifier = (value: string): string => `"${value.replace(/"/g, '""')}"`;
const escapeSqliteString = (value: string): string => value.replace(/'/g, "''");

const quoteQualifiedTable = (schemaName: string | null | undefined, tableName: string): string =>
  schemaName
    ? `${quoteSqliteIdentifier(schemaName)}.${quoteSqliteIdentifier(tableName)}`
    : quoteSqliteIdentifier(tableName);

const quoteQualifiedIndex = (schemaName: string | null | undefined, indexName: string): string =>
  schemaName
    ? `${quoteSqliteIdentifier(schemaName)}.${quoteSqliteIdentifier(indexName)}`
    : quoteSqliteIdentifier(indexName);

const buildShardBackfillStatements = (context: SystemMigrationContext): string[] => {
  const { schema, resolver } = context;
  const tables = context.tables ?? schema.tables;
  const schemaName = resolver?.getSchemaName();
  const statements: string[] = [];

  for (const table of Object.values(tables)) {
    const tableName = resolver ? resolver.getTableName(table.name) : table.name;
    const columnName = resolver
      ? resolver.getColumnName(table.name, SHARD_COLUMN_NAME)
      : SHARD_COLUMN_NAME;
    const indexLogicalName = `idx_${table.name}_shard`;
    const indexName = resolver
      ? resolver.getIndexName(indexLogicalName, table.name)
      : indexLogicalName;
    const qualifiedTable = quoteQualifiedTable(schemaName, tableName);
    const qualifiedIndex = quoteQualifiedIndex(schemaName, indexName);
    const quotedColumn = quoteSqliteIdentifier(columnName);

    statements.push(
      `alter table ${qualifiedTable} add column ${quotedColumn} ${SHARD_COLUMN_TYPE}`,
      `create index if not exists ${qualifiedIndex} on ${qualifiedTable} (${quotedColumn})`,
    );
  }

  return statements;
};

const buildShardNotNullStatements = (context: SystemMigrationContext): string[] => {
  const { schema, resolver } = context;
  const tables = context.tables ?? schema.tables;
  const schemaName = resolver?.getSchemaName();
  const statements: string[] = [];

  for (const table of Object.values(tables)) {
    const tableName = resolver ? resolver.getTableName(table.name) : table.name;
    const columnName = resolver
      ? resolver.getColumnName(table.name, SHARD_COLUMN_NAME)
      : SHARD_COLUMN_NAME;
    const indexLogicalName = `idx_${table.name}_shard`;
    const indexName = resolver
      ? resolver.getIndexName(indexLogicalName, table.name)
      : indexLogicalName;
    const qualifiedTable = quoteQualifiedTable(schemaName, tableName);
    const qualifiedIndex = quoteQualifiedIndex(schemaName, indexName);
    const quotedColumn = quoteSqliteIdentifier(columnName);
    const legacyColumn = `${columnName}_legacy`;
    const quotedLegacyColumn = quoteSqliteIdentifier(legacyColumn);
    const shardValue = escapeSqliteString(GLOBAL_SHARD_SENTINEL);

    statements.push(
      `drop index if exists ${qualifiedIndex}`,
      `alter table ${qualifiedTable} rename column ${quotedColumn} to ${quotedLegacyColumn}`,
      `alter table ${qualifiedTable} add column ${quotedColumn} ${SHARD_COLUMN_TYPE} not null default '${shardValue}'`,
      `update ${qualifiedTable} set ${quotedColumn} = coalesce(${quotedLegacyColumn}, '${shardValue}')`,
      `alter table ${qualifiedTable} drop column ${quotedLegacyColumn}`,
      `create index if not exists ${qualifiedIndex} on ${qualifiedTable} (${quotedColumn})`,
    );
  }

  return statements;
};

const buildShardMigration = (context: SystemMigrationContext): string[] => [
  ...buildShardBackfillStatements(context),
  ...buildShardNotNullStatements(context),
];

export const sqliteSystemMigrations: SystemMigration[] = [buildShardMigration];
