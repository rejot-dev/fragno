import type { AnySchema } from "../../schema/create";
import type { TypedUnitOfWork, IUnitOfWork } from "./unit-of-work";
import type { HooksMap } from "../../hooks/hooks";
import { NoRetryPolicy, ExponentialBackoffRetryPolicy, type RetryPolicy } from "./retry-policy";
import type { FragnoId } from "../../schema/create";

/**
 * Error thrown when a Unit of Work execution fails due to optimistic concurrency conflict.
 * This error triggers automatic retry behavior in executeRestrictedUnitOfWork.
 */
export class ConcurrencyConflictError extends Error {
  constructor(message = "Optimistic concurrency conflict detected") {
    super(message);
    this.name = "ConcurrencyConflictError";
  }
}

/**
 * Type utility that unwraps promises 1 level deep in objects, arrays, or direct promises
 * Handles tuples, arrays, objects, and direct promises
 */
export type AwaitedPromisesInObject<T> =
  // First check if it's a Promise
  T extends Promise<infer U>
    ? Awaited<U>
    : // Check for arrays with known length (tuples) - preserves tuple structure
      T extends readonly [unknown, ...unknown[]]
      ? { [K in keyof T]: AwaitedPromisesInObject<T[K]> }
      : T extends [unknown, ...unknown[]]
        ? { [K in keyof T]: AwaitedPromisesInObject<T[K]> }
        : // Check for regular arrays (unknown length)
          T extends (infer U)[]
          ? Awaited<U>[]
          : T extends readonly (infer U)[]
            ? readonly Awaited<U>[]
            : // Check for objects
              T extends Record<string, unknown>
              ? {
                  [K in keyof T]: T[K] extends Promise<infer U> ? Awaited<U> : T[K];
                }
              : // Otherwise return as-is
                T;

/**
 * Await promises in an object 1 level deep
 */
async function awaitPromisesInObject<T>(obj: T): Promise<AwaitedPromisesInObject<T>> {
  if (obj === null || obj === undefined) {
    return obj as AwaitedPromisesInObject<T>;
  }

  if (typeof obj !== "object") {
    return obj as AwaitedPromisesInObject<T>;
  }

  // Check if it's a Promise
  if (obj instanceof Promise) {
    return (await obj) as AwaitedPromisesInObject<T>;
  }

  // Check if it's an array
  if (Array.isArray(obj)) {
    const awaited = await Promise.all(
      obj.map((item) => (item instanceof Promise ? item : Promise.resolve(item))),
    );
    return awaited as AwaitedPromisesInObject<T>;
  }

  // It's a plain object - await promises in each property
  const result = {} as T;
  const entries = Object.entries(obj as Record<string, unknown>);
  const awaitedEntries = await Promise.all(
    entries.map(async ([key, value]) => {
      const awaitedValue = value instanceof Promise ? await value : value;
      return [key, awaitedValue] as const;
    }),
  );

  for (const [key, value] of awaitedEntries) {
    (result as Record<string, unknown>)[key] = value;
  }

  return result as AwaitedPromisesInObject<T>;
}

/**
 * Result of executing a Unit of Work with retry support
 * Promises in mutationResult are unwrapped 1 level deep
 */
export type ExecuteUnitOfWorkResult<TRetrievalResults, TMutationResult> =
  | {
      success: true;
      results: TRetrievalResults;
      mutationResult: AwaitedPromisesInObject<TMutationResult>;
      createdIds: FragnoId[];
      nonce: string;
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
    uow: TypedUnitOfWork<TSchema, [], TRawInput>,
  ) => TypedUnitOfWork<TSchema, TRetrievalResults, TRawInput>;

  /**
   * Mutation phase callback - receives UOW and retrieval results, adds mutation operations
   */
  mutate?: (
    uow: TypedUnitOfWork<TSchema, TRetrievalResults, TRawInput>,
    results: TRetrievalResults,
  ) => TMutationResult | Promise<TMutationResult>;

  /**
   * Success callback - invoked after successful execution
   * Promises in mutationResult are already unwrapped 1 level deep
   */
  onSuccess?: (result: {
    results: TRetrievalResults;
    mutationResult: AwaitedPromisesInObject<TMutationResult>;
    createdIds: FragnoId[];
    nonce: string;
  }) => void | Promise<void>;
}

/**
 * Options for executing a Unit of Work
 */
