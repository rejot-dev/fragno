import type {
  SystemMigration,
  SystemMigrationContext,
} from "../../../../migration-engine/system-migrations";
import { GLOBAL_SHARD_SENTINEL } from "../../../../sharding";

const SHARD_COLUMN_NAME = "_shard";
const SHARD_COLUMN_TYPE = "varchar(128)";

const quotePostgresIdentifier = (value: string): string => `"${value.replace(/"/g, '""')}"`;
const escapePostgresString = (value: string): string => value.replace(/'/g, "''");

const quoteQualifiedTable = (schemaName: string | null | undefined, tableName: string): string =>
  schemaName
    ? `${quotePostgresIdentifier(schemaName)}.${quotePostgresIdentifier(tableName)}`
    : quotePostgresIdentifier(tableName);

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
    const quotedColumn = quotePostgresIdentifier(columnName);
    const quotedIndex = quotePostgresIdentifier(indexName);
    const shardValue = escapePostgresString(GLOBAL_SHARD_SENTINEL);

    statements.push(
      `alter table ${qualifiedTable} add column if not exists ${quotedColumn} ${SHARD_COLUMN_TYPE} default '${shardValue}'`,
      `create index if not exists ${quotedIndex} on ${qualifiedTable} (${quotedColumn})`,
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
    const qualifiedTable = quoteQualifiedTable(schemaName, tableName);
    const quotedColumn = quotePostgresIdentifier(columnName);
    const shardValue = escapePostgresString(GLOBAL_SHARD_SENTINEL);

    statements.push(
      `update ${qualifiedTable} set ${quotedColumn} = '${shardValue}' where ${quotedColumn} is null`,
      `alter table ${qualifiedTable} alter column ${quotedColumn} set default '${shardValue}'`,
      `alter table ${qualifiedTable} alter column ${quotedColumn} set not null`,
    );
  }

  return statements;
};

const buildShardMigration = (context: SystemMigrationContext): string[] => [
  ...buildShardBackfillStatements(context),
  ...buildShardNotNullStatements(context),
];

export const postgresSystemMigrations: SystemMigration[] = [buildShardMigration];
