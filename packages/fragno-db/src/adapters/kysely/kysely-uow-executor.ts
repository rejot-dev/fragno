import type { CompiledQuery, Kysely, QueryResult } from "kysely";
import type { CompiledMutation, MutationResult } from "../../query/unit-of-work";

function getAffectedRows(result: QueryResult<unknown>): number {
  const affectedRows =
    result.numAffectedRows ??
    result.numChangedRows ??
    // PGLite returns `affectedRows` instead of `numAffectedRows` or `numChangedRows`
    ("affectedRows" in result &&
    (typeof result["affectedRows"] === "number" || typeof result["affectedRows"] === "bigint")
      ? result["affectedRows"]
      : undefined) ??
    // SQLite via SQLocal returns `numUpdatedRows` as BigInt
    ("numUpdatedRows" in result &&
    (typeof result["numUpdatedRows"] === "number" || typeof result["numUpdatedRows"] === "bigint")
      ? result["numUpdatedRows"]
      : undefined);

  if (affectedRows === undefined) {
    throw new Error(`No affected rows found: ${JSON.stringify(result)}`);
  }

  if (typeof affectedRows === "bigint" && affectedRows > Number.MAX_SAFE_INTEGER) {
    throw new Error(
      `affectedRows BigInt value ${affectedRows.toString()} exceeds JS safe integer range`,
    );
  }

  return Number(affectedRows);
}

/**
 * Execute the retrieval phase of a Unit of Work using Kysely
 *
 * All retrieval queries are executed inside a single transaction to ensure
 * snapshot isolation - all reads see a consistent view of the database.
 *
 * @param kysely - The Kysely database instance
 * @param retrievalBatch - Array of compiled retrieval queries
 * @returns Array of query results matching the retrieval operations order
 *
 * @example
 * ```ts
 * const retrievalResults = await executeKyselyRetrievalPhase(kysely, compiled.retrievalBatch);
 * const [users, posts] = retrievalResults;
 * ```
 */
export async function executeKyselyRetrievalPhase(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kysely: Kysely<any>,
  retrievalBatch: CompiledQuery[],
): Promise<unknown[]> {
  // If no retrieval operations, return empty array immediately
  if (retrievalBatch.length === 0) {
    return [];
  }

  const retrievalResults: unknown[] = [];

  // Execute all retrieval queries inside a transaction for snapshot isolation
  await kysely.transaction().execute(async (tx) => {
    for (const compiledQuery of retrievalBatch) {
      const result = await tx.executeQuery(compiledQuery);
      retrievalResults.push(result.rows);
    }
  });

  return retrievalResults;
}

/**
 * Execute the mutation phase of a Unit of Work using Kysely
 *
 * All mutation queries are executed in a transaction with optimistic locking.
 * If any version check fails, the entire transaction is rolled back and
 * success=false is returned.
 *
 * @param kysely - The Kysely database instance
 * @param mutationBatch - Array of compiled mutation queries with expected affected rows
 * @returns Object with success flag and internal IDs from create operations
 *
 * @example
 * ```ts
 * const { success, createdInternalIds } = await executeKyselyMutationPhase(kysely, compiled.mutationBatch);
 * if (!success) {
 *   console.log("Version conflict detected, retrying...");
 * }
 * ```
 */
export async function executeKyselyMutationPhase(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kysely: Kysely<any>,
  mutationBatch: CompiledMutation<CompiledQuery>[],
): Promise<MutationResult> {
  // If there are no mutations, return success immediately
  if (mutationBatch.length === 0) {
    return { success: true, createdInternalIds: [] };
  }

  const createdInternalIds: (bigint | null)[] = [];

  // Execute mutation batch in a transaction
  try {
    await kysely.transaction().execute(async (tx) => {
      for (const compiledMutation of mutationBatch) {
        const result = await tx.executeQuery(compiledMutation.query);

        // Best-effort extraction: Try to get internal ID if available
        // This is optional - the system works without it by using subqueries for references
        if (compiledMutation.expectedAffectedRows === null) {
          if (Array.isArray(result.rows) && result.rows.length > 0) {
            const row = result.rows[0] as Record<string, unknown>;
            if ("_internalId" in row || "_internal_id" in row) {
              const internalId = (row["_internalId"] ?? row["_internal_id"]) as bigint;
              createdInternalIds.push(internalId);
            } else {
              // RETURNING supported but _internalId not found - that's okay
              createdInternalIds.push(null);
            }
          } else {
            // No rows returned (no RETURNING clause, or SQLite via executeQuery)
            // This is fine - references will use subqueries based on external IDs
            createdInternalIds.push(null);
          }
        } else if (compiledMutation.expectedAffectedRows !== null) {
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

        if (compiledMutation.expectedReturnedRows !== null) {
          // For SELECT queries (check operations), verify row count
          const rowCount = Array.isArray(result.rows) ? result.rows.length : 0;

          if (rowCount !== compiledMutation.expectedReturnedRows) {
            // Version conflict detected - the SELECT didn't return the expected number of rows
            // This means either the row doesn't exist or the version has changed
            throw new Error(
              `Version conflict: expected ${compiledMutation.expectedReturnedRows} rows returned, but got ${rowCount}`,
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