export interface ExecuteUnitOfWorkOptions<TSchema extends AnySchema, TRawInput> {
  /**
   * Factory function that creates or resets a UOW instance for each attempt
   */
  createUnitOfWork: () => TypedUnitOfWork<TSchema, [], TRawInput>;

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
 * Create a bound version of executeUnitOfWork with a pre-configured UOW factory.
 * This is useful for handler contexts where the factory is already known.
 *
 * @param createUnitOfWork - Factory function that creates a fresh UOW instance
 * @returns A bound executeUnitOfWork function that doesn't require the factory parameter
 *
 * @example
 * ```ts
 * const boundExecute = createExecuteUnitOfWork(() => db.createUnitOfWork());
 * const result = await boundExecute({
 *   retrieve: (uow) => uow.find("users", (b) => b.whereIndex("primary")),
 *   mutate: (uow, [users]) => {
 *     uow.update("users", users[0].id, (b) => b.set({ balance: newBalance }));
 *   }
 * });
 * ```
 */
export function createExecuteUnitOfWork<TSchema extends AnySchema, TRawInput>(
  createUnitOfWork: () => TypedUnitOfWork<TSchema, [], TRawInput>,
) {
  return async function <TRetrievalResults extends unknown[], TMutationResult = void>(
    callbacks: ExecuteUnitOfWorkCallbacks<TSchema, TRetrievalResults, TMutationResult, TRawInput>,
    options?: Omit<ExecuteUnitOfWorkOptions<TSchema, TRawInput>, "createUnitOfWork">,
  ): Promise<ExecuteUnitOfWorkResult<TRetrievalResults, TMutationResult>> {
    return executeUnitOfWork(callbacks, { ...options, createUnitOfWork });
  };
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
      let retrievalUow: TypedUnitOfWork<TSchema, TRetrievalResults, TRawInput>;
      if (callbacks.retrieve) {
        retrievalUow = callbacks.retrieve(uow);
      } else {
        // No retrieval phase, use empty UOW with type cast
        // This is safe because when there's no retrieve, TRetrievalResults should be []
        retrievalUow = uow as unknown as TypedUnitOfWork<TSchema, TRetrievalResults, TRawInput>;
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
        // Success! Get created IDs and nonce, then invoke onSuccess if provided
        const createdIds = retrievalUow.getCreatedIds();
        const nonce = retrievalUow.nonce;

        // Await promises in mutationResult (1 level deep)
        const awaitedMutationResult = await awaitPromisesInObject(mutationResult);

        if (callbacks.onSuccess) {
          await callbacks.onSuccess({
            results,
            mutationResult: awaitedMutationResult,
            createdIds,
            nonce,
          });
        }

        return {
          success: true,
          results,
          mutationResult: awaitedMutationResult,
          createdIds,
          nonce,
        };
      }

      // Failed - check if we should retry
      // attempt represents the number of attempts completed so far
      if (!retryPolicy.shouldRetry(attempt, undefined, signal)) {
        // No more retries
        return { success: false, reason: "conflict" };
      }

      const delayMs = retryPolicy.getDelayMs(attempt);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      attempt++;
    } catch (error) {
      // An error was thrown during execution
      return { success: false, reason: "error", error };
    }
  }
}

/**
 * Options for executing a Unit of Work with restricted access
 */
export interface ExecuteRestrictedUnitOfWorkOptions {
  /**
   * Factory function that creates or resets a UOW instance for each attempt
   */
  createUnitOfWork: () => IUnitOfWork;

  /**
   * Retry policy for handling optimistic concurrency conflicts
   */
  retryPolicy?: RetryPolicy;

  /**
   * Abort signal to cancel execution
   */
  signal?: AbortSignal;

  /**
   * Callback invoked before mutations are executed.
   * Use this to add additional mutation operations (e.g., hook event records).
   */
  onBeforeMutate?: (uow: IUnitOfWork) => void;

  /**
   * Callback invoked after successful mutation phase.
   * Use this for post-mutation processing like hook execution.
   */
  onSuccess?: (uow: IUnitOfWork) => Promise<void>;
}

/**
 * Context provided to handler tx callbacks
 */
export interface TxPhaseContext<THooks extends HooksMap> {
  /**
   * Get a typed Unit of Work for the given schema
   */
  forSchema: <S extends AnySchema, H extends HooksMap = THooks>(
    schema: S,
    hooks?: H,
  ) => TypedUnitOfWork<S, [], unknown, H>;
}

/**
 * Handler callbacks for tx() - SYNCHRONOUS ONLY (no Promise return allowed)
 * This prevents accidentally awaiting services in the wrong place
 */
