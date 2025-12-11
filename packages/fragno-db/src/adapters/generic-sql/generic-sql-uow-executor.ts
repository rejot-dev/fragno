import type {
  CompiledMutation,
  MutationResult,
  UOWExecutor,
} from "../../query/unit-of-work/unit-of-work";
import type { CompiledQuery, QueryResult } from "../../sql-driver/sql-driver";
import type { SqlDriverAdapter } from "../../sql-driver/sql-driver-adapter";

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

export async function executeRetrieval(
  adapter: SqlDriverAdapter,
  retrievalBatch: CompiledQuery[],
): Promise<unknown[]> {
  // If no retrieval operations, return empty array immediately
  if (retrievalBatch.length === 0) {
    return [];
  }

  const retrievalResults: unknown[] = [];

  await adapter.transaction(async (tx) => {
    for (const compiledQuery of retrievalBatch) {
      const result = await tx.executeQuery(compiledQuery);
      retrievalResults.push(result.rows);
    }
  });

  return retrievalResults;
}

export async function executeMutation(
  adapter: SqlDriverAdapter,
  mutationBatch: CompiledMutation<CompiledQuery>[],
): Promise<MutationResult> {
  // If there are no mutations, return success immediately
  if (mutationBatch.length === 0) {
    return { success: true, createdInternalIds: [] };
  }

  const createdInternalIds: (bigint | null)[] = [];

  // Execute mutation batch in a transaction
  try {
    await adapter.transaction(async (tx) => {
      for (const compiledMutation of mutationBatch) {
        const result = await tx.executeQuery(compiledMutation.query);

        // Best-effort extraction: Try to get internal ID if available
        // This is optional - the system works without it by using subqueries for references
        if (compiledMutation.expectedAffectedRows === null) {
          if (Array.isArray(result.rows) && result.rows.length > 0) {
            const row = result.rows[0] as Record<string, unknown>;
            if ("_internalId" in row || "_internal_id" in row) {
              const rawId = row["_internalId"] ?? row["_internal_id"];
              // Normalize to bigint - different drivers return different types for integer columns
              // TODO(Wilco): Move this to a better place
              const internalId =
                typeof rawId === "bigint"
                  ? rawId
                  : typeof rawId === "number"
                    ? BigInt(rawId)
                    : null;
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

export function createExecutor(
  adapter: SqlDriverAdapter,
  dryRun?: boolean,
): UOWExecutor<CompiledQuery, unknown> {
  return {
    async executeRetrievalPhase(retrievalBatch: CompiledQuery[]) {
      // In dryRun mode, skip execution and return empty results
      if (dryRun) {
        return retrievalBatch.map(() => []);
      }

      return executeRetrieval(adapter, retrievalBatch);
    },
    async executeMutationPhase(mutationBatch: CompiledMutation<CompiledQuery>[]) {
      // In dryRun mode, skip execution and return success with mock internal IDs
      if (dryRun) {
        return {
          success: true,
          createdInternalIds: mutationBatch.map(() => null),
        };
      }

      return executeMutation(adapter, mutationBatch);
    },
  };
}
