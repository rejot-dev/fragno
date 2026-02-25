import type {
  SystemMigration,
  SystemMigrationContext,
} from "../../../../migration-engine/system-migrations";
import { GLOBAL_SHARD_SENTINEL } from "../../../../sharding";

const SHARD_COLUMN_NAME = "_shard";
const SHARD_COLUMN_TYPE = "varchar(128)";

const escapeMySqlIdentifier = (value: string): string => value.replace(/`/g, "``");
const escapeMySqlString = (value: string): string => value.replace(/'/g, "''");

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

    const escapedTable = escapeMySqlIdentifier(tableName);
    const escapedColumn = escapeMySqlIdentifier(columnName);
    const escapedIndex = escapeMySqlIdentifier(indexName);
    const qualifiedTable = schemaName
      ? `\`${escapeMySqlIdentifier(schemaName)}\`.\`${escapedTable}\``
      : `\`${escapedTable}\``;

    statements.push(
      `alter table ${qualifiedTable} add column \`${escapedColumn}\` ${SHARD_COLUMN_TYPE} default '${escapeMySqlString(
        GLOBAL_SHARD_SENTINEL,
      )}'`,
      `create index \`${escapedIndex}\` on ${qualifiedTable} (\`${escapedColumn}\`)`,
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

    const escapedTable = escapeMySqlIdentifier(tableName);
    const escapedColumn = escapeMySqlIdentifier(columnName);
    const qualifiedTable = schemaName
      ? `\`${escapeMySqlIdentifier(schemaName)}\`.\`${escapedTable}\``
      : `\`${escapedTable}\``;

    statements.push(
      `update ${qualifiedTable} set \`${escapedColumn}\` = '${escapeMySqlString(
        GLOBAL_SHARD_SENTINEL,
      )}' where \`${escapedColumn}\` is null`,
      `alter table ${qualifiedTable} modify column \`${escapedColumn}\` ${SHARD_COLUMN_TYPE} not null default '${escapeMySqlString(
        GLOBAL_SHARD_SENTINEL,
      )}'`,
    );
  }

  return statements;
};

const buildShardMigration = (context: SystemMigrationContext): string[] => [
  ...buildShardBackfillStatements(context),
  ...buildShardNotNullStatements(context),
];

export const mysqlSystemMigrations: SystemMigration[] = [buildShardMigration];