export interface HandlerTxCallbacks<TRetrieveResult, TMutationResult, THooks extends HooksMap> {
  /**
   * Retrieval phase callback - schedules retrievals and optionally calls services
   * Must be synchronous - cannot await promises
   */
  retrieve?: (context: TxPhaseContext<THooks>) => TRetrieveResult;
  /**
   * Mutation phase callback - receives retrieve result, schedules mutations
   * Must be synchronous - cannot await promises (but may return a promise to be awaited)
   */
  mutate?: (context: TxPhaseContext<THooks>, retrieveResult: TRetrieveResult) => TMutationResult;
}

export interface ServiceTxCallbacks<
  TSchema extends AnySchema,
  TRetrievalResults extends unknown[],
  TMutationResult,
  THooks extends HooksMap,
> {
  /**
   * Retrieval phase callback - schedules retrievals, returns typed UOW
   */
  retrieve?: (
    uow: TypedUnitOfWork<TSchema, [], unknown, THooks>,
  ) => TypedUnitOfWork<TSchema, TRetrievalResults, unknown, THooks>;
  /**
   * Mutation phase callback - receives retrieval results, schedules mutations and hooks
   */
  mutate?: (
    uow: TypedUnitOfWork<TSchema, TRetrievalResults, unknown, THooks>,
    results: TRetrievalResults,
  ) => TMutationResult | Promise<TMutationResult>;
}

/**
 * Execute a Unit of Work with explicit phase control and automatic retry support.
 *
 * This function provides an alternative API where users write a single callback that receives
 * a context object with forSchema, executeRetrieve, and executeMutate methods. The user can
 * create schema-specific UOWs via forSchema, then call executeRetrieve() and executeMutate()
 * to execute the retrieval and mutation phases. The entire callback is re-executed on optimistic
 * concurrency conflicts, ensuring retries work properly.
 *
 * @param callback - Async function that receives a context with forSchema, executeRetrieve, executeMutate, nonce, and currentAttempt
 * @param options - Configuration including UOW factory, retry policy, and abort signal
 * @returns Promise resolving to the callback's return value
 * @throws Error if retries are exhausted or callback throws an error
 *
 * @example
 * ```ts
 * const { userId, profileId } = await executeRestrictedUnitOfWork(
 *   async ({ forSchema, executeRetrieve, executeMutate, nonce, currentAttempt }) => {
 *     const uow = forSchema(schema);
 *     const userId = uow.create("users", { name: "John" });
 *
 *     // Execute retrieval phase
 *     await executeRetrieve();
 *
 *     const profileId = uow.create("profiles", { userId });
 *
 *     // Execute mutation phase
 *     await executeMutate();
 *
 *     return { userId, profileId };
 *   },
 *   {
 *     createUnitOfWork: () => db.createUnitOfWork(),
 *     retryPolicy: new ExponentialBackoffRetryPolicy({ maxRetries: 5 })
 *   }
 * );
 * ```
 */
export async function executeRestrictedUnitOfWork<TResult, THooks extends HooksMap = {}>(
  callback: (context: {
    forSchema: <S extends AnySchema, H extends HooksMap = THooks>(
      schema: S,
      hooks?: H,
    ) => TypedUnitOfWork<S, [], unknown, H>;
    executeRetrieve: () => Promise<void>;
    executeMutate: () => Promise<void>;
    nonce: string;
    currentAttempt: number;
  }) => Promise<TResult>,
  options: ExecuteRestrictedUnitOfWorkOptions,
): Promise<AwaitedPromisesInObject<TResult>> {
  // Default retry policy with small, fast retries for optimistic concurrency
  const retryPolicy =
    options.retryPolicy ??
    new ExponentialBackoffRetryPolicy({
      maxRetries: 5,
      initialDelayMs: 10,
      maxDelayMs: 100,
    });
  const signal = options.signal;
  let attempt = 0;

  while (true) {
    // Check if aborted before starting attempt
    if (signal?.aborted) {
      throw new Error("Unit of Work execution aborted");
    }

    try {
      // Create a fresh UOW for this attempt
      const baseUow = options.createUnitOfWork();

      const context = {
        forSchema: <S extends AnySchema, H extends HooksMap = THooks>(schema: S, hooks?: H) => {
          return baseUow.forSchema(schema, hooks);
        },
        executeRetrieve: async () => {
          await baseUow.executeRetrieve();
        },
        executeMutate: async () => {
          if (baseUow.state === "executed") {
            return;
          }

          if (baseUow.state === "building-retrieval") {
            await baseUow.executeRetrieve();
          }

          // Add hook mutations before executing
          if (options.onBeforeMutate) {
            options.onBeforeMutate(baseUow);
          }

          const result = await baseUow.executeMutations();
          if (!result.success) {
            throw new ConcurrencyConflictError();
          }

          if (options.onSuccess) {
            await options.onSuccess(baseUow);
          }
        },
        nonce: baseUow.nonce,
        currentAttempt: attempt,
      };

      // Execute the callback which will call executeRetrieve and executeMutate
      const result = await callback(context);

      // Await promises in the result object (1 level deep)
      const awaitedResult = await awaitPromisesInObject(result);

      // Return the awaited result
      return awaitedResult;
    } catch (error) {
      if (signal?.aborted) {
        throw new Error("Unit of Work execution aborted");
      }

      // Only retry concurrency conflicts, not other errors
      if (!(error instanceof ConcurrencyConflictError)) {
        // Not a concurrency conflict - throw immediately without retry
        throw error;
      }

      if (!retryPolicy.shouldRetry(attempt, error, signal)) {
        // No more retries - check again if aborted or throw conflict error
        if (signal?.aborted) {
          throw new Error("Unit of Work execution aborted");
        }
        throw new Error("Unit of Work execution failed: optimistic concurrency conflict", {
          cause: error,
        });
      }

      const delayMs = retryPolicy.getDelayMs(attempt);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      attempt++;
    }
  }
}

