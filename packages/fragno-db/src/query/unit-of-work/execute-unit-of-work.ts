import type { AnySchema } from "../../schema/create";
import type { TypedUnitOfWork, IUnitOfWork } from "./unit-of-work";
import type { HooksMap } from "../../hooks/hooks";
import { ExponentialBackoffRetryPolicy, NoRetryPolicy, type RetryPolicy } from "./retry-policy";

/**
 * Symbol to identify TxResult objects
 */
const TX_RESULT_BRAND = Symbol("TxResult");

/**
 * Check if a value is a TxResult
 */
export function isTxResult(value: unknown): value is TxResult<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    TX_RESULT_BRAND in value &&
    (value as Record<symbol, boolean>)[TX_RESULT_BRAND] === true
  );
}

/**
 * Extract the retrieve success result type from a TxResult.
 * If the TxResult has retrieveSuccess, returns its return type.
 * Otherwise returns the raw retrieve results type.
 * Handles undefined (for optional service patterns like optionalService?.method()).
 */
export type ExtractTxRetrieveSuccessResult<T> = T extends undefined
  ? undefined
  : T extends TxResult<unknown, infer R>
    ? R
    : never;

/**
 * Extract the final result type from a TxResult.
 * Handles undefined (for optional service patterns like optionalService?.method()).
 */
export type ExtractTxFinalResult<T> = T extends undefined
  ? undefined
  : T extends TxResult<infer R, infer _>
    ? R
    : Awaited<T>;

/**
 * Map over service calls array to extract retrieve success results from each service call.
 * Preserves tuple structure while extracting the retrieve success result type from each element.
 */
export type ExtractServiceRetrieveResults<T extends readonly unknown[]> = {
  [K in keyof T]: ExtractTxRetrieveSuccessResult<T[K]>;
};

/**
 * Map over service calls array to extract final results from each service call.
 * Preserves tuple structure while extracting the final result type from each element.
 */
export type ExtractServiceFinalResults<T extends readonly unknown[]> = {
  [K in keyof T]: ExtractTxFinalResult<T[K]>;
};

/**
 * Context passed to mutate callback for service methods
 */
export interface ServiceTxMutateContext<
  TSchema extends AnySchema,
  TRetrieveSuccessResult,
  TServiceRetrieveResults extends readonly unknown[],
  THooks extends HooksMap,
> {
  /** Unit of work for scheduling mutations */
  uow: TypedUnitOfWork<TSchema, [], unknown, THooks>;
  /** Result from retrieveSuccess callback (or raw retrieve results if no retrieveSuccess) */
  retrieveResult: TRetrieveSuccessResult;
  /** Array of retrieve success results from service calls (intermediate results, not final) */
  serviceIntermediateResult: TServiceRetrieveResults;
}

/**
 * Context passed to handler-level callbacks
 */
export interface HandlerTxContext<THooks extends HooksMap> {
  /** Get a typed Unit of Work for the given schema */
  forSchema: <S extends AnySchema, H extends HooksMap = THooks>(
    schema: S,
    hooks?: H,
  ) => TypedUnitOfWork<S, [], unknown, H>;
  /** Unique key for this transaction attempt (for idempotency/deduplication) */
  idempotencyKey: string;
  /** Current attempt number (0-based) */
  currentAttempt: number;
}

/**
 * Context passed to handler mutate callback
 */
export interface HandlerTxMutateContext<
  TRetrieveSuccessResult,
  TServiceRetrieveResults extends readonly unknown[],
  THooks extends HooksMap,
> extends HandlerTxContext<THooks> {
  /** Result from retrieveSuccess callback (or raw retrieve results if no retrieveSuccess) */
  retrieveResult: TRetrieveSuccessResult;
  /** Array of retrieve success results from service calls (intermediate results, not final) */
  serviceIntermediateResult: TServiceRetrieveResults;
}

/**
 * Context passed to success callback when mutate IS provided
 */
export interface TxSuccessContextWithMutate<
  TRetrieveSuccessResult,
  TMutateResult,
  TServiceFinalResults extends readonly unknown[],
  TServiceRetrieveResults extends readonly unknown[],
> {
  /** Result from retrieveSuccess callback (or raw retrieve results if no retrieveSuccess) */
  retrieveResult: TRetrieveSuccessResult;
  /** Result from mutate callback */
  mutateResult: TMutateResult;
  /** Array of final results from service calls */
  serviceResult: TServiceFinalResults;
  /** Array of retrieve success results from service calls (same as what mutate receives) */
  serviceIntermediateResult: TServiceRetrieveResults;
}

/**
 * Context passed to success callback when mutate is NOT provided
 */
export interface TxSuccessContextWithoutMutate<
  TRetrieveSuccessResult,
  TServiceFinalResults extends readonly unknown[],
  TServiceRetrieveResults extends readonly unknown[],
> {
  /** Result from retrieveSuccess callback (or raw retrieve results if no retrieveSuccess) */
  retrieveResult: TRetrieveSuccessResult;
  /** No mutate callback was provided */
  mutateResult: undefined;
  /** Array of final results from service calls */
  serviceResult: TServiceFinalResults;
  /** Array of retrieve success results from service calls (same as what mutate receives) */
  serviceIntermediateResult: TServiceRetrieveResults;
}

/**
 * Context passed to success callback.
 * Union of TxSuccessContextWithMutate and TxSuccessContextWithoutMutate to handle
 * both cases in a single callback signature.
 */
export type TxSuccessContext<
  TRetrieveSuccessResult,
  TMutateResult,
  TServiceFinalResults extends readonly unknown[],
  TServiceRetrieveResults extends readonly unknown[] = readonly unknown[],
> =
  | TxSuccessContextWithMutate<
      TRetrieveSuccessResult,
      TMutateResult,
      TServiceFinalResults,
      TServiceRetrieveResults
    >
  | TxSuccessContextWithoutMutate<
      TRetrieveSuccessResult,
      TServiceFinalResults,
      TServiceRetrieveResults
    >;

/**
 * Callbacks for service-level TxResult.
 *
 * Return type priority:
 * 1. If success exists: ReturnType<success>
 * 2. Else if mutate exists: ReturnType<mutate>
 * 3. Else if retrieveSuccess exists: ReturnType<retrieveSuccess>
 * 4. Else if retrieve exists: TRetrieveResults
 * 5. Else: serviceResult array type
 */
export interface ServiceTxCallbacks<
  TSchema extends AnySchema,
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TServiceCalls extends readonly (TxResult<any, any> | undefined)[],
  TMutateResult,
  TSuccessResult,
  THooks extends HooksMap,
> {
  /**
   * Service calls - other TxResults to execute first.
   */
  serviceCalls?: () => TServiceCalls;

  /**
   * Retrieval phase callback - schedules retrieval operations.
   */
  retrieve?: (
    uow: TypedUnitOfWork<TSchema, [], unknown, THooks>,
  ) => TypedUnitOfWork<TSchema, TRetrieveResults, unknown, THooks>;

  /**
   * Transform retrieve results before passing to mutate.
   */
  retrieveSuccess?: (
    retrieveResult: TRetrieveResults,
    serviceResult: ExtractServiceRetrieveResults<TServiceCalls>,
  ) => TRetrieveSuccessResult;

  /**
   * Mutation phase callback - schedules mutations based on retrieve results.
   */
  mutate?: (
    ctx: ServiceTxMutateContext<
      TSchema,
      TRetrieveSuccessResult,
      ExtractServiceRetrieveResults<TServiceCalls>,
      THooks
    >,
  ) => TMutateResult;

  /**
   * Success callback - final transformation after mutations complete.
   */
  success?: (
    ctx: TxSuccessContext<
      TRetrieveSuccessResult,
      TMutateResult,
      ExtractServiceFinalResults<TServiceCalls>,
      ExtractServiceRetrieveResults<TServiceCalls>
    >,
  ) => TSuccessResult;
}

