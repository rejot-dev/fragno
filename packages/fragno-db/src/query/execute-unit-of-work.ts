import type { AnySchema } from "../schema/create";
import type { UnitOfWork } from "./unit-of-work";
import { NoRetryPolicy, type RetryPolicy } from "./retry-policy";
import type { FragnoId } from "../schema/create";

/**
 * Result of executing a Unit of Work with retry support
 */
export type ExecuteUnitOfWorkResult<TRetrievalResults, TMutationResult> =
  | {
      success: true;
      results: TRetrievalResults;
      mutationResult: TMutationResult;
      createdIds: FragnoId[];
    }
  | {
      success: false;
      reason: "conflict";
    }
  | {
      success: false;
      reason: "aborted";
    }
  | {
      success: false;
      reason: "error";
      error: unknown;
    };

/**
 * Callbacks for executing a Unit of Work
 */
export interface ExecuteUnitOfWorkCallbacks<
  TSchema extends AnySchema,
  TRetrievalResults extends unknown[],
  TMutationResult,
  TRawInput,
> {
  /**
   * Retrieval phase callback - adds retrieval operations to the UOW
   */
  retrieve?: (
    uow: UnitOfWork<TSchema, [], TRawInput>,
  ) => UnitOfWork<TSchema, TRetrievalResults, TRawInput>;

  /**
   * Mutation phase callback - receives UOW and retrieval results, adds mutation operations
   */
  mutate?: (
    uow: UnitOfWork<TSchema, TRetrievalResults, TRawInput>,
    results: TRetrievalResults,
  ) => TMutationResult | Promise<TMutationResult>;

  /**
   * Success callback - invoked after successful execution
   */
  onSuccess?: (result: {
    results: TRetrievalResults;
    mutationResult: TMutationResult;
    createdIds: FragnoId[];
  }) => void | Promise<void>;
}

/**
 * Options for executing a Unit of Work
 */
export interface ExecuteUnitOfWorkOptions<TSchema extends AnySchema, TRawInput> {
  /**
   * Factory function that creates a fresh UOW instance for each attempt
   */
  createUnitOfWork: () => UnitOfWork<TSchema, [], TRawInput>;

  /**
   * Retry policy for handling optimistic concurrency conflicts
   */
  retryPolicy?: RetryPolicy;

  /**
   * Abort signal to cancel execution
   */
  signal?: AbortSignal;
}

/**
 * Execute a Unit of Work with automatic retry support for optimistic concurrency conflicts.
 *
 * This function orchestrates the two-phase execution (retrieval + mutation) with retry logic.
 * It creates fresh UOW instances for each attempt.
 *
 * @param callbacks - Object containing retrieve, mutate, and onSuccess callbacks
 * @param options - Configuration including UOW factory, retry policy, and abort signal
 * @returns Promise resolving to the execution result
 *
 * @example
 * ```ts
 * const result = await executeUnitOfWork(
 *   {
 *     retrieve: (uow) => uow.find("users", (b) => b.whereIndex("primary")),
 *     mutate: (uow, [users]) => {
 *       const user = users[0];
 *       uow.update("users", user.id, (b) => b.set({ balance: newBalance }));
 *     },
 *     onSuccess: async ({ results, mutationResult }) => {
 *       console.log("Update successful!");
 *     }
 *   },
 *   {
 *     createUnitOfWork: () => queryEngine.createUnitOfWork(),
 *     retryPolicy: new ExponentialBackoffRetryPolicy({ maxRetries: 3 })
 *   }
 * );
 * ```
 */
export async function executeUnitOfWork<
  TSchema extends AnySchema,
  TRetrievalResults extends unknown[],
  TMutationResult = void,
  TRawInput = unknown,
>(
  callbacks: ExecuteUnitOfWorkCallbacks<TSchema, TRetrievalResults, TMutationResult, TRawInput>,
  options: ExecuteUnitOfWorkOptions<TSchema, TRawInput>,
): Promise<ExecuteUnitOfWorkResult<TRetrievalResults, TMutationResult>> {
  // Validate that at least one of retrieve or mutate is provided
  if (!callbacks.retrieve && !callbacks.mutate) {
    throw new Error("At least one of 'retrieve' or 'mutate' callbacks must be provided");
  }

  const retryPolicy = options.retryPolicy ?? new NoRetryPolicy();
  const signal = options.signal;
  let attempt = 0;

  while (true) {
    // Check if aborted before starting attempt
    if (signal?.aborted) {
      return { success: false, reason: "aborted" };
    }

    try {
      // Create a fresh UOW for this attempt
      const uow = options.createUnitOfWork();

      // Apply retrieval phase if provided
      let retrievalUow: UnitOfWork<TSchema, TRetrievalResults, TRawInput>;
      if (callbacks.retrieve) {
        retrievalUow = callbacks.retrieve(uow);
      } else {
        // No retrieval phase, use empty UOW with type cast
        // This is safe because when there's no retrieve, TRetrievalResults should be []
        retrievalUow = uow as unknown as UnitOfWork<TSchema, TRetrievalResults, TRawInput>;
      }

      // Execute retrieval phase
      const results = (await retrievalUow.executeRetrieve()) as TRetrievalResults;

      // Invoke mutation phase callback if provided
      let mutationResult: TMutationResult;
      if (callbacks.mutate) {
        mutationResult = await callbacks.mutate(retrievalUow, results);
      } else {
        mutationResult = undefined as TMutationResult;
      }

      // Execute mutation phase
      const { success } = await retrievalUow.executeMutations();

      if (success) {
        // Success! Get created IDs and invoke onSuccess if provided
        const createdIds = retrievalUow.getCreatedIds();

        if (callbacks.onSuccess) {
          await callbacks.onSuccess({
            results,
            mutationResult,
            createdIds,
          });
        }

        return {
          success: true,
          results,
          mutationResult,
          createdIds,
        };
      }

      // Failed - check if we should retry
      // attempt represents the number of attempts completed so far
      if (!retryPolicy.shouldRetry(attempt, undefined, signal)) {
        // No more retries
        return { success: false, reason: "conflict" };
      }

      // Wait before retrying
      const delayMs = retryPolicy.getDelayMs(attempt);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      // Increment attempt counter for next iteration
      attempt++;
    } catch (error) {
      // An error was thrown during execution
      return { success: false, reason: "error", error };
    }
  }
}