/**
 * Execute a transaction with array syntax (handler context).
 * Takes a factory function that creates an array of service promises, enabling proper retry support.
 *
 * @param servicesFactory - Function that creates an array of service promises
 * @param options - Configuration including UOW factory, retry policy, and abort signal
 * @returns Promise resolving to array of awaited service results
 *
 * @example
 * ```ts
 * const [result1, result2] = await executeTxArray(
 *   () => [
 *     executeServiceTx(schema, callbacks1, uow),
 *     executeServiceTx(schema, callbacks2, uow)
 *   ],
 *   { createUnitOfWork }
 * );
 * ```
 */
export async function executeTxArray<T extends readonly unknown[]>(
  servicesFactory: () => readonly [...{ [K in keyof T]: Promise<T[K]> }],
  options: ExecuteRestrictedUnitOfWorkOptions,
): Promise<{ [K in keyof T]: T[K] }> {
  const retryPolicy =
    options.retryPolicy ??
    new ExponentialBackoffRetryPolicy({
      maxRetries: 5,
      initialDelayMs: 10,
      maxDelayMs: 100,
    });
  const signal = options.signal;
  let attempt = 0;

  while (true) {
    // Check if aborted before starting attempt
    if (signal?.aborted) {
      throw new Error("Unit of Work execution aborted");
    }

    try {
      // Create a fresh UOW for this attempt
      const baseUow = options.createUnitOfWork();

      // Call factory to create fresh service promises for this attempt
      const services = servicesFactory();

      await baseUow.executeRetrieve();

      if (options.onBeforeMutate) {
        options.onBeforeMutate(baseUow);
      }

      const result = await baseUow.executeMutations();
      if (!result.success) {
        throw new ConcurrencyConflictError();
      }

      if (options.onSuccess) {
        await options.onSuccess(baseUow);
      }

      // Now await all service promises - they should all resolve now that mutations executed
      const results = await Promise.all(services);
      return results as { [K in keyof T]: T[K] };
    } catch (error) {
      if (signal?.aborted) {
        throw new Error("Unit of Work execution aborted");
      }

      // Only retry concurrency conflicts, not other errors
      if (!(error instanceof ConcurrencyConflictError)) {
        throw error;
      }

      if (!retryPolicy.shouldRetry(attempt, error, signal)) {
        if (signal?.aborted) {
          throw new Error("Unit of Work execution aborted");
        }
        throw new Error("Unit of Work execution failed: optimistic concurrency conflict", {
          cause: error,
        });
      }

      const delayMs = retryPolicy.getDelayMs(attempt);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      attempt++;
    }
  }
}

/**
 * Execute a transaction with callback syntax (handler context).
 * Callbacks are synchronous only to prevent accidentally awaiting services in wrong place.
 *
 * @param callbacks - Object containing retrieve and mutate callbacks
 * @param options - Configuration including UOW factory, retry policy, and abort signal
 * @returns Promise resolving to the mutation result with promises awaited 1 level deep
 */
export async function executeTxCallbacks<
  TRetrieveResult,
  TMutationResult,
  THooks extends HooksMap = {},