/**
 * Callbacks for handler-level executeTx.
 * Uses context-based callbacks that provide forSchema() method.
 */
export interface HandlerTxCallbacks<
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TServiceCalls extends readonly (TxResult<any, any> | undefined)[],
  TMutateResult,
  TSuccessResult,
  THooks extends HooksMap,
> {
  /**
   * Service calls - other TxResults to execute first.
   */
  serviceCalls?: () => TServiceCalls;

  /**
   * Retrieval phase callback - schedules retrieval operations using context.forSchema().
   * Return a TypedUnitOfWork to get typed results, or void for no retrieval.
   */
  retrieve?: (
    context: HandlerTxContext<THooks>,
  ) => TypedUnitOfWork<AnySchema, TRetrieveResults, unknown, HooksMap> | void;

  /**
   * Transform retrieve results before passing to mutate.
   */
  retrieveSuccess?: (
    retrieveResult: TRetrieveResults,
    serviceResult: ExtractServiceRetrieveResults<TServiceCalls>,
  ) => TRetrieveSuccessResult;

  /**
   * Mutation phase callback - schedules mutations based on retrieve results.
   */
  mutate?: (
    ctx: HandlerTxMutateContext<
      TRetrieveSuccessResult,
      ExtractServiceRetrieveResults<TServiceCalls>,
      THooks
    >,
  ) => TMutateResult;

  /**
   * Success callback - final transformation after mutations complete.
   */
  success?: (
    ctx: TxSuccessContext<
      TRetrieveSuccessResult,
      TMutateResult,
      ExtractServiceFinalResults<TServiceCalls>,
      ExtractServiceRetrieveResults<TServiceCalls>
    >,
  ) => TSuccessResult;
}

/**
 * Internal structure storing TxResult callbacks and state.
 */
interface TxResultInternal<
  TSchema extends AnySchema,
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  TServiceCalls extends readonly (TxResult<unknown> | undefined)[],
  TMutateResult,
  TSuccessResult,
  THooks extends HooksMap,
> {
  schema: TSchema | undefined;
  callbacks: ServiceTxCallbacks<
    TSchema,
    TRetrieveResults,
    TRetrieveSuccessResult,
    TServiceCalls,
    TMutateResult,
    TSuccessResult,
    THooks
  >;
  /** The typed UOW created during retrieve callback */
  typedUow: TypedUnitOfWork<TSchema, TRetrieveResults, unknown, THooks> | undefined;
  /** The restricted UOW for signaling (used when typedUow is undefined) */
  restrictedUow: IUnitOfWork;
  /** Promise that resolves when retrieve phase is complete */
  retrievePhase: Promise<TRetrieveResults>;
  /** Resolve function for retrievePhase */
  resolveRetrievePhase: (results: TRetrieveResults) => void;
  /** Reject function for retrievePhase */
  rejectRetrievePhase: (error: unknown) => void;
  /** Computed retrieve success result (set after retrieveSuccess runs) */
  retrieveSuccessResult: TRetrieveSuccessResult | undefined;
  /** Computed mutate result (set after mutate runs) */
  mutateResult: TMutateResult | undefined;
  /** Computed final result (set after success runs or defaults) */
  finalResult: TSuccessResult | undefined;
  /** Service calls resolved */
  serviceCalls: TServiceCalls | undefined;
}

/**
 * TxResult represents a transaction definition (not yet executed).
 * It describes the work to be done: retrieve operations, transformations, and mutations.
 *
 * Service methods return TxResult objects, and the handler's executeTx function
 * orchestrates their execution with retry support.
 *
 * @template TResult - The final result type (determined by return type priority)
 * @template TRetrieveSuccessResult - The retrieve success result type (what serviceCalls receive).
 *   Defaults to TResult, meaning serviceCalls receive the same type as the final result.
 */
export interface TxResult<TResult, TRetrieveSuccessResult = TResult> {
  /** Brand to identify TxResult objects */
  readonly [TX_RESULT_BRAND]: true;

  /** Internal structure - do not access directly */
  readonly _internal: TxResultInternal<
    AnySchema,
    unknown[],
    TRetrieveSuccessResult,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly TxResult<any, any>[],
    unknown,
    TResult,
    HooksMap
  >;
}

/**
 * Create a TxResult for service context.
 * Schedules retrieve operations on the baseUow and returns a TxResult with callbacks stored.
 * @internal Used by ServiceTxBuilder.build()
 */
function createServiceTx<
  TSchema extends AnySchema,
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TServiceCalls extends readonly (TxResult<any, any> | undefined)[],
  TMutateResult,
  TSuccessResult,
  THooks extends HooksMap = {},
>(
  schema: TSchema | undefined,
  callbacks: ServiceTxCallbacks<
    TSchema,
    TRetrieveResults,
    TRetrieveSuccessResult,
    TServiceCalls,
    TMutateResult,
    TSuccessResult,
    THooks
  >,
  baseUow: IUnitOfWork,
): TxResult<unknown, unknown> {
  // Create deferred promise for retrieve phase
  const {
    promise: retrievePhase,
    resolve: resolveRetrievePhase,
    reject: rejectRetrievePhase,
  } = Promise.withResolvers<TRetrieveResults>();

  // Get a restricted view that signals readiness
  const restrictedUow = baseUow.restrict({ readyFor: "none" });

  // Call serviceCalls factory if provided - this invokes other services which schedule their operations
  let serviceCalls: TServiceCalls | undefined;
  try {
    if (callbacks.serviceCalls) {
      serviceCalls = callbacks.serviceCalls();
    }
  } catch (error) {
    restrictedUow.signalReadyForRetrieval();
    restrictedUow.signalReadyForMutation();
    retrievePhase.catch(() => {});
    rejectRetrievePhase(error);
    throw error;
  }
  let typedUow: TypedUnitOfWork<TSchema, TRetrieveResults, unknown, THooks> | undefined;
  try {
    if (schema && callbacks.retrieve) {
      const emptyUow = restrictedUow.forSchema<TSchema, THooks>(schema);
      typedUow = callbacks.retrieve(emptyUow);
    }
  } catch (error) {
    restrictedUow.signalReadyForRetrieval();
    restrictedUow.signalReadyForMutation();
    retrievePhase.catch(() => {});
    rejectRetrievePhase(error);
    throw error;
  }
  restrictedUow.signalReadyForRetrieval();

  // Set up the retrieve phase promise to resolve when the handler executes retrieve
  if (typedUow) {
    typedUow.retrievalPhase.then(
      (results) => resolveRetrievePhase(results as TRetrieveResults),
      (error) => rejectRetrievePhase(error),
    );
  } else if (!callbacks.retrieve) {
    // No retrieve callback - resolve immediately with empty array
    resolveRetrievePhase([] as unknown as TRetrieveResults);
  }

  const internal: TxResultInternal<
    TSchema,
    TRetrieveResults,
    TRetrieveSuccessResult,
    TServiceCalls,
    TMutateResult,
    TSuccessResult,
    THooks
  > = {
    schema,
    callbacks,
    typedUow,
    restrictedUow,
    retrievePhase,
    resolveRetrievePhase,
    rejectRetrievePhase,
    retrieveSuccessResult: undefined,
    mutateResult: undefined,
    finalResult: undefined,
    serviceCalls,
  };

  return {
    [TX_RESULT_BRAND]: true as const,
    // Cast through unknown to avoid type incompatibility issues with generic constraints
    _internal: internal as unknown as TxResultInternal<
      AnySchema,
      unknown[],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any,
      readonly TxResult<unknown>[],
      unknown,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any,
      HooksMap
    >,
  };
}

