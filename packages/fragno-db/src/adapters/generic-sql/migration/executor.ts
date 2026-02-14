import type { CompiledQuery } from "kysely";
import type { SupportedDatabase } from "../driver-config";
import type { SqlDriverAdapter } from "../../../sql-driver/sql-driver-adapter";

/**
 * Compiled migration containing all SQL statements to execute.
 */
export interface CompiledMigration {
  statements: CompiledQuery[];
  fromVersion: number;
  toVersion: number;
}

/**
 * Execute a compiled migration using the provided driver adapter.
 * All statements are executed within a single transaction.
 *
 * @param driver - The SQL driver adapter to execute queries
 * @param migration - The compiled migration containing SQL statements
 */
type ExecuteMigrationOptions = {
  databaseType?: SupportedDatabase;
};

const sqliteShardColumn = "_shard";
const sqliteAlterColumnRegex = /^alter table\s+(.+?)\s+add column\s+"([^"]+)"\s+text$/i;

const parseSqliteAlterTable = (
  statement: CompiledQuery,
): { schema: string | null; table: string; column: string } | null => {
  const match = statement.sql.match(sqliteAlterColumnRegex);
  if (!match) {
    return null;
  }

  const tableRef = match[1]?.trim();
  const column = match[2]?.trim();
  if (!tableRef || !column) {
    return null;
  }

  const qualifiedMatch = tableRef.match(/^"([^"]+)"\."([^"]+)"$/);
  if (qualifiedMatch) {
    return { schema: qualifiedMatch[1], table: qualifiedMatch[2], column };
  }

  const unqualifiedMatch = tableRef.match(/^"([^"]+)"$/);
  if (unqualifiedMatch) {
    return { schema: null, table: unqualifiedMatch[1], column };
  }

  return null;
};

const sqliteColumnExists = async (
  driver: SqlDriverAdapter,
  schema: string | null,
  table: string,
  column: string,
): Promise<boolean> => {
  const pragmaSql = schema
    ? `pragma "${schema}".table_info("${table}")`
    : `pragma table_info("${table}")`;
  const result = await driver.executeQuery({ sql: pragmaSql, parameters: [] });
  return result.rows.some(
    (row) => typeof row === "object" && row !== null && row["name"] === column,
  );
};

export async function executeMigration(
  driver: SqlDriverAdapter,
  migration: CompiledMigration,
  options?: ExecuteMigrationOptions,
): Promise<void> {
  if (migration.statements.length === 0) {
    return;
  }

  await driver.transaction(async (tx) => {
    for (const statement of migration.statements) {
      if (options?.databaseType === "sqlite") {
        const parsed = parseSqliteAlterTable(statement);
        if (parsed && parsed.column === sqliteShardColumn) {
          const exists = await sqliteColumnExists(tx, parsed.schema, parsed.table, parsed.column);
          if (exists) {
            continue;
          }
        }
      }
      await tx.executeQuery(statement);
    }
  });
}
