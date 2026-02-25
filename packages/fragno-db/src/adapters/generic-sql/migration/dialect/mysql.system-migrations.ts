import type {
  SystemMigration,
  SystemMigrationContext,
} from "../../../../migration-engine/system-migrations";
import { GLOBAL_SHARD_SENTINEL } from "../../../../sharding";

const SHARD_COLUMN_NAME = "_shard";
const SHARD_COLUMN_TYPE = "varchar(128)";

const escapeMySqlIdentifier = (value: string): string => value.replace(/`/g, "``");
const escapeMySqlString = (value: string): string => value.replace(/'/g, "''");

const quoteMySqlIdentifier = (value: string): string => `\`${escapeMySqlIdentifier(value)}\``;

const quoteMySqlQualifiedTable = (schemaName: string | null | undefined, tableName: string) =>
  schemaName
    ? `${quoteMySqlIdentifier(schemaName)}.${quoteMySqlIdentifier(tableName)}`
    : quoteMySqlIdentifier(tableName);

const buildInformationSchemaPredicate = (
  schemaName: string | null | undefined,
  tableName: string,
): string => {
  const tableSchema = schemaName
    ? `table_schema = '${escapeMySqlString(schemaName)}'`
    : "table_schema = database()";
  return `${tableSchema} and table_name = '${escapeMySqlString(tableName)}'`;
};

const buildPreparedStatement = (sqlText: string): string[] => [
  `set @fragno_db_system_migration_stmt = '${escapeMySqlString(sqlText)}'`,
  "prepare fragno_db_system_migration_stmt from @fragno_db_system_migration_stmt",
  "execute fragno_db_system_migration_stmt",
  "deallocate prepare fragno_db_system_migration_stmt",
];

const buildConditionalPreparedStatement = (existsQuery: string, sqlText: string): string[] => [
  `set @fragno_db_system_migration_stmt = if(exists(${existsQuery}), 'select 1', '${escapeMySqlString(
    sqlText,
  )}')`,
  "prepare fragno_db_system_migration_stmt from @fragno_db_system_migration_stmt",
  "execute fragno_db_system_migration_stmt",
  "deallocate prepare fragno_db_system_migration_stmt",
];

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

    const qualifiedTable = quoteMySqlQualifiedTable(schemaName, tableName);
    const quotedColumn = quoteMySqlIdentifier(columnName);
    const quotedIndex = quoteMySqlIdentifier(indexName);
    const tablePredicate = buildInformationSchemaPredicate(schemaName, tableName);
    const addColumnSql = `alter table ${qualifiedTable} add column ${quotedColumn} ${SHARD_COLUMN_TYPE} default '${escapeMySqlString(
      GLOBAL_SHARD_SENTINEL,
    )}'`;
    const createIndexSql = `create index ${quotedIndex} on ${qualifiedTable} (${quotedColumn})`;

    statements.push(
      ...buildConditionalPreparedStatement(
        `select 1 from information_schema.columns where ${tablePredicate} and column_name = '${escapeMySqlString(
          columnName,
        )}'`,
        addColumnSql,
      ),
      ...buildConditionalPreparedStatement(
        `select 1 from information_schema.statistics where ${tablePredicate} and index_name = '${escapeMySqlString(
          indexName,
        )}'`,
        createIndexSql,
      ),
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

    const qualifiedTable = quoteMySqlQualifiedTable(schemaName, tableName);
    const quotedColumn = quoteMySqlIdentifier(columnName);

    statements.push(
      ...buildPreparedStatement(
        `update ${qualifiedTable} set ${quotedColumn} = '${escapeMySqlString(
          GLOBAL_SHARD_SENTINEL,
        )}' where ${quotedColumn} is null`,
      ),
      ...buildPreparedStatement(
        `alter table ${qualifiedTable} modify column ${quotedColumn} ${SHARD_COLUMN_TYPE} not null default '${escapeMySqlString(
          GLOBAL_SHARD_SENTINEL,
        )}'`,
      ),
    );
  }

  return statements;
};

const buildShardMigration = (context: SystemMigrationContext): string[] => [
  ...buildShardBackfillStatements(context),
  ...buildShardNotNullStatements(context),
];

export const mysqlSystemMigrations: SystemMigration[] = [buildShardMigration];
