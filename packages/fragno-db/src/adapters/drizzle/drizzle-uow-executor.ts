import { SQL, StringChunk, sql, type SQLChunk } from "drizzle-orm";
import type { CompiledMutation, MutationResult } from "../../query/unit-of-work";
import type { DBType } from "./shared";
import type { DrizzleCompiledQuery } from "./drizzle-uow-compiler";
import type { DrizzleResult } from "./drizzle-query";

/**
 * Convert a DrizzleCompiledQuery (SQL string + params) to a Drizzle SQL object
 *
 * This reconstructs the SQL object with proper parameter chunks by parsing
 * the SQL string and replacing placeholders ($1, $2, etc.) with Param objects.
 * Uses Drizzle's exported classes (StringChunk, Param, SQL) to build the queryChunks.
 */
function toSQL(query: DrizzleCompiledQuery): SQL {
  const { sql: sqlString, params } = query;

  // Match parameter placeholders like $1, $2, etc.
  const placeholderRegex = /\$(\d+)/g;
  const queryChunks: SQLChunk[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = placeholderRegex.exec(sqlString)) !== null) {
    // Add the string chunk before the placeholder
    const textBefore = sqlString.substring(lastIndex, match.index);
    if (textBefore) {
      queryChunks.push(new StringChunk(textBefore));
    }

    // Add the parameter value as a Param
    const paramIndex = parseInt(match[1]!, 10) - 1; // $1 is index 0
    queryChunks.push(sql.param(params[paramIndex]));

    lastIndex = match.index + match[0].length;
  }

  // Add any remaining string after the last placeholder
  const textAfter = sqlString.substring(lastIndex);
  if (textAfter) {
    queryChunks.push(new StringChunk(textAfter));
  }

  // Construct SQL object directly with queryChunks (same pattern as sql`` tagged template)
  // Safe: We're reusing Drizzle's SQL constructor the same way the sql`` function does
  return new SQL(queryChunks);
}

/**
 * Get the number of affected rows from a Drizzle query result
 */
function getAffectedRows(result: unknown): number {
  // Drizzle returns different formats depending on the database
  // For MySQL: array with affectedRows property
  // For PostgreSQL/SQLite: array with rowCount or similar
  if (Array.isArray(result)) {
    // This is likely a select/returning result
    return result.length;
  }

  // Check for MySQL-style result
  if (
    result &&
    typeof result === "object" &&
    "affectedRows" in result &&
    typeof result["affectedRows"] === "number"
  ) {
    return result["affectedRows"];
  }

  // Check for PostgreSQL-style result with rowCount
  if (
    result &&
    typeof result === "object" &&
    "rowCount" in result &&
    (typeof result["rowCount"] === "number" || typeof result["rowCount"] === "bigint")
  ) {
    const rowCount = result["rowCount"];
    if (rowCount > Number.MAX_SAFE_INTEGER) {
      throw new Error(`rowCount BigInt value ${rowCount.toString()} exceeds JS safe integer range`);
    }
    return Number(rowCount);
  }

  // For update/delete operations, Drizzle might return an object with affected rows info
  // Try to extract it from common patterns
  if (result && typeof result === "object") {
    // Check for changes/changes count
    if ("changes" in result && typeof result["changes"] === "number") {
      return result["changes"];
    }
  }

  throw new Error(`Unable to determine affected rows from result: ${JSON.stringify(result)}`);
}

/**
 * Execute the retrieval phase of a Unit of Work using Drizzle
 *
 * All retrieval queries are executed inside a single transaction to ensure
 * snapshot isolation - all reads see a consistent view of the database.
 *
 * @param db - The Drizzle database instance
 * @param retrievalBatch - Array of Drizzle SQL queries
 * @returns Array of query results matching the retrieval operations order
 *
 * @example
 * ```ts
 * const retrievalResults = await executeDrizzleRetrievalPhase(db, compiled.retrievalBatch);
 * const [users, posts] = retrievalResults;
 * ```
 */
export async function executeDrizzleRetrievalPhase(
  db: DBType,
  retrievalBatch: DrizzleCompiledQuery[],
): Promise<DrizzleResult[]> {
  // If no retrieval operations, return empty array immediately
  if (retrievalBatch.length === 0) {
    return [];
  }

  const retrievalResults: DrizzleResult[] = [];

  // Execute all retrieval queries inside a transaction for snapshot isolation
  await db.transaction(async (tx) => {
    for (const query of retrievalBatch) {
      const result = (await tx.execute(toSQL(query))) as DrizzleResult;
      retrievalResults.push(result);
    }
  });

  return retrievalResults;
}

/**
 * Execute the mutation phase of a Unit of Work using Drizzle
 *
 * All mutation queries are executed in a transaction with optimistic locking.
 * If any version check fails, the entire transaction is rolled back and
 * success=false is returned.
 *
 * @param db - The Drizzle database instance
 * @param mutationBatch - Array of compiled mutation SQL queries with expected affected rows
 * @returns Object with success flag and internal IDs from create operations
 *
 * @example
 * ```ts
 * const { success } = await executeDrizzleMutationPhase(db, compiled.mutationBatch);
 * if (!success) {
 *   console.log("Version conflict detected, retrying...");
 * }
 * ```
 */
export async function executeDrizzleMutationPhase(
  db: DBType,
  mutationBatch: CompiledMutation<DrizzleCompiledQuery>[],
): Promise<MutationResult> {
  // If there are no mutations, return success immediately
  if (mutationBatch.length === 0) {
    return { success: true, createdInternalIds: [] };
  }

  const createdInternalIds: (bigint | null)[] = [];

  // Execute mutation batch in a transaction
  try {
    await db.transaction(async (tx) => {
      for (const compiledMutation of mutationBatch) {
        const result = await tx.execute(toSQL(compiledMutation.query));

        // For creates (expectedAffectedRows === null), try to extract internal ID
        if (compiledMutation.expectedAffectedRows === null) {
          // Check if result is an array with rows (RETURNING clause supported)
          if (Array.isArray(result) && result.length > 0) {
            const row = result[0] as Record<string, unknown>;
            // Look for _internalId column in the returned row
            if ("_internalId" in row || "_internal_id" in row) {
              const internalId = (row["_internalId"] ?? row["_internal_id"]) as bigint;
              createdInternalIds.push(internalId);
            } else {
              // RETURNING supported but _internalId not found
              createdInternalIds.push(null);
            }
          } else {
            // No RETURNING support (e.g., MySQL)
            createdInternalIds.push(null);
          }
        } else {
          // Check affected rows for updates/deletes
          const affectedRows = getAffectedRows(result);

          if (affectedRows !== compiledMutation.expectedAffectedRows) {
            // Version conflict detected - the UPDATE/DELETE didn't affect the expected number of rows
            // This means either the row doesn't exist or the version has changed
            throw new Error(
              `Version conflict: expected ${compiledMutation.expectedAffectedRows} rows affected, but got ${affectedRows}`,
            );
          }
        }
      }
    });

    return { success: true, createdInternalIds };
  } catch (error) {
    // Transaction failed - could be version conflict or other constraint violation
    // Return success=false to indicate the UOW should be retried
    if (error instanceof Error && error.message.includes("Version conflict")) {
      return { success: false };
    }

    // Other database errors should be thrown
    throw error;
  }
}
