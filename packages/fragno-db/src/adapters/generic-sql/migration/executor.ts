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

  const isForeignKeysOff = (statement: CompiledQuery) =>
    /^\s*pragma\s+foreign_keys\s*=\s*off\s*;?\s*$/i.test(statement.sql.trim());
  const isForeignKeysOn = (statement: CompiledQuery) =>
    /^\s*pragma\s+foreign_keys\s*=\s*on\s*;?\s*$/i.test(statement.sql.trim());

  const preStatements: CompiledQuery[] = [];
  const postStatements: CompiledQuery[] = [];
  const transactionalStatements: CompiledQuery[] = [];

  for (const statement of migration.statements) {
    if (isForeignKeysOff(statement)) {
      preStatements.push(statement);
      continue;
    }
    if (isForeignKeysOn(statement)) {
      postStatements.push(statement);
      continue;
    }
    transactionalStatements.push(statement);
  }

  if (preStatements.length === 0 && postStatements.length === 0) {
    await driver.transaction(async (tx) => {
      for (const statement of migration.statements) {
        await tx.executeQuery(statement);
      }
    });
    return;
  }

  for (const statement of preStatements) {
    await driver.executeQuery(statement);
  }

  try {
    if (transactionalStatements.length > 0) {
      await driver.transaction(async (tx) => {
        for (const statement of transactionalStatements) {
          await tx.executeQuery(statement);
        }
      });
    }
  } finally {
    for (const statement of postStatements) {
      await driver.executeQuery(statement);
    }
  }
}
