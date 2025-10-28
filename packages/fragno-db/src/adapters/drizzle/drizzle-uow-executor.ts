import { SQL, StringChunk, sql, type SQLChunk } from "drizzle-orm";
import type { CompiledMutation, MutationResult } from "../../query/unit-of-work";
import type { DBType } from "./shared";
import type { DrizzleCompiledQuery } from "./drizzle-uow-compiler";
import type { DrizzleResult } from "./shared";
import { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";

type SyncSQLiteDB = BaseSQLiteDatabase<
  "sync",
  unknown,
  Record<string, never>,
  Record<string, never>
>;

function isSyncSQLite(db: unknown): boolean {
  return (
    db instanceof BaseSQLiteDatabase &&
    "dialect" in db &&
    (db as { dialect?: unknown }).dialect instanceof SQLiteSyncDialect
  );
}

function assertSyncSQLite(db: unknown): asserts db is SyncSQLiteDB {
  if (!isSyncSQLite(db)) {
    throw new Error("Expected synchronous SQLite database (better-sqlite3)");
  }
}

function postgresToSQL(sqlString: string, params: unknown[]): SQLChunk[] {
  const placeholderRegex = /\$(\d+)/g;
  const queryChunks: SQLChunk[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = placeholderRegex.exec(sqlString)) !== null) {
    const textBefore = sqlString.substring(lastIndex, match.index);
    if (textBefore) {
      queryChunks.push(new StringChunk(textBefore));
    }

    const paramIndex = parseInt(match[1]!, 10) - 1;
    queryChunks.push(sql.param(params[paramIndex]));

    lastIndex = match.index + match[0].length;
  }

  const textAfter = sqlString.substring(lastIndex);
  if (textAfter) {
    queryChunks.push(new StringChunk(textAfter));
  }

  return queryChunks;
}

function sqliteToSQL(sqlString: string, params: unknown[]): SQLChunk[] {
  const chunks: SQLChunk[] = [];
  let currentIndex = 0;

  const parts = sqlString.split("?");
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]) {
      chunks.push(new StringChunk(parts[i]));
    }
    if (i < parts.length - 1 && currentIndex < params.length) {
      chunks.push(sql.param(params[currentIndex++]));
    }
  }

  return chunks;
}

function toSQL(query: DrizzleCompiledQuery, provider: "sqlite" | "mysql" | "postgresql"): SQL {
  const { sql: sqlString, params } = query;

  const queryChunks =
    provider === "sqlite" ? sqliteToSQL(sqlString, params) : postgresToSQL(sqlString, params);

  return new SQL(queryChunks);
}

function getAffectedRows(result: unknown): number {
  if (Array.isArray(result)) {
    return result.length;
  }

  if (result && typeof result === "object") {
    // libsql uses rowsAffected
    if ("rowsAffected" in result && typeof result["rowsAffected"] === "number") {
      return result["rowsAffected"];
    }

    if ("affectedRows" in result && typeof result["affectedRows"] === "number") {
      return result["affectedRows"];
    }

    if (
      "rowCount" in result &&
      (typeof result["rowCount"] === "number" || typeof result["rowCount"] === "bigint")
    ) {
      const rowCount = result["rowCount"];
      if (rowCount > Number.MAX_SAFE_INTEGER) {
        throw new Error(
          `rowCount BigInt value ${rowCount.toString()} exceeds JS safe integer range`,
        );
      }
      return Number(rowCount);
    }

    if ("changes" in result && typeof result["changes"] === "number") {
      return result["changes"];
    }
  }

  throw new Error(`Unable to determine affected rows from result: ${JSON.stringify(result)}`);
}

async function executeInTransaction(
  db: DBType,
  provider: "sqlite" | "mysql" | "postgresql",
  syncExecutor: (db: SyncSQLiteDB) => void,
  asyncExecutor: (tx: {
    execute?: (sql: SQL) => Promise<unknown>;
    run?: (sql: SQL) => Promise<unknown>;
  }) => Promise<void>,
): Promise<void> {
  if (provider === "sqlite" && isSyncSQLite(db)) {
    assertSyncSQLite(db);
    db.transaction(() => syncExecutor(db));
  } else {
    await db.transaction(
      async (tx) =>
        await asyncExecutor(
          tx as { execute?: (sql: SQL) => Promise<unknown>; run?: (sql: SQL) => Promise<unknown> },
        ),
    );
  }
}

