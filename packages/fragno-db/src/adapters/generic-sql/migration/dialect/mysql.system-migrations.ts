import type {
  SystemMigration,
  SystemMigrationContext,
} from "../../../../migration-engine/system-migrations";

const SHARD_COLUMN_NAME = "_shard";

const escapeMySqlIdentifier = (value: string): string => value.replace(/`/g, "``");
const escapeMySqlString = (value: string): string => value.replace(/'/g, "''");

const buildShardBackfillStatements = (context: SystemMigrationContext): string[] => {
  const { schema, resolver } = context;
  const schemaName = resolver?.getSchemaName();
  const schemaFilter = schemaName ? `'${escapeMySqlString(schemaName)}'` : "database()";
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

    const escapedTable = escapeMySqlIdentifier(tableName);
    const escapedColumn = escapeMySqlIdentifier(columnName);
    const escapedIndex = escapeMySqlIdentifier(indexName);
    const qualifiedTable = schemaName
      ? `\`${escapeMySqlIdentifier(schemaName)}\`.\`${escapedTable}\``
      : `\`${escapedTable}\``;

    const tableLiteral = escapeMySqlString(tableName);
    const columnLiteral = escapeMySqlString(columnName);
    const indexLiteral = escapeMySqlString(indexName);

    const alterSql = `alter table ${qualifiedTable} add column \`${escapedColumn}\` text`;
    const createIndexSql = `create index \`${escapedIndex}\` on ${qualifiedTable} (\`${escapedColumn}\`)`;
    const columnExistsSql =
      "select count(*) from information_schema.columns " +
      `where table_schema = ${schemaFilter} ` +
      `and table_name = '${tableLiteral}' ` +
      `and column_name = '${columnLiteral}'`;
    const indexExistsSql =
      "select count(*) from information_schema.statistics " +
      `where table_schema = ${schemaFilter} ` +
      `and table_name = '${tableLiteral}' ` +
      `and index_name = '${indexLiteral}'`;

    statements.push(
      `set @fragno_shard_column_exists = (${columnExistsSql})`,
      `set @fragno_shard_column_sql = if(@fragno_shard_column_exists = 0, '${escapeMySqlString(
        alterSql,
      )}', 'select 1')`,
      "prepare fragno_shard_stmt from @fragno_shard_column_sql",
      "execute fragno_shard_stmt",
      "deallocate prepare fragno_shard_stmt",
      `set @fragno_shard_index_exists = (${indexExistsSql})`,
      `set @fragno_shard_index_sql = if(@fragno_shard_index_exists = 0, '${escapeMySqlString(
        createIndexSql,
      )}', 'select 1')`,
      "prepare fragno_shard_stmt from @fragno_shard_index_sql",
      "execute fragno_shard_stmt",
      "deallocate prepare fragno_shard_stmt",
    );
  }

  return statements;
};

export const mysqlSystemMigrations: SystemMigration[] = [buildShardBackfillStatements];