>(
  callbacks: HandlerTxCallbacks<TRetrieveResult, TMutationResult, THooks>,
  options: ExecuteRestrictedUnitOfWorkOptions,
): Promise<AwaitedPromisesInObject<TMutationResult>> {
  const retryPolicy =
    options.retryPolicy ??
    new ExponentialBackoffRetryPolicy({
      maxRetries: 5,
      initialDelayMs: 10,
      maxDelayMs: 100,
    });
  const signal = options.signal;
  let attempt = 0;

  while (true) {
    // Check if aborted before starting attempt
    if (signal?.aborted) {
      throw new Error("Unit of Work execution aborted");
    }

    try {
      // Create a fresh UOW for this attempt
      const baseUow = options.createUnitOfWork();

      const context: TxPhaseContext<THooks> = {
        forSchema: <S extends AnySchema, H extends HooksMap = THooks>(schema: S, hooks?: H) => {
          return baseUow.forSchema(schema, hooks);
        },
      };

      let retrieveResult: TRetrieveResult;
      if (callbacks.retrieve) {
        retrieveResult = callbacks.retrieve(context);
      } else {
        retrieveResult = undefined as TRetrieveResult;
      }

      await baseUow.executeRetrieve();

      let mutationResult: TMutationResult;
      if (callbacks.mutate) {
        mutationResult = callbacks.mutate(context, retrieveResult);
      } else {
        mutationResult = retrieveResult as unknown as TMutationResult;
      }

      const awaitedMutationResult = await awaitPromisesInObject(mutationResult);

      if (options.onBeforeMutate) {
        options.onBeforeMutate(baseUow);
      }

      const result = await baseUow.executeMutations();
      if (!result.success) {
        throw new ConcurrencyConflictError();
      }

      if (options.onSuccess) {
        await options.onSuccess(baseUow);
      }

      return awaitedMutationResult;
    } catch (error) {
      if (signal?.aborted) {
        throw new Error("Unit of Work execution aborted");
      }

      // Only retry concurrency conflicts, not other errors
      if (!(error instanceof ConcurrencyConflictError)) {
        throw error;
      }

      if (!retryPolicy.shouldRetry(attempt, error, signal)) {
        if (signal?.aborted) {
          throw new Error("Unit of Work execution aborted");
        }
        throw new Error("Unit of Work execution failed: optimistic concurrency conflict", {
          cause: error,
        });
      }

      const delayMs = retryPolicy.getDelayMs(attempt);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      attempt++;
    }
  }
}

/**
 * Execute a transaction for service context.
 * Service callbacks can be async for ergonomic async work.
 *
 * @param schema - Schema to use for the transaction
 * @param callbacks - Object containing retrieve and mutate callbacks
 * @param baseUow - Base Unit of Work (restricted) to use
 * @returns Promise resolving to the mutation result with promises awaited 1 level deep
 */
export async function executeServiceTx<
  TSchema extends AnySchema,
  TRetrievalResults extends unknown[],
  TMutationResult,
  THooks extends HooksMap,
>(
  schema: TSchema,
  callbacks: ServiceTxCallbacks<TSchema, TRetrievalResults, TMutationResult, THooks>,
  baseUow: IUnitOfWork,
): Promise<AwaitedPromisesInObject<TMutationResult>> {
  const typedUow = baseUow.restrict({ readyFor: "none" }).forSchema<TSchema, THooks>(schema);

  let retrievalUow: TypedUnitOfWork<TSchema, TRetrievalResults, unknown, THooks>;
  try {
    if (callbacks.retrieve) {
      retrievalUow = callbacks.retrieve(typedUow);
    } else {
      // Safe cast: when there's no retrieve callback, TRetrievalResults should be []
      retrievalUow = typedUow as unknown as TypedUnitOfWork<
        TSchema,
        TRetrievalResults,
        unknown,
        THooks
      >;
    }
  } catch (error) {
    typedUow.signalReadyForRetrieval();
    typedUow.signalReadyForMutation();
    throw error;
  }

  typedUow.signalReadyForRetrieval();

  // Safe cast: retrievalPhase returns the correct type based on the UOW's type parameters
  const results = (await retrievalUow.retrievalPhase) as TRetrievalResults;

  let mutationResult: TMutationResult;
  try {
    if (callbacks.mutate) {
      mutationResult = await callbacks.mutate(retrievalUow, results);
    } else {
      // Safe cast: when there's no mutate callback, TMutationResult should be void
      mutationResult = undefined as TMutationResult;
    }
  } catch (error) {
    typedUow.signalReadyForMutation();
    throw error;
  }

  typedUow.signalReadyForMutation();

  await retrievalUow.mutationPhase;

  return await awaitPromisesInObject(mutationResult);
}
