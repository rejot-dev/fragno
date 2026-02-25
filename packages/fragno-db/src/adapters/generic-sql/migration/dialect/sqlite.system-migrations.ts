import type {
  SystemMigration,
  SystemMigrationContext,
} from "../../../../migration-engine/system-migrations";
import { GLOBAL_SHARD_SENTINEL } from "../../../../sharding";

const SHARD_COLUMN_NAME = "_shard";
const SHARD_COLUMN_TYPE = "varchar(128)";

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
    const qualifiedTable = schemaName ? `"${schemaName}"."${tableName}"` : `"${tableName}"`;

    statements.push(
      `alter table ${qualifiedTable} add column "${columnName}" ${SHARD_COLUMN_TYPE}`,
      `create index if not exists "${indexName}" on ${qualifiedTable} ("${columnName}")`,
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
    const qualifiedTable = schemaName ? `"${schemaName}"."${tableName}"` : `"${tableName}"`;
    const legacyColumn = `${columnName}_legacy`;

    statements.push(
      `drop index if exists "${indexName}"`,
      `alter table ${qualifiedTable} rename column "${columnName}" to "${legacyColumn}"`,
      `alter table ${qualifiedTable} add column "${columnName}" ${SHARD_COLUMN_TYPE} not null default '${GLOBAL_SHARD_SENTINEL}'`,
      `update ${qualifiedTable} set "${columnName}" = coalesce("${legacyColumn}", '${GLOBAL_SHARD_SENTINEL}')`,
      `alter table ${qualifiedTable} drop column "${legacyColumn}"`,
      `create index if not exists "${indexName}" on ${qualifiedTable} ("${columnName}")`,
    );
  }

  return statements;
};

const buildShardMigration = (context: SystemMigrationContext): string[] => [
  ...buildShardBackfillStatements(context),
  ...buildShardNotNullStatements(context),
];

export const sqliteSystemMigrations: SystemMigration[] = [buildShardMigration];