/**
 * Options for executing transactions
 */
export interface ExecuteTxOptions {
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
   * Callback invoked after retrieval phase completes.
   * Use this to inspect retrieval operations and results (e.g., read tracking).
   */
  onAfterRetrieve?: (uow: IUnitOfWork, results: unknown[]) => void | Promise<void>;

  /**
   * Callback invoked before mutations are executed.
   * Use this to add additional mutation operations (e.g., hook event records).
   */
  onBeforeMutate?: (uow: IUnitOfWork) => void;

  /**
   * Callback invoked after successful mutation phase.
   * Use this for post-mutation processing like hook execution.
   */
  onAfterMutate?: (uow: IUnitOfWork) => Promise<void>;

  /**
   * Plan mode suppresses hook execution while still running serviceTx logic.
   */
  planMode?: boolean;
}

/**
 * Recursively collect all TxResults from a service call tree.
 * Returns them in a flat array in dependency order (serviceCalls before their dependents).
 * Skips undefined values (which can occur with optional service patterns like
 * optionalService?.method()).
 */
function collectAllTxResults(
  txResults: readonly (TxResult<unknown> | undefined)[],
): TxResult<unknown>[] {
  const collected: TxResult<unknown>[] = [];
  const seen = new Set<TxResult<unknown>>();

  function collect(txResult: TxResult<unknown> | undefined) {
    if (txResult === undefined) {
      return;
    }

    if (seen.has(txResult)) {
      return;
    }
    seen.add(txResult);

    // First collect serviceCalls (so they come before this TxResult)
    const serviceCalls = txResult._internal.serviceCalls;
    if (serviceCalls) {
      for (const serviceCall of serviceCalls) {
        collect(serviceCall);
      }
    }

    collected.push(txResult);
  }

  for (const txResult of txResults) {
    collect(txResult);
  }

  return collected;
}

/**
 * Execute a single TxResult's callbacks after retrieve phase completes.
 * This processes retrieveSuccess, mutate, and success callbacks in order.
 */
async function processTxResultAfterRetrieve<T>(
  txResult: TxResult<T>,
  baseUow: IUnitOfWork,
): Promise<void> {
  const internal = txResult._internal;
  const callbacks = internal.callbacks;

  // Wait for retrieve phase to complete
  const retrieveResults = await internal.retrievePhase;

  // Collect serviceCalls' retrieve success results (or mutate results if no retrieve was provided)
  // When a serviceCall has no retrieve/retrieveSuccess but has mutate, its mutate has already run
  // (due to service call execution order), so we use its mutate result as the "retrieve success result".
  const serviceResults: unknown[] = [];
  if (internal.serviceCalls) {
    for (const serviceCall of internal.serviceCalls) {
      if (serviceCall === undefined) {
        serviceResults.push(undefined);
        continue;
      }

      const serviceCallInternal = serviceCall._internal;
      // Check if this is a mutate-only service call (empty array sentinel with mutate callback)
      // In that case, prefer mutateResult over the empty array retrieveSuccessResult
      if (
        serviceCallInternal.retrieveSuccessResult !== undefined &&
        !(
          Array.isArray(serviceCallInternal.retrieveSuccessResult) &&
          serviceCallInternal.retrieveSuccessResult.length === 0 &&
          serviceCallInternal.callbacks.mutate
        )
      ) {
        serviceResults.push(serviceCallInternal.retrieveSuccessResult);
      } else if (serviceCallInternal.mutateResult !== undefined) {
        serviceResults.push(serviceCallInternal.mutateResult);
      } else {
        serviceResults.push(serviceCallInternal.retrieveSuccessResult);
      }
    }
  }

  if (callbacks.retrieveSuccess) {
    internal.retrieveSuccessResult = callbacks.retrieveSuccess(
      retrieveResults,
      serviceResults as ExtractServiceRetrieveResults<readonly TxResult<unknown>[]>,
    );
  } else {
    internal.retrieveSuccessResult = retrieveResults as typeof internal.retrieveSuccessResult;
  }

  if (callbacks.mutate) {
    const mutateCtx = {
      uow: internal.schema
        ? baseUow.forSchema(internal.schema)
        : (undefined as unknown as TypedUnitOfWork<AnySchema, [], unknown, HooksMap>),
      // At this point retrieveSuccessResult has been set (either by retrieveSuccess
      // callback or defaulted to retrieveResults)
      retrieveResult: internal.retrieveSuccessResult as NonNullable<
        typeof internal.retrieveSuccessResult
      >,
      serviceIntermediateResult: serviceResults as ExtractServiceRetrieveResults<
        readonly TxResult<unknown>[]
      >,
    };
    internal.mutateResult = callbacks.mutate(mutateCtx);
  }

  if (internal.typedUow) {
    internal.typedUow.signalReadyForMutation();
  } else {
    // For TxResults without retrieve callback, signal via the restricted UOW
    internal.restrictedUow.signalReadyForMutation();
  }
}

/**
 * Execute a single TxResult's success callback after mutations complete.
 */
async function processTxResultAfterMutate<T>(txResult: TxResult<T>): Promise<T> {
  const internal = txResult._internal;
  const callbacks = internal.callbacks;

  const serviceIntermediateResults: unknown[] = [];
  const serviceFinalResults: unknown[] = [];
  if (internal.serviceCalls) {
    for (const serviceCall of internal.serviceCalls) {
      if (serviceCall === undefined) {
        serviceIntermediateResults.push(undefined);
        serviceFinalResults.push(undefined);
        continue;
      }

      // Mirror the logic from processTxResultAfterRetrieve/executeTx:
      // For mutate-only serviceCalls (no retrieve phase, just mutations), use mutateResult instead of retrieveSuccessResult
      const serviceCallInternal = serviceCall._internal;
      // Check if this is a mutate-only service call (empty array sentinel with mutate callback)
      // In that case, prefer mutateResult over the empty array retrieveSuccessResult
      if (
        serviceCallInternal.retrieveSuccessResult !== undefined &&
        !(
          Array.isArray(serviceCallInternal.retrieveSuccessResult) &&
          serviceCallInternal.retrieveSuccessResult.length === 0 &&
          serviceCallInternal.callbacks.mutate
        )
      ) {
        serviceIntermediateResults.push(serviceCallInternal.retrieveSuccessResult);
      } else if (serviceCallInternal.mutateResult !== undefined) {
        serviceIntermediateResults.push(serviceCallInternal.mutateResult);
      } else {
        serviceIntermediateResults.push(serviceCallInternal.retrieveSuccessResult);
      }
      serviceFinalResults.push(serviceCallInternal.finalResult);
    }
  }

  if (callbacks.success) {
    const successCtx = {
      retrieveResult: internal.retrieveSuccessResult as NonNullable<
        typeof internal.retrieveSuccessResult
      >,
      mutateResult: internal.mutateResult,
      serviceResult: serviceFinalResults as ExtractServiceFinalResults<
        readonly TxResult<unknown>[]
      >,
      serviceIntermediateResult: serviceIntermediateResults as ExtractServiceRetrieveResults<
        readonly TxResult<unknown>[]
      >,
    };
    internal.finalResult = callbacks.success(successCtx) as T;
  } else if (callbacks.mutate) {
    internal.finalResult = (await awaitPromisesInObject(internal.mutateResult)) as T;
  } else if (callbacks.retrieveSuccess || callbacks.retrieve) {
    internal.finalResult = internal.retrieveSuccessResult as T;
  } else {
    internal.finalResult = serviceFinalResults as T;
  }

  return internal.finalResult as T;
}

