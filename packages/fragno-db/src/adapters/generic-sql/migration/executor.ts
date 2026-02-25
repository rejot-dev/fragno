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

const isDeallocatePrepare = (statement: CompiledQuery) =>
  /^\s*deallocate\s+prepare\s+[a-z_][a-z0-9_]*\s*;?\s*$/i.test(statement.sql.trim());

async function cleanupPendingPreparedStatements(
  executor: Pick<SqlDriverAdapter, "executeQuery">,
  statements: CompiledQuery[],
): Promise<void> {
  for (const statement of statements) {
    if (!isDeallocatePrepare(statement)) {
      continue;
    }
    try {
      await executor.executeQuery(statement);
    } catch {
      // Preserve the original migration error; this is best-effort session cleanup.
    }
  }
}

export async function executeMigration(
  driver: SqlDriverAdapter,
  migration: CompiledMigration,
): Promise<void> {
  if (migration.statements.length === 0) {
    return;
  }

  const isForeignKeysOff = (statement: CompiledQuery) => {
    const sql = statement.sql.trim();
    return (
      /^\s*pragma\s+foreign_keys\s*=\s*off\s*;?\s*$/i.test(sql) ||
      /^\s*set\s+foreign_key_checks\s*=\s*0\s*;?\s*$/i.test(sql)
    );
  };
  const isForeignKeysOn = (statement: CompiledQuery) => {
    const sql = statement.sql.trim();
    return (
      /^\s*pragma\s+foreign_keys\s*=\s*on\s*;?\s*$/i.test(sql) ||
      /^\s*set\s+foreign_key_checks\s*=\s*1\s*;?\s*$/i.test(sql)
    );
  };

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
        for (let index = 0; index < transactionalStatements.length; index += 1) {
          const statement = transactionalStatements[index]!;
          try {
            await tx.executeQuery(statement);
          } catch (error) {
            await cleanupPendingPreparedStatements(tx, transactionalStatements.slice(index + 1));
            throw error;
          }
        }
      });
    }
  } finally {
    for (const statement of postStatements) {
      await driver.executeQuery(statement);
    }
  }
}