function extractCreatedInternalId(result: unknown): bigint | null {
  if (result && typeof result === "object" && "lastInsertRowid" in result) {
    if (typeof result.lastInsertRowid === "bigint") {
      return result.lastInsertRowid;
    }

    if (typeof result.lastInsertRowid === "number") {
      return BigInt(result.lastInsertRowid);
    }

    throw new Error(`Unexpected lastInsertRowid type: ${typeof result.lastInsertRowid}`);
  }

  if (Array.isArray(result) && result.length > 0) {
    const row = result[0] as Record<string, unknown>;
    if ("_internalId" in row || "_internal_id" in row) {
      return (row["_internalId"] ?? row["_internal_id"]) as bigint;
    }
  }

  return null;
}

function validateAffectedRows(result: unknown, expected: number): void {
  const actual = getAffectedRows(result);
  if (actual !== expected) {
    throw new Error(`Version conflict: expected ${expected} rows affected, but got ${actual}`);
  }
}

/**
 * Execute the retrieval phase of a Unit of Work using Drizzle
 *
 * All retrieval queries are executed inside a single transaction to ensure
 * snapshot isolation - all reads see a consistent view of the database.
 */
export async function executeDrizzleRetrievalPhase(
  db: DBType,
  retrievalBatch: DrizzleCompiledQuery[],
  provider: "sqlite" | "mysql" | "postgresql",
): Promise<DrizzleResult[]> {
  if (retrievalBatch.length === 0) {
    return [];
  }

  const retrievalResults: DrizzleResult[] = [];

  await executeInTransaction(
    db,
    provider,
    (syncDb) => {
      for (const query of retrievalBatch) {
        const sqlObj = toSQL(query, provider);
        const rows = syncDb.all(sqlObj as never) as Record<string, unknown>[];
        const result: DrizzleResult = { rows, affectedRows: 0 };
        retrievalResults.push(result);
      }
    },
    async (tx) => {
      for (const query of retrievalBatch) {
        const sqlObj = toSQL(query, provider);
        // Fallback to run when execute is not available (e.g., libsql)
        const executeMethod = tx.execute ?? tx.run;
        if (!executeMethod) {
          throw new Error("Transaction object has neither execute nor run method");
        }
        const result = (await executeMethod.call(tx, sqlObj)) as DrizzleResult;
        retrievalResults.push(result);
      }
    },
  );

  return retrievalResults;
}

/**
 * Execute the mutation phase of a Unit of Work using Drizzle
 *
 * All mutation queries are executed in a transaction with optimistic locking.
 * If any version check fails, the entire transaction is rolled back and
 * success=false is returned.
 */
export async function executeDrizzleMutationPhase(
  db: DBType,
  mutationBatch: CompiledMutation<DrizzleCompiledQuery>[],
  provider: "sqlite" | "mysql" | "postgresql",
): Promise<MutationResult> {
  if (mutationBatch.length === 0) {
    return { success: true, createdInternalIds: [] };
  }

  const createdInternalIds: (bigint | null)[] = [];

  try {
    await executeInTransaction(
      db,
      provider,
      (syncDb) => {
        for (const { query, expectedAffectedRows } of mutationBatch) {
          const sqlObj = toSQL(query, provider);
          // Type assertion needed due to drizzle-orm version mismatch in dependencies
          const result = syncDb.run(sqlObj as never);

          if (expectedAffectedRows === null) {
            createdInternalIds.push(extractCreatedInternalId(result));
          } else {
            validateAffectedRows(result, expectedAffectedRows);
          }
        }
      },
      async (tx) => {
        for (const { query, expectedAffectedRows } of mutationBatch) {
          const sqlObj = toSQL(query, provider);
          // Fallback to run when execute is not available (e.g., libsql)
          const executeMethod = tx.execute ?? tx.run;
          if (!executeMethod) {
            throw new Error("Transaction object has neither execute nor run method");
          }
          const result = await executeMethod.call(tx, sqlObj);

          if (expectedAffectedRows === null) {
            createdInternalIds.push(extractCreatedInternalId(result));
          } else {
            validateAffectedRows(result, expectedAffectedRows);
          }
        }
      },
    );

    return { success: true, createdInternalIds };
  } catch (error) {
    if (error instanceof Error && error.message.includes("Version conflict")) {
      return { success: false };
    }
    throw error;
  }
}