/**
 * Execute a transaction with the unified TxResult pattern.
 *
 * This is the handler-level function that actually executes TxResults with retry support.
 *
 * @param callbacks - Transaction callbacks (serviceCalls, retrieve, retrieveSuccess, mutate, success)
 * @param options - Configuration including UOW factory, retry policy, and abort signal
 * @returns Promise resolving to the result determined by return type priority
 *
 * @example
 * ```ts
 * // Simple retrieve + transform
 * const user = await executeTx({
 *   retrieve: (ctx) => ctx.forSchema(usersSchema).find("users", ...),
 *   retrieveSuccess: ([users]) => users[0] ?? null,
 * }, { createUnitOfWork });
 * @internal Used by HandlerTxBuilder.execute()
 */
async function executeTx(
  callbacks: HandlerTxCallbacks<
    unknown[],
    unknown,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly (TxResult<any, any> | undefined)[],
    unknown,
    unknown,
    HooksMap
  >,
  options: ExecuteTxOptions,
): Promise<unknown> {
  type TRetrieveResults = unknown[];
  type TRetrieveSuccessResult = unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type TServiceCalls = readonly (TxResult<any, any> | undefined)[];
  type TMutateResult = unknown;
  type THooks = HooksMap;
  const signal = options.signal;
  let attempt = 0;

  while (true) {
    // Check if aborted before starting attempt
    if (signal?.aborted) {
      throw new Error("Transaction execution aborted");
    }

    let retryPolicy: RetryPolicy | undefined;

    try {
      // Create a fresh UOW for this attempt
      const baseUow = options.createUnitOfWork();
      if (options.onAfterRetrieve) {
        const readTrackingUow = baseUow as { enableReadTracking?: () => void };
        readTrackingUow.enableReadTracking?.();
      }

      // Create handler context
      const context: HandlerTxContext<THooks> = {
        forSchema: <S extends AnySchema, H extends HooksMap = THooks>(schema: S, hooks?: H) => {
          return baseUow.forSchema(schema, hooks);
        },
        idempotencyKey: baseUow.idempotencyKey,
        currentAttempt: attempt,
      };

      // Call serviceCalls factory if provided - this creates TxResults that schedule operations
      let serviceCalls: TServiceCalls | undefined;
      if (callbacks.serviceCalls) {
        serviceCalls = callbacks.serviceCalls();
      }

      // Call retrieve callback - it returns a TypedUnitOfWork with scheduled operations or void
      const typedUowFromRetrieve = callbacks.retrieve?.(context);

      const allServiceCallTxResults = serviceCalls ? collectAllTxResults([...serviceCalls]) : [];

      const hasRetrieveOps = baseUow.getRetrievalOperations().length > 0;
      if (!hasRetrieveOps) {
        if (options.retryPolicy) {
          throw new Error(
            "Retry policy is only supported when the transaction includes retrieve operations.",
          );
        }
        retryPolicy = new NoRetryPolicy();
      } else {
        retryPolicy =
          options.retryPolicy ??
          new ExponentialBackoffRetryPolicy({
            maxRetries: 5,
            initialDelayMs: 10,
            maxDelayMs: 100,
          });
      }

      const allRetrieveResults = await baseUow.executeRetrieve();
      if (options.onAfterRetrieve) {
        await options.onAfterRetrieve(baseUow, allRetrieveResults);
      }

      // Get retrieve results from TypedUnitOfWork's retrievalPhase or default to empty array
      const retrieveResult: TRetrieveResults = typedUowFromRetrieve
        ? await typedUowFromRetrieve.retrievalPhase
        : ([] as unknown as TRetrieveResults);

      for (const txResult of allServiceCallTxResults) {
        await processTxResultAfterRetrieve(txResult, baseUow);
      }

      const serviceResults: unknown[] = [];
      if (serviceCalls) {
        for (const serviceCall of serviceCalls) {
          if (serviceCall === undefined) {
            serviceResults.push(undefined);
            continue;
          }
          const serviceCallInternal = serviceCall._internal;
          // Check if this is a mutate-only service call (empty array sentinel with mutate callback)
          // In that case, prefer mutateResult over the empty array retrieveSuccessResult
          if (
            serviceCallInternal.retrieveSuccessResult !== undefined &&
            !(
              Array.isArray(serviceCallInternal.retrieveSuccessResult) &&
              serviceCallInternal.retrieveSuccessResult.length === 0 &&
              serviceCallInternal.callbacks.mutate
            )
          ) {
            serviceResults.push(serviceCallInternal.retrieveSuccessResult);
          } else if (serviceCallInternal.mutateResult !== undefined) {
            serviceResults.push(serviceCallInternal.mutateResult);
          } else {
            serviceResults.push(serviceCallInternal.retrieveSuccessResult);
          }
        }
      }

      // Call retrieveSuccess if provided
      let retrieveSuccessResult: TRetrieveSuccessResult;
      if (callbacks.retrieveSuccess) {
        retrieveSuccessResult = callbacks.retrieveSuccess(
          retrieveResult,
          serviceResults as ExtractServiceRetrieveResults<TServiceCalls>,
        );
      } else {
        retrieveSuccessResult = retrieveResult as unknown as TRetrieveSuccessResult;
      }

      let mutateResult: TMutateResult | undefined;
      if (callbacks.mutate) {
        const mutateCtx: HandlerTxMutateContext<
          TRetrieveSuccessResult,
          ExtractServiceRetrieveResults<TServiceCalls>,
          THooks
        > = {
          ...context,
          retrieveResult: retrieveSuccessResult,
          serviceIntermediateResult: serviceResults as ExtractServiceRetrieveResults<TServiceCalls>,
        };
        mutateResult = callbacks.mutate(mutateCtx);
      }

      if (!options.planMode && options.onBeforeMutate) {
        options.onBeforeMutate(baseUow);
      }
      const result = await baseUow.executeMutations();
      if (!result.success) {
        throw new ConcurrencyConflictError();
      }

      // Process each serviceCall TxResult's success callback
      for (const txResult of allServiceCallTxResults) {
        await processTxResultAfterMutate(txResult);
      }

      const serviceFinalResults: unknown[] = [];
      if (serviceCalls) {
        for (const serviceCall of serviceCalls) {
          if (serviceCall === undefined) {
            serviceFinalResults.push(undefined);
            continue;
          }
          serviceFinalResults.push(serviceCall._internal.finalResult);
        }
      }

      let finalResult: unknown;
      if (callbacks.success) {
        // The success context type is determined by the overload - we construct it at runtime
        // and the type safety is guaranteed by the discriminated overloads
        const successCtx = {
          retrieveResult: retrieveSuccessResult,
          mutateResult,
          serviceResult: serviceFinalResults as ExtractServiceFinalResults<TServiceCalls>,
          serviceIntermediateResult: serviceResults as ExtractServiceRetrieveResults<TServiceCalls>,
        } as Parameters<NonNullable<typeof callbacks.success>>[0];
        finalResult = callbacks.success(successCtx);
      } else if (callbacks.mutate) {
        finalResult = await awaitPromisesInObject(mutateResult);
      } else if (callbacks.retrieveSuccess || callbacks.retrieve) {
        finalResult = retrieveSuccessResult;
      } else {
        finalResult = serviceFinalResults;
      }

      if (!options.planMode && options.onAfterMutate) {
        await options.onAfterMutate(baseUow);
      }

      return await awaitPromisesInObject(finalResult);
    } catch (error) {
      if (signal?.aborted) {
        throw new Error("Transaction execution aborted");
      }

      // Only retry concurrency conflicts, not other errors
      if (!(error instanceof ConcurrencyConflictError)) {
        throw error;
      }

      if (!retryPolicy) {
        throw error;
      }

      if (!retryPolicy.shouldRetry(attempt, error, signal)) {
        if (signal?.aborted) {
          throw new Error("Transaction execution aborted");
        }
        throw new ConcurrencyConflictError();
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
 * Error thrown when a Unit of Work execution fails due to optimistic concurrency conflict.
 * This error triggers automatic retry behavior in executeTx.
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

  if (obj.constructor !== Object) {
    return obj as AwaitedPromisesInObject<T>;
  }
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

// ============================================================================
// Builder Pattern Types and Classes
// ============================================================================

/**
 * Context passed to service-level mutate callback in builder pattern.
 */
export interface ServiceBuilderMutateContext<
  TSchema extends AnySchema,
  TRetrieveSuccessResult,
  TServiceResult extends readonly unknown[],
  THooks extends HooksMap,
> {
  /** Unit of work for scheduling mutations */
  uow: TypedUnitOfWork<TSchema, [], unknown, THooks>;
  /** Result from transformRetrieve callback (or raw retrieve results if no transformRetrieve) */
  retrieveResult: TRetrieveSuccessResult;
  /** Array of retrieve success results from service calls (intermediate results, not final: retrieve results if service has retrieve, mutate result if service only mutates) */
  serviceIntermediateResult: TServiceResult;
}

/**
 * Context passed to handler-level mutate callback in builder pattern.
 */
export interface HandlerBuilderMutateContext<
  TRetrieveSuccessResult,
  TServiceResult extends readonly unknown[],
  THooks extends HooksMap,
> {
  /** Get a typed Unit of Work for the given schema */
  forSchema: <S extends AnySchema, H extends HooksMap = THooks>(
    schema: S,
    hooks?: H,
  ) => TypedUnitOfWork<S, [], unknown, H>;
  /** Unique key for this transaction (for idempotency/deduplication) */
  idempotencyKey: string;
  /** Current attempt number (0-based) */
  currentAttempt: number;
  /** Result from transformRetrieve callback (or raw retrieve results if no transformRetrieve) */
  retrieveResult: TRetrieveSuccessResult;
  /** Array of retrieve success results from service calls (intermediate results, not final: retrieve results if service has retrieve, mutate result if service only mutates) */
  serviceIntermediateResult: TServiceResult;
}

/**
 * Context passed to transform callback when mutate IS provided.
 */
export interface BuilderTransformContextWithMutate<
  TRetrieveSuccessResult,
  TMutateResult,
  TServiceFinalResult extends readonly unknown[],
  TServiceIntermediateResult extends readonly unknown[],
> {
  /** Result from transformRetrieve callback (or raw retrieve results if no transformRetrieve) */
  retrieveResult: TRetrieveSuccessResult;
  /** Result from mutate callback */
  mutateResult: TMutateResult;
  /** Array of final results from service calls (after success/transform callbacks) */
  serviceResult: TServiceFinalResult;
  /** Array of retrieve success results from service calls (same as what mutate receives: retrieve results if service has retrieve, mutate result if service only mutates) */
  serviceIntermediateResult: TServiceIntermediateResult;
}

/**
 * Context passed to transform callback when mutate is NOT provided.
 */
export interface BuilderTransformContextWithoutMutate<
  TRetrieveSuccessResult,
  TServiceFinalResult extends readonly unknown[],
  TServiceIntermediateResult extends readonly unknown[],
> {
  /** Result from transformRetrieve callback (or raw retrieve results if no transformRetrieve) */
  retrieveResult: TRetrieveSuccessResult;
  /** No mutate callback was provided */
  mutateResult: undefined;
  /** Array of final results from service calls (after success/transform callbacks) */
  serviceResult: TServiceFinalResult;
  /** Array of retrieve success results from service calls (same as what mutate receives: retrieve results if service has retrieve, mutate result if service only mutates) */
  serviceIntermediateResult: TServiceIntermediateResult;
}

/**
 * Infer the final result type from builder state:
 * 1. transform → TTransformResult
 * 2. mutate → AwaitedPromisesInObject<TMutateResult>
 * 3. transformRetrieve → TRetrieveSuccessResult
 * 4. retrieve → TRetrieveResults
 * 5. withServiceCalls → ExtractServiceFinalResults<TServiceCalls>
 */
export type InferBuilderResultType<
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TServiceCalls extends readonly (TxResult<any, any> | undefined)[],
  TMutateResult,
  TTransformResult,
  HasTransform extends boolean,
  HasMutate extends boolean,
  HasTransformRetrieve extends boolean,
  HasRetrieve extends boolean,
> = HasTransform extends true
  ? TTransformResult
  : HasMutate extends true
    ? AwaitedPromisesInObject<TMutateResult>
    : HasTransformRetrieve extends true
      ? TRetrieveSuccessResult
      : HasRetrieve extends true
        ? TRetrieveResults
        : ExtractServiceFinalResults<TServiceCalls>;

/**
 * Infer the retrieve success result type for the builder:
 * - If transformRetrieve exists: TRetrieveSuccessResult
 * - Else if retrieve exists: TRetrieveResults (raw retrieve results)
 * - Else if mutate exists: AwaitedPromisesInObject<TMutateResult>
 *   (mutate result becomes retrieve result for dependents)
 * - Else: TRetrieveResults (raw retrieve results, typically [])
 */
export type InferBuilderRetrieveSuccessResult<
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  TMutateResult,
  HasTransformRetrieve extends boolean,
  HasRetrieve extends boolean,
  HasMutate extends boolean,
> = HasTransformRetrieve extends true
  ? TRetrieveSuccessResult
  : HasRetrieve extends true
    ? TRetrieveResults
    : HasMutate extends true
      ? AwaitedPromisesInObject<TMutateResult>
      : TRetrieveResults;

/**
 * Internal state for ServiceTxBuilder
 */
interface ServiceTxBuilderState<
  TSchema extends AnySchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TServiceCalls extends readonly (TxResult<any, any> | undefined)[],
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  TMutateResult,
  TTransformResult,
  THooks extends HooksMap,
> {
  schema: TSchema;
  baseUow: IUnitOfWork;
  hooks?: THooks;
  withServiceCallsFn?: () => TServiceCalls;
  retrieveFn?: (
    uow: TypedUnitOfWork<TSchema, [], unknown, THooks>,
  ) => TypedUnitOfWork<TSchema, TRetrieveResults, unknown, THooks>;
  transformRetrieveFn?: (
    retrieveResult: TRetrieveResults,
    serviceRetrieveResult: ExtractServiceRetrieveResults<TServiceCalls>,
  ) => TRetrieveSuccessResult;
  mutateFn?: (
    ctx: ServiceBuilderMutateContext<
      TSchema,
      TRetrieveSuccessResult,
      ExtractServiceRetrieveResults<TServiceCalls>,
      THooks
    >,
  ) => TMutateResult;
  transformFn?: (
    ctx:
      | BuilderTransformContextWithMutate<
          TRetrieveSuccessResult,
          TMutateResult,
          ExtractServiceFinalResults<TServiceCalls>,
          ExtractServiceRetrieveResults<TServiceCalls>
        >
      | BuilderTransformContextWithoutMutate<
          TRetrieveSuccessResult,
          ExtractServiceFinalResults<TServiceCalls>,
          ExtractServiceRetrieveResults<TServiceCalls>
        >,
  ) => TTransformResult;
}

/**
 * Builder for service-level transactions.
 * Uses a fluent API to build up transaction callbacks with proper type inference.
 *
 * @example
 * ```ts
 * return serviceTx(schema)
 *   .withServiceCalls(() => [otherService.getData()])
 *   .retrieve((uow) => uow.find("users", ...))
 *   .transformRetrieve(([users], serviceResult) => users[0])
 *   .mutate(({ uow, retrieveResult, serviceIntermediateResult }) =>
 *     uow.create("records", { ... })
 *   )
 *   .transform(({ mutateResult, serviceResult, serviceIntermediateResult }) => ({ id: mutateResult }))
 *   .build();
 * ```
 */
export class ServiceTxBuilder<
  TSchema extends AnySchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TServiceCalls extends readonly (TxResult<any, any> | undefined)[],
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  TMutateResult,
  TTransformResult,
  HasRetrieve extends boolean,
  HasTransformRetrieve extends boolean,
  HasMutate extends boolean,
  HasTransform extends boolean,
  THooks extends HooksMap,
> {
  readonly #state: ServiceTxBuilderState<
    TSchema,
    TServiceCalls,
    TRetrieveResults,
    TRetrieveSuccessResult,
    TMutateResult,
    TTransformResult,
    THooks
  >;

  constructor(
    state: ServiceTxBuilderState<
      TSchema,
      TServiceCalls,
      TRetrieveResults,
      TRetrieveSuccessResult,
      TMutateResult,
      TTransformResult,
      THooks
    >,
  ) {
    this.#state = state;
  }

  /**
   * Add dependencies to execute before this transaction.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withServiceCalls<TNewDeps extends readonly (TxResult<any, any> | undefined)[]>(
    fn: () => TNewDeps,
  ): ServiceTxBuilder<
    TSchema,
    TNewDeps,
    TRetrieveResults,
    TRetrieveSuccessResult,
    TMutateResult,
    TTransformResult,
    HasRetrieve,
    HasTransformRetrieve,
    HasMutate,
    HasTransform,
    THooks
  > {
    return new ServiceTxBuilder({
      ...this.#state,
      withServiceCallsFn: fn,
    } as ServiceTxBuilderState<
      TSchema,
      TNewDeps,
      TRetrieveResults,
      TRetrieveSuccessResult,
      TMutateResult,
      TTransformResult,
      THooks
    >);
  }

  /**
   * Add retrieval operations to the transaction.
   */
  retrieve<TNewRetrieveResults extends unknown[]>(
    fn: (
      uow: TypedUnitOfWork<TSchema, [], unknown, THooks>,
    ) => TypedUnitOfWork<TSchema, TNewRetrieveResults, unknown, THooks>,
  ): ServiceTxBuilder<
    TSchema,
    TServiceCalls,
    TNewRetrieveResults,
    TNewRetrieveResults, // Default TRetrieveSuccessResult to TNewRetrieveResults
    TMutateResult,
    TTransformResult,
    true, // HasRetrieve = true
    false, // Reset HasTransformRetrieve since retrieve results changed
    HasMutate,
    HasTransform,
    THooks
  > {
    return new ServiceTxBuilder({
      ...this.#state,
      retrieveFn: fn,
      transformRetrieveFn: undefined, // Clear any existing transformRetrieve since results shape changed
    } as unknown as ServiceTxBuilderState<
      TSchema,
      TServiceCalls,
      TNewRetrieveResults,
      TNewRetrieveResults,
      TMutateResult,
      TTransformResult,
      THooks
    >);
  }

  /**
   * Transform retrieve results before passing to mutate.
   */
  transformRetrieve<TNewRetrieveSuccessResult>(
    fn: (
      retrieveResult: TRetrieveResults,
      serviceResult: ExtractServiceRetrieveResults<TServiceCalls>,
    ) => TNewRetrieveSuccessResult,
  ): ServiceTxBuilder<
    TSchema,
    TServiceCalls,
    TRetrieveResults,
    TNewRetrieveSuccessResult,
    TMutateResult,
    TTransformResult,
    HasRetrieve,
    true, // HasTransformRetrieve = true
    HasMutate,
    HasTransform,
    THooks
  > {
    return new ServiceTxBuilder({
      ...this.#state,
      transformRetrieveFn: fn,
    } as unknown as ServiceTxBuilderState<
      TSchema,
      TServiceCalls,
      TRetrieveResults,
      TNewRetrieveSuccessResult,
      TMutateResult,
      TTransformResult,
      THooks
    >);
  }

  /**
   * Add mutation operations based on retrieve results.
   */
  mutate<TNewMutateResult>(
    fn: (
      ctx: ServiceBuilderMutateContext<
        TSchema,
        HasTransformRetrieve extends true ? TRetrieveSuccessResult : TRetrieveResults,
        ExtractServiceRetrieveResults<TServiceCalls>,
        THooks
      >,
    ) => TNewMutateResult,
  ): ServiceTxBuilder<
    TSchema,
    TServiceCalls,
    TRetrieveResults,
    HasTransformRetrieve extends true ? TRetrieveSuccessResult : TRetrieveResults,
    TNewMutateResult,
    TTransformResult,
    HasRetrieve,
    HasTransformRetrieve,
    true, // HasMutate = true
    HasTransform,
    THooks
  > {
    return new ServiceTxBuilder({
      ...this.#state,
      mutateFn: fn,
    } as unknown as ServiceTxBuilderState<
      TSchema,
      TServiceCalls,
      TRetrieveResults,
      HasTransformRetrieve extends true ? TRetrieveSuccessResult : TRetrieveResults,
      TNewMutateResult,
      TTransformResult,
      THooks
    >);
  }

  /**
   * Add final transformation after mutations complete.
   */
  transform<TNewTransformResult>(
    fn: (
      ctx: HasMutate extends true
        ? BuilderTransformContextWithMutate<
            HasTransformRetrieve extends true ? TRetrieveSuccessResult : TRetrieveResults,
            TMutateResult,
            ExtractServiceFinalResults<TServiceCalls>,
            ExtractServiceRetrieveResults<TServiceCalls>
          >
        : BuilderTransformContextWithoutMutate<
            HasTransformRetrieve extends true ? TRetrieveSuccessResult : TRetrieveResults,
            ExtractServiceFinalResults<TServiceCalls>,
            ExtractServiceRetrieveResults<TServiceCalls>
          >,
    ) => TNewTransformResult,
  ): ServiceTxBuilder<
    TSchema,
    TServiceCalls,
    TRetrieveResults,
    HasTransformRetrieve extends true ? TRetrieveSuccessResult : TRetrieveResults,
    TMutateResult,
    TNewTransformResult,
    HasRetrieve,
    HasTransformRetrieve,
    HasMutate,
    true, // HasTransform = true
    THooks
  > {
    return new ServiceTxBuilder({
      ...this.#state,
      transformFn: fn,
    } as unknown as ServiceTxBuilderState<
      TSchema,
      TServiceCalls,
      TRetrieveResults,
      HasTransformRetrieve extends true ? TRetrieveSuccessResult : TRetrieveResults,
      TMutateResult,
      TNewTransformResult,
      THooks
    >);
  }

  /**
   * Build and return the TxResult.
   */
  build(): TxResult<
    InferBuilderResultType<
      TRetrieveResults,
      TRetrieveSuccessResult,
      TServiceCalls,
      TMutateResult,
      TTransformResult,
      HasTransform,
      HasMutate,
      HasTransformRetrieve,
      HasRetrieve
    >,
    InferBuilderRetrieveSuccessResult<
      TRetrieveResults,
      TRetrieveSuccessResult,
      TMutateResult,
      HasTransformRetrieve,
      HasRetrieve,
      HasMutate
    >
  > {
    const state = this.#state;

    // Convert builder state to legacy callbacks format
    const callbacks: ServiceTxCallbacks<
      TSchema,
      TRetrieveResults,
      TRetrieveSuccessResult,
      TServiceCalls,
      TMutateResult,
      TTransformResult,
      THooks
    > = {
      serviceCalls: state.withServiceCallsFn,
      retrieve: state.retrieveFn,
      retrieveSuccess: state.transformRetrieveFn,
      mutate: state.mutateFn
        ? (ctx) => {
            return state.mutateFn!({
              uow: ctx.uow,
              retrieveResult: ctx.retrieveResult,
              serviceIntermediateResult: ctx.serviceIntermediateResult,
            });
          }
        : undefined,
      success: state.transformFn
        ? (ctx) => {
            return state.transformFn!({
              retrieveResult: ctx.retrieveResult,
              mutateResult: ctx.mutateResult,
              serviceResult: ctx.serviceResult,
              serviceIntermediateResult: ctx.serviceIntermediateResult,
            } as BuilderTransformContextWithMutate<
              TRetrieveSuccessResult,
              TMutateResult,
              ExtractServiceFinalResults<TServiceCalls>,
              ExtractServiceRetrieveResults<TServiceCalls>
            >);
          }
        : undefined,
    };

    // Use the existing createServiceTx implementation
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return createServiceTx(state.schema, callbacks as any, state.baseUow) as unknown as TxResult<
      InferBuilderResultType<
        TRetrieveResults,
        TRetrieveSuccessResult,
        TServiceCalls,
        TMutateResult,
        TTransformResult,
        HasTransform,
        HasMutate,
        HasTransformRetrieve,
        HasRetrieve
      >,
      InferBuilderRetrieveSuccessResult<
        TRetrieveResults,
        TRetrieveSuccessResult,
        TMutateResult,
        HasTransformRetrieve,
        HasRetrieve,
        HasMutate
      >
    >;
  }
}

/**
 * Create a new ServiceTxBuilder for the given schema.
 */
export function createServiceTxBuilder<TSchema extends AnySchema, THooks extends HooksMap = {}>(
  schema: TSchema,
  baseUow: IUnitOfWork,
  hooks?: THooks,
): ServiceTxBuilder<
  TSchema,
  readonly [],
  [],
  [],
  unknown,
  unknown,
  false,
  false,
  false,
  false,
  THooks
> {
  return new ServiceTxBuilder({
    schema,
    baseUow,
    hooks,
  });
}

/**
 * Internal state for HandlerTxBuilder
 */
interface HandlerTxBuilderState<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TServiceCalls extends readonly (TxResult<any, any> | undefined)[],
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  TMutateResult,
  TTransformResult,
  THooks extends HooksMap,
> {
  options: ExecuteTxOptions;
  hooks?: THooks;
  withServiceCallsFn?: () => TServiceCalls;
  retrieveFn?: (context: {
    forSchema: <S extends AnySchema, H extends HooksMap = THooks>(
      schema: S,
      hooks?: H,
    ) => TypedUnitOfWork<S, [], unknown, H>;
    idempotencyKey: string;
    currentAttempt: number;
  }) => TypedUnitOfWork<AnySchema, TRetrieveResults, unknown, HooksMap> | void;
  transformRetrieveFn?: (
    retrieveResult: TRetrieveResults,
    serviceResult: ExtractServiceRetrieveResults<TServiceCalls>,
  ) => TRetrieveSuccessResult;
  mutateFn?: (
    ctx: HandlerBuilderMutateContext<
      TRetrieveSuccessResult,
      ExtractServiceRetrieveResults<TServiceCalls>,
      THooks
    >,
  ) => TMutateResult;
  transformFn?: (
    ctx:
      | BuilderTransformContextWithMutate<
          TRetrieveSuccessResult,
          TMutateResult,
          ExtractServiceFinalResults<TServiceCalls>,
          ExtractServiceRetrieveResults<TServiceCalls>
        >
      | BuilderTransformContextWithoutMutate<
          TRetrieveSuccessResult,
          ExtractServiceFinalResults<TServiceCalls>,
          ExtractServiceRetrieveResults<TServiceCalls>
        >,
  ) => TTransformResult;
}

/**
 * Builder for handler-level transactions.
 * Uses a fluent API to build up transaction callbacks with proper type inference.
 *
 * @example
 * ```ts
 * const result = await handlerTx()
 *   .withServiceCalls(() => [userService.getUser(id)])
 *   .mutate(({ forSchema, idempotencyKey, currentAttempt, serviceIntermediateResult }) => {
 *     return forSchema(ordersSchema).create("orders", { ... });
 *   })
 *   .transform(({ mutateResult, serviceResult }) => ({ ... }))
 *   .execute();
 * ```
 */
export class HandlerTxBuilder<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TServiceCalls extends readonly (TxResult<any, any> | undefined)[],
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  TMutateResult,
  TTransformResult,
  HasRetrieve extends boolean,
  HasTransformRetrieve extends boolean,
  HasMutate extends boolean,
  HasTransform extends boolean,
  THooks extends HooksMap,
> {
  readonly #state: HandlerTxBuilderState<
    TServiceCalls,
    TRetrieveResults,
    TRetrieveSuccessResult,
    TMutateResult,
    TTransformResult,
    THooks
  >;

  constructor(
    state: HandlerTxBuilderState<
      TServiceCalls,
      TRetrieveResults,
      TRetrieveSuccessResult,
      TMutateResult,
      TTransformResult,
      THooks
    >,
  ) {
    this.#state = state;
  }

  /**
   * Add dependencies to execute before this transaction.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withServiceCalls<TNewDeps extends readonly (TxResult<any, any> | undefined)[]>(
    fn: () => TNewDeps,
  ): HandlerTxBuilder<
    TNewDeps,
    TRetrieveResults,
    TRetrieveSuccessResult,
    TMutateResult,
    TTransformResult,
    HasRetrieve,
    HasTransformRetrieve,
    HasMutate,
    HasTransform,
    THooks
  > {
    return new HandlerTxBuilder({
      ...this.#state,
      withServiceCallsFn: fn,
    } as HandlerTxBuilderState<
      TNewDeps,
      TRetrieveResults,
      TRetrieveSuccessResult,
      TMutateResult,
      TTransformResult,
      THooks
    >);
  }

  /**
   * Add retrieval operations to the transaction.
   * Return a TypedUnitOfWork from forSchema().find() to get typed results.
   */
  retrieve<TNewRetrieveResults extends unknown[]>(
    fn: (context: {
      forSchema: <S extends AnySchema, H extends HooksMap = THooks>(
        schema: S,
        hooks?: H,
      ) => TypedUnitOfWork<S, [], unknown, H>;
      idempotencyKey: string;
      currentAttempt: number;
    }) => TypedUnitOfWork<AnySchema, TNewRetrieveResults, unknown, HooksMap> | void,
  ): HandlerTxBuilder<
    TServiceCalls,
    TNewRetrieveResults,
    TNewRetrieveResults, // Default TRetrieveSuccessResult to TNewRetrieveResults
    TMutateResult,
    TTransformResult,
    true, // HasRetrieve = true
    false, // Reset HasTransformRetrieve since retrieve results changed
    HasMutate,
    HasTransform,
    THooks
  > {
    return new HandlerTxBuilder({
      ...this.#state,
      retrieveFn: fn,
      transformRetrieveFn: undefined, // Clear any existing transformRetrieve since results shape changed
    } as unknown as HandlerTxBuilderState<
      TServiceCalls,
      TNewRetrieveResults,
      TNewRetrieveResults,
      TMutateResult,
      TTransformResult,
      THooks
    >);
  }

  /**
   * Transform retrieve results before passing to mutate.
   */
  transformRetrieve<TNewRetrieveSuccessResult>(
    fn: (
      retrieveResult: TRetrieveResults,
      serviceResult: ExtractServiceRetrieveResults<TServiceCalls>,
    ) => TNewRetrieveSuccessResult,
  ): HandlerTxBuilder<
    TServiceCalls,
    TRetrieveResults,
    TNewRetrieveSuccessResult,
    TMutateResult,
    TTransformResult,
    HasRetrieve,
    true, // HasTransformRetrieve = true
    HasMutate,
    HasTransform,
    THooks
  > {
    return new HandlerTxBuilder({
      ...this.#state,
      transformRetrieveFn: fn,
    } as unknown as HandlerTxBuilderState<
      TServiceCalls,
      TRetrieveResults,
      TNewRetrieveSuccessResult,
      TMutateResult,
      TTransformResult,
      THooks
    >);
  }

  /**
   * Add mutation operations based on retrieve results.
   */
  mutate<TNewMutateResult>(
    fn: (
      ctx: HandlerBuilderMutateContext<
        HasTransformRetrieve extends true ? TRetrieveSuccessResult : TRetrieveResults,
        ExtractServiceRetrieveResults<TServiceCalls>,
        THooks
      >,
    ) => TNewMutateResult,
  ): HandlerTxBuilder<
    TServiceCalls,
    TRetrieveResults,
    HasTransformRetrieve extends true ? TRetrieveSuccessResult : TRetrieveResults,
    TNewMutateResult,
    TTransformResult,
    HasRetrieve,
    HasTransformRetrieve,
    true, // HasMutate = true
    HasTransform,
    THooks
  > {
    return new HandlerTxBuilder({
      ...this.#state,
      mutateFn: fn,
    } as unknown as HandlerTxBuilderState<
      TServiceCalls,
      TRetrieveResults,
      HasTransformRetrieve extends true ? TRetrieveSuccessResult : TRetrieveResults,
      TNewMutateResult,
      TTransformResult,
      THooks
    >);
  }

  /**
   * Add final transformation after mutations complete.
   */
  transform<TNewTransformResult>(
    fn: (
      ctx: HasMutate extends true
        ? BuilderTransformContextWithMutate<
            HasTransformRetrieve extends true ? TRetrieveSuccessResult : TRetrieveResults,
            TMutateResult,
            ExtractServiceFinalResults<TServiceCalls>,
            ExtractServiceRetrieveResults<TServiceCalls>
          >
        : BuilderTransformContextWithoutMutate<
            HasTransformRetrieve extends true ? TRetrieveSuccessResult : TRetrieveResults,
            ExtractServiceFinalResults<TServiceCalls>,
            ExtractServiceRetrieveResults<TServiceCalls>
          >,
    ) => TNewTransformResult,
  ): HandlerTxBuilder<
    TServiceCalls,
    TRetrieveResults,
    HasTransformRetrieve extends true ? TRetrieveSuccessResult : TRetrieveResults,
    TMutateResult,
    TNewTransformResult,
    HasRetrieve,
    HasTransformRetrieve,
    HasMutate,
    true, // HasTransform = true
    THooks
  > {
    return new HandlerTxBuilder({
      ...this.#state,
      transformFn: fn,
    } as unknown as HandlerTxBuilderState<
      TServiceCalls,
      TRetrieveResults,
      HasTransformRetrieve extends true ? TRetrieveSuccessResult : TRetrieveResults,
      TMutateResult,
      TNewTransformResult,
      THooks
    >);
  }

  /**
   * Execute the transaction and return the result.
   */
  execute(): Promise<
    AwaitedPromisesInObject<
      InferBuilderResultType<
        TRetrieveResults,
        TRetrieveSuccessResult,
        TServiceCalls,
        TMutateResult,
        TTransformResult,
        HasTransform,
        HasMutate,
        HasTransformRetrieve,
        HasRetrieve
      >
    >
  > {
    const state = this.#state;

    // Convert builder state to legacy callbacks format
    const callbacks: HandlerTxCallbacks<
      TRetrieveResults,
      TRetrieveSuccessResult,
      TServiceCalls,
      TMutateResult,
      TTransformResult,
      THooks
    > = {
      serviceCalls: state.withServiceCallsFn,
      retrieve: state.retrieveFn
        ? (context) => {
            return state.retrieveFn!({
              forSchema: context.forSchema,
              idempotencyKey: context.idempotencyKey,
              currentAttempt: context.currentAttempt,
            });
          }
        : undefined,
      retrieveSuccess: state.transformRetrieveFn,
      mutate: state.mutateFn
        ? (ctx) => {
            return state.mutateFn!({
              forSchema: ctx.forSchema,
              idempotencyKey: ctx.idempotencyKey,
              currentAttempt: ctx.currentAttempt,
              retrieveResult: ctx.retrieveResult,
              serviceIntermediateResult: ctx.serviceIntermediateResult,
            });
          }
        : undefined,
      success: state.transformFn
        ? (ctx) => {
            return state.transformFn!({
              retrieveResult: ctx.retrieveResult,
              mutateResult: ctx.mutateResult,
              serviceResult: ctx.serviceResult,
              serviceIntermediateResult: ctx.serviceIntermediateResult,
            } as BuilderTransformContextWithMutate<
              TRetrieveSuccessResult,
              TMutateResult,
              ExtractServiceFinalResults<TServiceCalls>,
              ExtractServiceRetrieveResults<TServiceCalls>
            >);
          }
        : undefined,
    };

    // Use the existing executeTx implementation
    return executeTx(callbacks as Parameters<typeof executeTx>[0], state.options) as Promise<
      AwaitedPromisesInObject<
        InferBuilderResultType<
          TRetrieveResults,
          TRetrieveSuccessResult,
          TServiceCalls,
          TMutateResult,
          TTransformResult,
          HasTransform,
          HasMutate,
          HasTransformRetrieve,
          HasRetrieve
        >
      >
    >;
  }
}

/**
 * Create a new HandlerTxBuilder with the given options.
 */
export function createHandlerTxBuilder<THooks extends HooksMap = {}>(
  options: ExecuteTxOptions,
  hooks?: THooks,
): HandlerTxBuilder<readonly [], [], [], unknown, unknown, false, false, false, false, THooks> {
  return new HandlerTxBuilder({
    options,
    hooks,
  });
}
