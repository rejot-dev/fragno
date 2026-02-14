import type {
  SystemMigration,
  SystemMigrationContext,
} from "../../../../migration-engine/system-migrations";

const SHARD_COLUMN_NAME = "_shard";

const buildShardBackfillStatements = (context: SystemMigrationContext): string[] => {
  const { schema, resolver } = context;
  const schemaName = resolver?.getSchemaName();
  const statements: string[] = [];

  for (const table of Object.values(schema.tables)) {
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
      `alter table ${qualifiedTable} add column if not exists "${columnName}" text`,
      `create index if not exists "${indexName}" on ${qualifiedTable} ("${columnName}")`,
    );
  }

  return statements;
};

export const postgresSystemMigrations: SystemMigration[] = [buildShardBackfillStatements];
