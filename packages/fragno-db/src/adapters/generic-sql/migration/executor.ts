import type { CompiledQuery } from "kysely";
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

export async function executeMigration(
  driver: SqlDriverAdapter,
  migration: CompiledMigration,
): Promise<void> {
  if (migration.statements.length === 0) {
    return;
  }

  await driver.transaction(async (tx) => {
    for (const statement of migration.statements) {
      await tx.executeQuery(statement);
    }
  });
}
