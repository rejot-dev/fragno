import type { AnySchema } from "../../schema/create";
import type { TypedUnitOfWork, IUnitOfWork } from "./unit-of-work";
import type { HooksMap } from "../../hooks/hooks";
import { NoRetryPolicy, ExponentialBackoffRetryPolicy, type RetryPolicy } from "./retry-policy";
import type { FragnoId } from "../../schema/create";

// =============================================================================
// NEW UNIFIED TX API - TxResult and TxCallbacks
// =============================================================================

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
 * Map over deps array to extract retrieve success results from each dep.
 * Preserves tuple structure while extracting the retrieve success result type from each element.
 */
export type ExtractDepsRetrieveSuccessResults<T extends readonly unknown[]> = {
  [K in keyof T]: ExtractTxRetrieveSuccessResult<T[K]>;
};

/**
 * Map over deps array to extract final results from each dep.
 * Preserves tuple structure while extracting the final result type from each element.
 */
export type ExtractDepsFinalResults<T extends readonly unknown[]> = {
  [K in keyof T]: ExtractTxFinalResult<T[K]>;
};

/**
 * Context passed to mutate callback for service methods
 */
export interface ServiceTxMutateContext<
  TSchema extends AnySchema,
  TRetrieveSuccessResult,
  TDepsRetrieveSuccessResults extends readonly unknown[],
  THooks extends HooksMap,
> {
  /** Unit of work for scheduling mutations */
  uow: TypedUnitOfWork<TSchema, [], unknown, THooks>;
  /** Result from retrieveSuccess callback (or raw retrieve results if no retrieveSuccess) */
  retrieveResult: TRetrieveSuccessResult;
  /** Array of retrieve success results from dependencies */
  depsRetrieveResult: TDepsRetrieveSuccessResults;
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
  /** Nonce for the current transaction attempt */
  nonce: string;
  /** Current attempt number (0-based) */
  currentAttempt: number;
}

/**
 * Context passed to handler mutate callback
 */
export interface HandlerTxMutateContext<
  TRetrieveSuccessResult,
  TDepsRetrieveSuccessResults extends readonly unknown[],
  THooks extends HooksMap,
> extends HandlerTxContext<THooks> {
  /** Result from retrieveSuccess callback (or raw retrieve results if no retrieveSuccess) */
  retrieveResult: TRetrieveSuccessResult;
  /** Array of retrieve success results from dependencies */
  depsRetrieveResult: TDepsRetrieveSuccessResults;
}

/**
 * Context passed to success callback when mutate IS provided
 */
export interface TxSuccessContextWithMutate<
  TRetrieveSuccessResult,
  TMutateResult,
  TDepsFinalResults extends readonly unknown[],
  TDepsRetrieveResults extends readonly unknown[],
> {
  /** Result from retrieveSuccess callback (or raw retrieve results if no retrieveSuccess) */
  retrieveResult: TRetrieveSuccessResult;
  /** Result from mutate callback */
  mutateResult: TMutateResult;
  /** Array of final results from dependencies */
  depsResult: TDepsFinalResults;
  /** Array of retrieve success results from dependencies (same as what mutate receives) */
  depsRetrieveResult: TDepsRetrieveResults;
}

/**
 * Context passed to success callback when mutate is NOT provided
 */
export interface TxSuccessContextWithoutMutate<
  TRetrieveSuccessResult,
  TDepsFinalResults extends readonly unknown[],
  TDepsRetrieveResults extends readonly unknown[],
> {
  /** Result from retrieveSuccess callback (or raw retrieve results if no retrieveSuccess) */
  retrieveResult: TRetrieveSuccessResult;
  /** No mutate callback was provided */
  mutateResult: undefined;
  /** Array of final results from dependencies */
  depsResult: TDepsFinalResults;
  /** Array of retrieve success results from dependencies (same as what mutate receives) */
  depsRetrieveResult: TDepsRetrieveResults;
}

/**
 * Context passed to success callback (union type for backward compatibility)
 * @deprecated Use TxSuccessContextWithMutate or TxSuccessContextWithoutMutate instead
 */
export type TxSuccessContext<
  TRetrieveSuccessResult,
  TMutateResult,
  TDepsFinalResults extends readonly unknown[],
  TDepsRetrieveResults extends readonly unknown[] = readonly unknown[],
> =
  | TxSuccessContextWithMutate<
      TRetrieveSuccessResult,
      TMutateResult,
      TDepsFinalResults,
      TDepsRetrieveResults
    >
  | TxSuccessContextWithoutMutate<TRetrieveSuccessResult, TDepsFinalResults, TDepsRetrieveResults>;

/**
 * Callbacks for service-level TxResult.
 *
 * Return type priority:
 * 1. If success exists: ReturnType<success>
 * 2. Else if mutate exists: ReturnType<mutate>
 * 3. Else if retrieveSuccess exists: ReturnType<retrieveSuccess>
 * 4. Else if retrieve exists: TRetrieveResults
 * 5. Else: depsResult array type
 */
export interface ServiceTxCallbacks<
  TSchema extends AnySchema,
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  TMutateResult,
  TSuccessResult,
  THooks extends HooksMap,
> {
  /**
   * Dependencies - other TxResults to execute first.
   */
  deps?: () => TDeps;

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
    depsRetrieveResult: ExtractDepsRetrieveSuccessResults<TDeps>,
  ) => TRetrieveSuccessResult;

  /**
   * Mutation phase callback - schedules mutations based on retrieve results.
   */
  mutate?: (
    ctx: ServiceTxMutateContext<
      TSchema,
      TRetrieveSuccessResult,
      ExtractDepsRetrieveSuccessResults<TDeps>,
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
      ExtractDepsFinalResults<TDeps>,
      ExtractDepsRetrieveSuccessResults<TDeps>
    >,
  ) => TSuccessResult;
}

// ============================================================================
// Discriminated callback types for createServiceTx overloads
// ============================================================================

/** Service callbacks with success AND mutate - returns TSuccessResult, mutateResult is NOT undefined */
export interface ServiceTxCallbacksWithSuccessAndMutate<
  TSchema extends AnySchema,
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  TMutateResult,
  TSuccessResult,
  THooks extends HooksMap,
> {
  deps?: () => TDeps;
  retrieve?: (
    uow: TypedUnitOfWork<TSchema, [], unknown, THooks>,
  ) => TypedUnitOfWork<TSchema, TRetrieveResults, unknown, THooks>;
  retrieveSuccess?: (
    retrieveResult: TRetrieveResults,
    depsRetrieveResult: ExtractDepsRetrieveSuccessResults<TDeps>,
  ) => TRetrieveSuccessResult;
  mutate: (
    ctx: ServiceTxMutateContext<
      TSchema,
      TRetrieveSuccessResult,
      ExtractDepsRetrieveSuccessResults<TDeps>,
      THooks
    >,
  ) => TMutateResult;
  success: (
    ctx: TxSuccessContextWithMutate<
      TRetrieveSuccessResult,
      TMutateResult,
      ExtractDepsFinalResults<TDeps>,
      ExtractDepsRetrieveSuccessResults<TDeps>
    >,
  ) => TSuccessResult;
}

/** Service callbacks with success but NO mutate - returns TSuccessResult, mutateResult IS undefined */
export interface ServiceTxCallbacksWithSuccessNoMutate<
  TSchema extends AnySchema,
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  TSuccessResult,
  THooks extends HooksMap,
> {
  deps?: () => TDeps;
  retrieve?: (
    uow: TypedUnitOfWork<TSchema, [], unknown, THooks>,
  ) => TypedUnitOfWork<TSchema, TRetrieveResults, unknown, THooks>;
  retrieveSuccess?: (
    retrieveResult: TRetrieveResults,
    depsRetrieveResult: ExtractDepsRetrieveSuccessResults<TDeps>,
  ) => TRetrieveSuccessResult;
  mutate?: undefined;
  success: (
    ctx: TxSuccessContextWithoutMutate<
      TRetrieveSuccessResult,
      ExtractDepsFinalResults<TDeps>,
      ExtractDepsRetrieveSuccessResults<TDeps>
    >,
  ) => TSuccessResult;
}

/**
 * Service callbacks with success callback - returns TSuccessResult
 * @deprecated Use ServiceTxCallbacksWithSuccessAndMutate or ServiceTxCallbacksWithSuccessNoMutate instead
 */
export interface ServiceTxCallbacksWithSuccess<
  TSchema extends AnySchema,
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  TMutateResult,
  TSuccessResult,
  THooks extends HooksMap,
> {
  deps?: () => TDeps;
  retrieve?: (
    uow: TypedUnitOfWork<TSchema, [], unknown, THooks>,
  ) => TypedUnitOfWork<TSchema, TRetrieveResults, unknown, THooks>;
  retrieveSuccess?: (
    retrieveResult: TRetrieveResults,
    depsRetrieveResult: ExtractDepsRetrieveSuccessResults<TDeps>,
  ) => TRetrieveSuccessResult;
  mutate?: (
    ctx: ServiceTxMutateContext<
      TSchema,
      TRetrieveSuccessResult,
      ExtractDepsRetrieveSuccessResults<TDeps>,
      THooks
    >,
  ) => TMutateResult;
  success: (
    ctx: TxSuccessContext<
      TRetrieveSuccessResult,
      TMutateResult,
      ExtractDepsFinalResults<TDeps>,
      ExtractDepsRetrieveSuccessResults<TDeps>
    >,
  ) => TSuccessResult;
}

/** Service callbacks with mutate AND retrieveSuccess but no success - returns TMutateResult */
export interface ServiceTxCallbacksWithMutateAndRetrieveSuccess<
  TSchema extends AnySchema,
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  TMutateResult,
  THooks extends HooksMap,
> {
  deps?: () => TDeps;
  retrieve?: (
    uow: TypedUnitOfWork<TSchema, [], unknown, THooks>,
  ) => TypedUnitOfWork<TSchema, TRetrieveResults, unknown, THooks>;
  retrieveSuccess: (
    retrieveResult: TRetrieveResults,
    depsRetrieveResult: ExtractDepsRetrieveSuccessResults<TDeps>,
  ) => TRetrieveSuccessResult;
  mutate: (
    ctx: ServiceTxMutateContext<
      TSchema,
      TRetrieveSuccessResult,
      ExtractDepsRetrieveSuccessResults<TDeps>,
      THooks
    >,
  ) => TMutateResult;
  success?: undefined;
}

/**
 * Service callbacks with mutate and retrieve but NO retrieveSuccess - returns TMutateResult.
 * The retrieveResult in mutate is the raw TRetrieveResults array.
 * NOTE: `retrieve` is required here. Use ServiceTxCallbacksWithMutateOnly if you don't have retrieve.
 */
export interface ServiceTxCallbacksWithMutateNoRetrieveSuccess<
  TSchema extends AnySchema,
  TRetrieveResults extends unknown[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  TMutateResult,
  THooks extends HooksMap,
> {
  deps?: () => TDeps;
  retrieve: (
    uow: TypedUnitOfWork<TSchema, [], unknown, THooks>,
  ) => TypedUnitOfWork<TSchema, TRetrieveResults, unknown, THooks>;
  retrieveSuccess?: undefined;
  mutate: (
    ctx: ServiceTxMutateContext<
      TSchema,
      TRetrieveResults,
      ExtractDepsRetrieveSuccessResults<TDeps>,
      THooks
    >,
  ) => TMutateResult;
  success?: undefined;
}

/**
 * Service callbacks with mutate only (no retrieve/retrieveSuccess/success) - returns TMutateResult.
 * The TRetrieveSuccessResult for dependent services is TMutateResult since there's no retrieve phase.
 */
export interface ServiceTxCallbacksWithMutateOnly<
  TSchema extends AnySchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  TMutateResult,
  THooks extends HooksMap,
> {
  deps?: () => TDeps;
  retrieve?: undefined;
  retrieveSuccess?: undefined;
  mutate: (
    ctx: ServiceTxMutateContext<TSchema, unknown, ExtractDepsRetrieveSuccessResults<TDeps>, THooks>,
  ) => TMutateResult;
  success?: undefined;
}

/** Service callbacks with retrieveSuccess but no mutate/success - returns TRetrieveSuccessResult */
export interface ServiceTxCallbacksWithRetrieveSuccess<
  TSchema extends AnySchema,
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  THooks extends HooksMap,
> {
  deps?: () => TDeps;
  retrieve?: (
    uow: TypedUnitOfWork<TSchema, [], unknown, THooks>,
  ) => TypedUnitOfWork<TSchema, TRetrieveResults, unknown, THooks>;
  retrieveSuccess: (
    retrieveResult: TRetrieveResults,
    depsRetrieveResult: ExtractDepsRetrieveSuccessResults<TDeps>,
  ) => TRetrieveSuccessResult;
  mutate?: undefined;
  success?: undefined;
}

/** Service callbacks with retrieve only - returns TRetrieveResults */
export interface ServiceTxCallbacksWithRetrieveOnly<
  TSchema extends AnySchema,
  TRetrieveResults extends unknown[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  THooks extends HooksMap,
> {
  deps?: () => TDeps;
  retrieve: (
    uow: TypedUnitOfWork<TSchema, [], unknown, THooks>,
  ) => TypedUnitOfWork<TSchema, TRetrieveResults, unknown, THooks>;
  retrieveSuccess?: undefined;
  mutate?: undefined;
  success?: undefined;
}

/**
 * Callbacks for handler-level executeTx.
 * Uses context-based callbacks that provide forSchema() method.
 */
export interface HandlerTxCallbacks<
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  TMutateResult,
  TSuccessResult,
  THooks extends HooksMap,
> {
  /**
   * Dependencies - other TxResults to execute first.
   */
  deps?: () => TDeps;

  /**
   * Retrieval phase callback - schedules retrieval operations using context.forSchema().
   */
  retrieve?: (context: HandlerTxContext<THooks>) => TRetrieveResults | void;

  /**
   * Transform retrieve results before passing to mutate.
   */
  retrieveSuccess?: (
    retrieveResult: TRetrieveResults,
    depsRetrieveResult: ExtractDepsRetrieveSuccessResults<TDeps>,
  ) => TRetrieveSuccessResult;

  /**
   * Mutation phase callback - schedules mutations based on retrieve results.
   */
  mutate?: (
    ctx: HandlerTxMutateContext<
      TRetrieveSuccessResult,
      ExtractDepsRetrieveSuccessResults<TDeps>,
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
      ExtractDepsFinalResults<TDeps>,
      ExtractDepsRetrieveSuccessResults<TDeps>
    >,
  ) => TSuccessResult;
}

// ============================================================================
// Discriminated callback types for executeTx overloads
// ============================================================================

/** executeTx callbacks with success, mutate, AND deps - returns TSuccessResult */
export interface HandlerTxCallbacksWithSuccessMutateDeps<
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  TMutateResult,
  TSuccessResult,
  THooks extends HooksMap,
> {
  deps: () => TDeps;
  retrieve?: (context: HandlerTxContext<THooks>) => TRetrieveResults | void;
  retrieveSuccess?: (
    retrieveResult: TRetrieveResults,
    depsRetrieveResult: ExtractDepsRetrieveSuccessResults<TDeps>,
  ) => TRetrieveSuccessResult;
  mutate: (
    ctx: HandlerTxMutateContext<
      TRetrieveSuccessResult,
      ExtractDepsRetrieveSuccessResults<TDeps>,
      THooks
    >,
  ) => TMutateResult;
  success: (
    ctx: TxSuccessContextWithMutate<
      TRetrieveSuccessResult,
      TMutateResult,
      ExtractDepsFinalResults<TDeps>,
      ExtractDepsRetrieveSuccessResults<TDeps>
    >,
  ) => TSuccessResult;
}

/** executeTx callbacks with success AND mutate, but NO deps - returns TSuccessResult */
export interface HandlerTxCallbacksWithSuccessMutateNoDeps<
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  TMutateResult,
  TSuccessResult,
  THooks extends HooksMap,
> {
  deps?: undefined;
  retrieve?: (context: HandlerTxContext<THooks>) => TRetrieveResults | void;
  retrieveSuccess?: (
    retrieveResult: TRetrieveResults,
    depsRetrieveResult: readonly [],
  ) => TRetrieveSuccessResult;
  mutate: (
    ctx: HandlerTxMutateContext<TRetrieveSuccessResult, readonly [], THooks>,
  ) => TMutateResult;
  success: (
    ctx: TxSuccessContextWithMutate<
      TRetrieveSuccessResult,
      TMutateResult,
      readonly [],
      readonly []
    >,
  ) => TSuccessResult;
}

/** executeTx callbacks with success and deps but NO mutate - returns TSuccessResult */
export interface HandlerTxCallbacksWithSuccessDepsNoMutate<
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  TSuccessResult,
  THooks extends HooksMap,
> {
  deps: () => TDeps;
  retrieve?: (context: HandlerTxContext<THooks>) => TRetrieveResults | void;
  retrieveSuccess?: (
    retrieveResult: TRetrieveResults,
    depsRetrieveResult: ExtractDepsRetrieveSuccessResults<TDeps>,
  ) => TRetrieveSuccessResult;
  mutate?: undefined;
  success: (
    ctx: TxSuccessContextWithoutMutate<
      TRetrieveSuccessResult,
      ExtractDepsFinalResults<TDeps>,
      ExtractDepsRetrieveSuccessResults<TDeps>
    >,
  ) => TSuccessResult;
}

/** executeTx callbacks with success but NO mutate and NO deps - returns TSuccessResult */
export interface HandlerTxCallbacksWithSuccessNoDepsNoMutate<
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  TSuccessResult,
  THooks extends HooksMap,
> {
  deps?: undefined;
  retrieve?: (context: HandlerTxContext<THooks>) => TRetrieveResults | void;
  retrieveSuccess?: (
    retrieveResult: TRetrieveResults,
    depsRetrieveResult: readonly [],
  ) => TRetrieveSuccessResult;
  mutate?: undefined;
  success: (
    ctx: TxSuccessContextWithoutMutate<TRetrieveSuccessResult, readonly [], readonly []>,
  ) => TSuccessResult;
}

/** executeTx callbacks with mutate but no success - returns TMutateResult */
export interface HandlerTxCallbacksWithMutate<
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  TMutateResult,
  THooks extends HooksMap,
> {
  deps?: () => TDeps;
  retrieve?: (context: HandlerTxContext<THooks>) => TRetrieveResults | void;
  retrieveSuccess?: (
    retrieveResult: TRetrieveResults,
    depsRetrieveResult: ExtractDepsRetrieveSuccessResults<TDeps>,
  ) => TRetrieveSuccessResult;
  mutate: (
    ctx: HandlerTxMutateContext<
      TRetrieveSuccessResult,
      ExtractDepsRetrieveSuccessResults<TDeps>,
      THooks
    >,
  ) => TMutateResult;
  success?: undefined;
}

/** executeTx callbacks with retrieveSuccess but no mutate/success - returns TRetrieveSuccessResult */
export interface HandlerTxCallbacksWithRetrieveSuccess<
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  THooks extends HooksMap,
> {
  deps?: () => TDeps;
  retrieve?: (context: HandlerTxContext<THooks>) => TRetrieveResults | void;
  retrieveSuccess: (
    retrieveResult: TRetrieveResults,
    depsRetrieveResult: ExtractDepsRetrieveSuccessResults<TDeps>,
  ) => TRetrieveSuccessResult;
  mutate?: undefined;
  success?: undefined;
}

/** executeTx callbacks with deps only - returns deps final results */
export interface HandlerTxCallbacksWithDepsOnly<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
> {
  deps: () => TDeps;
  retrieve?: undefined;
  retrieveSuccess?: undefined;
  mutate?: undefined;
  success?: undefined;
}

/** @deprecated Use ServiceTxCallbacks instead */
export type TxCallbacks<
  TSchema extends AnySchema,
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  TMutateResult,
  TSuccessResult,
  THooks extends HooksMap,
> = ServiceTxCallbacks<
  TSchema,
  TRetrieveResults,
  TRetrieveSuccessResult,
  TDeps,
  TMutateResult,
  TSuccessResult,
  THooks
>;

/**
 * Internal structure storing TxResult callbacks and state.
 */
interface TxResultInternal<
  TSchema extends AnySchema,
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  TDeps extends readonly (TxResult<unknown> | undefined)[],
  TMutateResult,
  TSuccessResult,
  THooks extends HooksMap,
> {
  schema: TSchema | undefined;
  callbacks: TxCallbacks<
    TSchema,
    TRetrieveResults,
    TRetrieveSuccessResult,
    TDeps,
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
  /** Dependencies resolved */
  deps: TDeps | undefined;
}

/**
 * TxResult represents a transaction definition (not yet executed).
 * It describes the work to be done: retrieve operations, transformations, and mutations.
 *
 * Service methods return TxResult objects, and the handler's executeTx function
 * orchestrates their execution with retry support.
 *
 * @template TResult - The final result type (determined by return type priority)
 * @template TRetrieveSuccessResult - The retrieve success result type (what deps receive).
 *   Defaults to TResult, meaning deps receive the same type as the final result.
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
 * Infer the final result type from TxCallbacks based on priority:
 * 1. success → ReturnType<success>
 * 2. mutate → ReturnType<mutate>
 * 3. retrieveSuccess → ReturnType<retrieveSuccess>
 * 4. retrieve → TRetrieveResults
 * 5. deps → ExtractDepsFinalResults<TDeps>
 */
export type InferTxResultType<
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  TDeps extends readonly TxResult<unknown>[],
  TMutateResult,
  TSuccessResult,
  HasSuccess extends boolean,
  HasMutate extends boolean,
  HasRetrieveSuccess extends boolean,
  HasRetrieve extends boolean,
> = HasSuccess extends true
  ? TSuccessResult
  : HasMutate extends true
    ? AwaitedPromisesInObject<TMutateResult>
    : HasRetrieveSuccess extends true
      ? TRetrieveSuccessResult
      : HasRetrieve extends true
        ? TRetrieveResults
        : ExtractDepsFinalResults<TDeps>;

/**
 * Infer the retrieve success result type:
 * - If retrieveSuccess exists: ReturnType<retrieveSuccess>
 * - Else: TRetrieveResults (raw retrieve results)
 */
export type InferRetrieveSuccessResult<
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  HasRetrieveSuccess extends boolean,
> = HasRetrieveSuccess extends true ? TRetrieveSuccessResult : TRetrieveResults;

/**
 * Create a TxResult for service context.
 * Schedules retrieve operations on the baseUow and returns a TxResult with callbacks stored.
 *
 * This is the unified service transaction function that replaces both
 * executeServiceTx and executeServiceTxWithDeps.
 */
// Overload 1a: With success AND mutate - returns TSuccessResult, mutateResult is NOT undefined
export function createServiceTx<
  TSchema extends AnySchema,
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  TMutateResult,
  TSuccessResult,
  THooks extends HooksMap = {},
>(
  schema: TSchema | undefined,
  callbacks: ServiceTxCallbacksWithSuccessAndMutate<
    TSchema,
    TRetrieveResults,
    TRetrieveSuccessResult,
    TDeps,
    TMutateResult,
    TSuccessResult,
    THooks
  >,
  baseUow: IUnitOfWork,
): TxResult<TSuccessResult, TRetrieveSuccessResult>;

// Overload 1b: With success but NO mutate - returns TSuccessResult, mutateResult IS undefined
export function createServiceTx<
  TSchema extends AnySchema,
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  TSuccessResult,
  THooks extends HooksMap = {},
>(
  schema: TSchema | undefined,
  callbacks: ServiceTxCallbacksWithSuccessNoMutate<
    TSchema,
    TRetrieveResults,
    TRetrieveSuccessResult,
    TDeps,
    TSuccessResult,
    THooks
  >,
  baseUow: IUnitOfWork,
): TxResult<TSuccessResult, TRetrieveSuccessResult>;

// Overload 2: With mutate only (no retrieve/retrieveSuccess) - returns TMutateResult
// The second generic (TRetrieveSuccessResult for deps) is TMutateResult since there's no retrieve phase
export function createServiceTx<
  TSchema extends AnySchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  TMutateResult,
  THooks extends HooksMap = {},
>(
  schema: TSchema | undefined,
  callbacks: ServiceTxCallbacksWithMutateOnly<TSchema, TDeps, TMutateResult, THooks>,
  baseUow: IUnitOfWork,
): TxResult<TMutateResult, TMutateResult>;

// Overload 3a: With mutate AND retrieveSuccess but no success - returns TMutateResult
export function createServiceTx<
  TSchema extends AnySchema,
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  TMutateResult,
  THooks extends HooksMap = {},
>(
  schema: TSchema | undefined,
  callbacks: ServiceTxCallbacksWithMutateAndRetrieveSuccess<
    TSchema,
    TRetrieveResults,
    TRetrieveSuccessResult,
    TDeps,
    TMutateResult,
    THooks
  >,
  baseUow: IUnitOfWork,
): TxResult<TMutateResult, TRetrieveSuccessResult>;

// Overload 3b: With mutate but NO retrieveSuccess (and no success) - returns TMutateResult
// retrieveResult in mutate is TRetrieveResults (raw array)
export function createServiceTx<
  TSchema extends AnySchema,
  TRetrieveResults extends unknown[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  TMutateResult,
  THooks extends HooksMap = {},
>(
  schema: TSchema | undefined,
  callbacks: ServiceTxCallbacksWithMutateNoRetrieveSuccess<
    TSchema,
    TRetrieveResults,
    TDeps,
    TMutateResult,
    THooks
  >,
  baseUow: IUnitOfWork,
): TxResult<TMutateResult, TRetrieveResults>;

// Overload 4: With retrieveSuccess but no mutate/success - returns TRetrieveSuccessResult
export function createServiceTx<
  TSchema extends AnySchema,
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  THooks extends HooksMap = {},
>(
  schema: TSchema | undefined,
  callbacks: ServiceTxCallbacksWithRetrieveSuccess<
    TSchema,
    TRetrieveResults,
    TRetrieveSuccessResult,
    TDeps,
    THooks
  >,
  baseUow: IUnitOfWork,
): TxResult<TRetrieveSuccessResult, TRetrieveSuccessResult>;

// Overload 4: With retrieve only - returns TRetrieveResults
export function createServiceTx<
  TSchema extends AnySchema,
  TRetrieveResults extends unknown[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  THooks extends HooksMap = {},
>(
  schema: TSchema | undefined,
  callbacks: ServiceTxCallbacksWithRetrieveOnly<TSchema, TRetrieveResults, TDeps, THooks>,
  baseUow: IUnitOfWork,
): TxResult<TRetrieveResults, TRetrieveResults>;

// Implementation signature
export function createServiceTx<
  TSchema extends AnySchema,
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  TMutateResult,
  TSuccessResult,
  THooks extends HooksMap = {},
>(
  schema: TSchema | undefined,
  callbacks: ServiceTxCallbacks<
    TSchema,
    TRetrieveResults,
    TRetrieveSuccessResult,
    TDeps,
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

  // Call deps factory if provided - this invokes other services which schedule their operations
  let deps: TDeps | undefined;
  try {
    if (callbacks.deps) {
      deps = callbacks.deps();
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
    TDeps,
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
    deps,
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
   * Callback invoked before mutations are executed.
   * Use this to add additional mutation operations (e.g., hook event records).
   */
  onBeforeMutate?: (uow: IUnitOfWork) => void;

  /**
   * Callback invoked after successful mutation phase.
   * Use this for post-mutation processing like hook execution.
   */
  onAfterMutate?: (uow: IUnitOfWork) => Promise<void>;
}

/**
 * Recursively collect all TxResults from a dependency tree.
 * Returns them in a flat array in dependency order (deps before their dependents).
 * Skips undefined values (which can occur with optional service patterns like optionalService?.method()).
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

    // First collect deps (so they come before this TxResult)
    const deps = txResult._internal.deps;
    if (deps) {
      for (const dep of deps) {
        collect(dep);
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

  // Collect deps' retrieve success results (or mutate results if no retrieve was provided)
  // When a dep has no retrieve/retrieveSuccess but has mutate, its mutate has already run
  // (due to dependency order), so we use its mutate result as the "retrieve success result".
  const depsRetrieveResults: unknown[] = [];
  if (internal.deps) {
    for (const dep of internal.deps) {
      if (dep === undefined) {
        depsRetrieveResults.push(undefined);
        continue;
      }

      const depInternal = dep._internal;
      if (
        depInternal.retrieveSuccessResult !== undefined &&
        !(
          Array.isArray(depInternal.retrieveSuccessResult) &&
          depInternal.retrieveSuccessResult.length === 0 &&
          depInternal.callbacks.mutate
        )
      ) {
        depsRetrieveResults.push(depInternal.retrieveSuccessResult);
      } else if (depInternal.mutateResult !== undefined) {
        depsRetrieveResults.push(depInternal.mutateResult);
      } else {
        depsRetrieveResults.push(depInternal.retrieveSuccessResult);
      }
    }
  }

  if (callbacks.retrieveSuccess) {
    internal.retrieveSuccessResult = callbacks.retrieveSuccess(
      retrieveResults,
      depsRetrieveResults as ExtractDepsRetrieveSuccessResults<readonly TxResult<unknown>[]>,
    );
  } else {
    internal.retrieveSuccessResult = retrieveResults as typeof internal.retrieveSuccessResult;
  }

  if (callbacks.mutate) {
    const mutateCtx = {
      uow: internal.schema
        ? baseUow.forSchema(internal.schema)
        : (undefined as unknown as TypedUnitOfWork<AnySchema, [], unknown, HooksMap>),
      // At this point retrieveSuccessResult has been set (either by retrieveSuccess callback or defaulted to retrieveResults)
      retrieveResult: internal.retrieveSuccessResult as NonNullable<
        typeof internal.retrieveSuccessResult
      >,
      depsRetrieveResult: depsRetrieveResults as ExtractDepsRetrieveSuccessResults<
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

  const depsRetrieveResults: unknown[] = [];
  const depsFinalResults: unknown[] = [];
  if (internal.deps) {
    for (const dep of internal.deps) {
      if (dep === undefined) {
        depsRetrieveResults.push(undefined);
        depsFinalResults.push(undefined);
        continue;
      }

      // Mirror the logic from processTxResultAfterRetrieve/executeTx:
      // For mutate-only deps (empty-array sentinel), use mutateResult instead of retrieveSuccessResult
      const depInternal = dep._internal;
      if (
        depInternal.retrieveSuccessResult !== undefined &&
        !(
          Array.isArray(depInternal.retrieveSuccessResult) &&
          depInternal.retrieveSuccessResult.length === 0 &&
          depInternal.callbacks.mutate
        )
      ) {
        depsRetrieveResults.push(depInternal.retrieveSuccessResult);
      } else if (depInternal.mutateResult !== undefined) {
        depsRetrieveResults.push(depInternal.mutateResult);
      } else {
        depsRetrieveResults.push(depInternal.retrieveSuccessResult);
      }
      depsFinalResults.push(depInternal.finalResult);
    }
  }

  if (callbacks.success) {
    const successCtx = {
      retrieveResult: internal.retrieveSuccessResult as NonNullable<
        typeof internal.retrieveSuccessResult
      >,
      mutateResult: internal.mutateResult,
      depsResult: depsFinalResults as ExtractDepsFinalResults<readonly TxResult<unknown>[]>,
      depsRetrieveResult: depsRetrieveResults as ExtractDepsRetrieveSuccessResults<
        readonly TxResult<unknown>[]
      >,
    };
    internal.finalResult = callbacks.success(successCtx) as T;
  } else if (callbacks.mutate) {
    internal.finalResult = (await awaitPromisesInObject(internal.mutateResult)) as T;
  } else if (callbacks.retrieveSuccess || callbacks.retrieve) {
    internal.finalResult = internal.retrieveSuccessResult as T;
  } else {
    internal.finalResult = depsFinalResults as T;
  }

  return internal.finalResult as T;
}

/**
 * Execute a transaction with the unified TxResult pattern.
 *
 * This is the handler-level function that actually executes TxResults with retry support.
 * It replaces executeTxCallbacks, executeTxWithDeps, and executeTxArray.
 *
 * @param callbacks - Transaction callbacks (deps, retrieve, retrieveSuccess, mutate, success)
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
 *
 * // With deps
 * const orderId = await executeTx({
 *   deps: () => [userService.getUserById(userId)],
 *   mutate: ({ forSchema, depsRetrieveResult: [user] }) => {
 *     if (!user) throw new Error("User not found");
 *     return forSchema(ordersSchema).create("orders", { ... });
 *   },
 * }, { createUnitOfWork });
 * ```
 */
// Overload 1a: With success, mutate, AND deps - returns TSuccessResult
export function executeTx<
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  TMutateResult,
  TSuccessResult,
  THooks extends HooksMap = {},
>(
  callbacks: HandlerTxCallbacksWithSuccessMutateDeps<
    TRetrieveResults,
    TRetrieveSuccessResult,
    TDeps,
    TMutateResult,
    TSuccessResult,
    THooks
  >,
  options: ExecuteTxOptions,
): Promise<AwaitedPromisesInObject<TSuccessResult>>;

// Overload 1b: With success AND mutate, but NO deps - returns TSuccessResult
export function executeTx<
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  TMutateResult,
  TSuccessResult,
  THooks extends HooksMap = {},
>(
  callbacks: HandlerTxCallbacksWithSuccessMutateNoDeps<
    TRetrieveResults,
    TRetrieveSuccessResult,
    TMutateResult,
    TSuccessResult,
    THooks
  >,
  options: ExecuteTxOptions,
): Promise<AwaitedPromisesInObject<TSuccessResult>>;

// Overload 1c: With success AND deps, but NO mutate - returns TSuccessResult
export function executeTx<
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  TSuccessResult,
  THooks extends HooksMap = {},
>(
  callbacks: HandlerTxCallbacksWithSuccessDepsNoMutate<
    TRetrieveResults,
    TRetrieveSuccessResult,
    TDeps,
    TSuccessResult,
    THooks
  >,
  options: ExecuteTxOptions,
): Promise<AwaitedPromisesInObject<TSuccessResult>>;

// Overload 1d: With success but NO deps and NO mutate - returns TSuccessResult
export function executeTx<
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  TSuccessResult,
  THooks extends HooksMap = {},
>(
  callbacks: HandlerTxCallbacksWithSuccessNoDepsNoMutate<
    TRetrieveResults,
    TRetrieveSuccessResult,
    TSuccessResult,
    THooks
  >,
  options: ExecuteTxOptions,
): Promise<AwaitedPromisesInObject<TSuccessResult>>;

// Overload 2: With mutate but no success - returns TMutateResult
export function executeTx<
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  TMutateResult,
  THooks extends HooksMap = {},
>(
  callbacks: HandlerTxCallbacksWithMutate<
    TRetrieveResults,
    TRetrieveSuccessResult,
    TDeps,
    TMutateResult,
    THooks
  >,
  options: ExecuteTxOptions,
): Promise<AwaitedPromisesInObject<TMutateResult>>;

// Overload 3: With retrieveSuccess but no mutate/success - returns TRetrieveSuccessResult
export function executeTx<
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
  THooks extends HooksMap = {},
>(
  callbacks: HandlerTxCallbacksWithRetrieveSuccess<
    TRetrieveResults,
    TRetrieveSuccessResult,
    TDeps,
    THooks
  >,
  options: ExecuteTxOptions,
): Promise<AwaitedPromisesInObject<TRetrieveSuccessResult>>;

// Overload 4: With deps only - returns deps final results
export function executeTx<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TDeps extends readonly (TxResult<any, any> | undefined)[],
>(
  callbacks: HandlerTxCallbacksWithDepsOnly<TDeps>,
  options: ExecuteTxOptions,
): Promise<ExtractDepsFinalResults<TDeps>>;

// Implementation signature - accepts any variant of callbacks
// The implementation uses `any` for callbacks because there are many discriminated
// overload variants and TypeScript can't express a union of all of them easily.
// Type safety is guaranteed by the overload signatures.
export async function executeTx(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  callbacks: any,
  options: ExecuteTxOptions,
): Promise<unknown> {
  type TRetrieveResults = unknown[];
  type TRetrieveSuccessResult = unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type TDeps = readonly TxResult<any, any>[];
  type TMutateResult = unknown;
  type THooks = HooksMap;
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
      throw new Error("Transaction execution aborted");
    }

    try {
      // Create a fresh UOW for this attempt
      const baseUow = options.createUnitOfWork();

      // Create handler context
      const context: HandlerTxContext<THooks> = {
        forSchema: <S extends AnySchema, H extends HooksMap = THooks>(schema: S, hooks?: H) => {
          return baseUow.forSchema(schema, hooks);
        },
        nonce: baseUow.nonce,
        currentAttempt: attempt,
      };

      // Call deps factory if provided - this creates TxResults that schedule operations
      let deps: TDeps | undefined;
      if (callbacks.deps) {
        deps = callbacks.deps();
      }

      let retrieveResult: TRetrieveResults;
      if (callbacks.retrieve) {
        const result = callbacks.retrieve(context);
        retrieveResult = (result ?? []) as TRetrieveResults;
      } else {
        retrieveResult = [] as unknown as TRetrieveResults;
      }

      const allDepTxResults = deps ? collectAllTxResults([...deps]) : [];

      await baseUow.executeRetrieve();

      for (const txResult of allDepTxResults) {
        await processTxResultAfterRetrieve(txResult, baseUow);
      }

      const depsRetrieveResults: unknown[] = [];
      if (deps) {
        for (const dep of deps) {
          if (dep === undefined) {
            depsRetrieveResults.push(undefined);
            continue;
          }
          const depInternal = dep._internal;
          if (
            depInternal.retrieveSuccessResult !== undefined &&
            !(
              Array.isArray(depInternal.retrieveSuccessResult) &&
              depInternal.retrieveSuccessResult.length === 0 &&
              depInternal.callbacks.mutate
            )
          ) {
            depsRetrieveResults.push(depInternal.retrieveSuccessResult);
          } else if (depInternal.mutateResult !== undefined) {
            depsRetrieveResults.push(depInternal.mutateResult);
          } else {
            depsRetrieveResults.push(depInternal.retrieveSuccessResult);
          }
        }
      }

      // Call retrieveSuccess if provided
      let retrieveSuccessResult: TRetrieveSuccessResult;
      if (callbacks.retrieveSuccess) {
        retrieveSuccessResult = callbacks.retrieveSuccess(
          retrieveResult,
          depsRetrieveResults as ExtractDepsRetrieveSuccessResults<TDeps>,
        );
      } else {
        retrieveSuccessResult = retrieveResult as unknown as TRetrieveSuccessResult;
      }

      let mutateResult: TMutateResult | undefined;
      if (callbacks.mutate) {
        const mutateCtx: HandlerTxMutateContext<
          TRetrieveSuccessResult,
          ExtractDepsRetrieveSuccessResults<TDeps>,
          THooks
        > = {
          ...context,
          retrieveResult: retrieveSuccessResult,
          depsRetrieveResult: depsRetrieveResults as ExtractDepsRetrieveSuccessResults<TDeps>,
        };
        mutateResult = callbacks.mutate(mutateCtx);
      }

      if (options.onBeforeMutate) {
        options.onBeforeMutate(baseUow);
      }
      const result = await baseUow.executeMutations();
      if (!result.success) {
        throw new ConcurrencyConflictError();
      }

      // Process each dep TxResult's success callback
      for (const txResult of allDepTxResults) {
        await processTxResultAfterMutate(txResult);
      }

      const depsFinalResults: unknown[] = [];
      if (deps) {
        for (const dep of deps) {
          if (dep === undefined) {
            depsFinalResults.push(undefined);
            continue;
          }
          depsFinalResults.push(dep._internal.finalResult);
        }
      }

      let finalResult: unknown;
      if (callbacks.success) {
        // The success context type is determined by the overload - we construct it at runtime
        // and the type safety is guaranteed by the discriminated overloads
        const successCtx = {
          retrieveResult: retrieveSuccessResult,
          mutateResult,
          depsResult: depsFinalResults as ExtractDepsFinalResults<TDeps>,
          depsRetrieveResult: depsRetrieveResults as ExtractDepsRetrieveSuccessResults<TDeps>,
        } as Parameters<NonNullable<typeof callbacks.success>>[0];
        finalResult = callbacks.success(successCtx);
      } else if (callbacks.mutate) {
        finalResult = await awaitPromisesInObject(mutateResult);
      } else if (callbacks.retrieveSuccess || callbacks.retrieve) {
        finalResult = retrieveSuccessResult;
      } else {
        finalResult = depsFinalResults;
      }

      if (options.onAfterMutate) {
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

      if (!retryPolicy.shouldRetry(attempt, error, signal)) {
        if (signal?.aborted) {
          throw new Error("Transaction execution aborted");
        }
        throw new Error("Transaction execution failed: optimistic concurrency conflict", {
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

// =============================================================================
// END OF NEW UNIFIED TX API
// =============================================================================

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
 * Extract retrieval results type from a ServiceTxResult or Awaited type for regular promises.
 * Used by executeTxWithDeps and executeServiceTxWithDeps to correctly type the deps parameter.
 */
export type ExtractServiceTxRetrievalResults<T> =
  T extends ServiceTxResult<unknown, infer R> ? R : Awaited<T>;

/**
 * Map over deps array to extract retrieval results from each dep.
 * Preserves tuple structure while extracting the retrieval results type from each element.
 */
export type ExtractDepsRetrievalResults<T extends readonly unknown[]> = {
  [K in keyof T]: ExtractServiceTxRetrievalResults<T[K]>;
};

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
  /**
   * Nonce for the current transaction attempt
   */
  nonce: string;
  /**
   * Current attempt number (0-based)
   */
  currentAttempt: number;
}

/**
 * @deprecated Use the new unified HandlerTxCallbacks instead
 * Handler callbacks for tx() - SYNCHRONOUS ONLY (no Promise return allowed)
 * This prevents accidentally awaiting services in the wrong place
 */
export interface LegacyHandlerTxCallbacks<
  TSchema extends AnySchema,
  TRetrievalResults extends unknown[],
  TMutationResult,
  THooks extends HooksMap,
> {
  /**
   * Retrieval phase callback - schedules retrievals, returns typed UOW
   * Must be synchronous - cannot await promises
   */
  retrieve?: (
    context: TxPhaseContext<THooks>,
  ) => TypedUnitOfWork<TSchema, TRetrievalResults, unknown, THooks>;
  /**
   * Mutation phase callback - receives retrieval results, schedules mutations
   * Must be synchronous - cannot await promises (but may return a promise to be awaited)
   */
  mutate?: (context: TxPhaseContext<THooks>, results: TRetrievalResults) => TMutationResult;
}

/**
 * @deprecated Use the new unified executeTx with deps callback instead
 * Handler callbacks for tx() with dependencies - allows calling other services as deps
 * The deps are resolved first, then mutate is called with the resolved values
 */
export interface HandlerTxWithDepsCallbacks<
  TDeps extends readonly unknown[],
  TMutationResult,
  THooks extends HooksMap,
> {
  /**
   * Mutation phase callback - receives resolved dependencies, schedules mutations
   * May return a promise to be awaited
   */
  mutate: (
    context: TxPhaseContext<THooks>,
    deps: { [K in keyof TDeps]: TDeps[K] },
  ) => TMutationResult;
}

/**
 * @deprecated Use the new unified ServiceTxCallbacks instead
 */
export interface LegacyServiceTxCallbacks<
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
 * @deprecated Use executeTx with deps callback instead.
 *
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
 * @deprecated Use executeTx with deps callback instead.
 *
 * Execute a transaction with dependencies + mutation syntax (handler context).
 * Dependencies are resolved first (via service calls), then mutate is called with the resolved values.
 *
 * This enables service-to-service composition: the deps factory calls other services,
 * their operations are batched, and the mutate callback receives the results.
 *
 * Deps can be either ServiceTxResult objects (from executeServiceTx) or regular promises.
 * For ServiceTxResult deps, we access `retrievalResult` after retrieval phase, allowing
 * deps with mutations to work correctly.
 *
 * @param depsFactory - Factory that returns an array of service results or promises
 * @param callbacks - Object containing mutate callback that receives resolved deps
 * @param options - Configuration including UOW factory, retry policy, and abort signal
 * @returns Promise resolving to the mutation result with promises awaited 1 level deep
 *
 * @example
 * ```ts
 * const result = await executeTxWithDeps(
 *   () => [userService.getUserById(userId)],
 *   {
 *     mutate: (context, [user]) => {
 *       if (!user) throw new Error("User not found");
 *       return context.forSchema(ordersSchema).create("orders", { userId: user.id });
 *     }
 *   },
 *   { createUnitOfWork }
 * );
 * ```
 */
export async function executeTxWithDeps<
  TDepsItems extends readonly (ServiceTxResult<unknown, unknown> | PromiseLike<unknown>)[],
  TMutationResult,
  THooks extends HooksMap = {},
>(
  depsFactory: () => TDepsItems,
  callbacks: {
    /**
     * Mutation phase callback - receives resolved dependencies (retrieval results), schedules mutations
     * May return a promise to be awaited
     */
    mutate: (
      context: TxPhaseContext<THooks>,
      deps: ExtractDepsRetrievalResults<TDepsItems>,
    ) => TMutationResult;
  },
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

      // Call factory to create fresh service results for this attempt
      const depsResults = depsFactory();

      // Execute retrieval phase - services' retrieve callbacks run and schedule operations
      // After this, deps' mutate callbacks have run and retrievalResult is set
      await baseUow.executeRetrieve();

      const deps = (await Promise.all(
        depsResults.map(async (dep) => {
          if (dep && typeof dep === "object" && "retrievalResult" in dep) {
            return await (dep as ServiceTxResult<unknown>).retrievalResult;
          }
          return await dep;
        }),
      )) as ExtractDepsRetrievalResults<TDepsItems>;

      // Now call the handler's mutate callback with the resolved deps
      const context: TxPhaseContext<THooks> = {
        forSchema: <S extends AnySchema, H extends HooksMap = THooks>(schema: S, hooks?: H) => {
          return baseUow.forSchema(schema, hooks);
        },
        nonce: baseUow.nonce,
        currentAttempt: attempt,
      };

      const mutationResult = callbacks.mutate(context, deps);

      if (options.onBeforeMutate) {
        options.onBeforeMutate(baseUow);
      }

      const result = await baseUow.executeMutations();
      if (!result.success) {
        throw new ConcurrencyConflictError();
      }

      const awaitedMutationResult = await awaitPromisesInObject(mutationResult);

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
 * @deprecated Use executeTx instead.
 *
 * Execute a transaction with callback syntax (handler context).
 * Callbacks are synchronous only to prevent accidentally awaiting services in wrong place.
 *
 * @param callbacks - Object containing retrieve and mutate callbacks
 * @param options - Configuration including UOW factory, retry policy, and abort signal
 * @returns Promise resolving to the mutation result with promises awaited 1 level deep
 */
export async function executeTxCallbacks<
  TSchema extends AnySchema,
  TRetrievalResults extends unknown[],
  TMutationResult,
  THooks extends HooksMap = {},
>(
  callbacks: LegacyHandlerTxCallbacks<TSchema, TRetrievalResults, TMutationResult, THooks>,
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
        nonce: baseUow.nonce,
        currentAttempt: attempt,
      };

      let retrievalUow: TypedUnitOfWork<TSchema, TRetrievalResults, unknown, THooks>;
      if (callbacks.retrieve) {
        retrievalUow = callbacks.retrieve(context);
      } else {
        // Safe cast: when there's no retrieve, we assume an empty UOW was created via forSchema
        retrievalUow = undefined as unknown as TypedUnitOfWork<
          TSchema,
          TRetrievalResults,
          unknown,
          THooks
        >;
      }

      await baseUow.executeRetrieve();

      // Get retrieval results from the UOW
      const results = retrievalUow
        ? ((await retrievalUow.retrievalPhase) as TRetrievalResults)
        : ([] as unknown as TRetrievalResults);

      let mutationResult: TMutationResult;
      if (callbacks.mutate) {
        mutationResult = callbacks.mutate(context, results);
      } else {
        mutationResult = undefined as TMutationResult;
      }

      if (options.onBeforeMutate) {
        options.onBeforeMutate(baseUow);
      }

      const result = await baseUow.executeMutations();
      if (!result.success) {
        throw new ConcurrencyConflictError();
      }

      const awaitedMutationResult = await awaitPromisesInObject(mutationResult);

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
 * @deprecated Use TxResult instead.
 *
 * Result of a service transaction that acts like a Promise but also exposes
 * the retrieval results before the transaction commits.
 *
 * This enables the deps pattern where a caller can access `retrievalResult`
 * after the retrieval phase but before mutations complete, allowing deps
 * with mutations to be used in service composition.
 */
export interface ServiceTxResult<TResult, TRetrievalResults = unknown> extends Promise<TResult> {
  /**
   * Promise resolving to the retrieval results from the service's retrieve callback.
   * Resolves after the retrieval phase completes, before mutations commit.
   */
  retrievalResult: Promise<TRetrievalResults>;
}

/**
 * @deprecated Use createServiceTx instead.
 *
 * Execute a transaction for service context.
 * Service callbacks can be async for ergonomic async work.
 *
 * Returns a ServiceTxResult that acts like a Promise but also exposes `retrievalResult`
 * after the retrieval phase, enabling service-to-service composition.
 *
 * @param schema - Schema to use for the transaction
 * @param callbacks - Object containing retrieve and mutate callbacks
 * @param baseUow - Base Unit of Work (restricted) to use
 * @returns ServiceTxResult resolving to retrieval results (if no mutate) or mutation result (if mutate provided)
 */
// Overload: with mutate callback - returns mutation result
export function executeServiceTx<
  TSchema extends AnySchema,
  TRetrievalResults extends unknown[],
  TMutationResult,
  THooks extends HooksMap,
>(
  schema: TSchema,
  callbacks: {
    retrieve?: (
      uow: TypedUnitOfWork<TSchema, [], unknown, THooks>,
    ) => TypedUnitOfWork<TSchema, TRetrievalResults, unknown, THooks>;
    mutate: (
      uow: TypedUnitOfWork<TSchema, TRetrievalResults, unknown, THooks>,
      results: TRetrievalResults,
    ) => TMutationResult | Promise<TMutationResult>;
  },
  baseUow: IUnitOfWork,
): ServiceTxResult<AwaitedPromisesInObject<TMutationResult>, TRetrievalResults>;

// Overload: without mutate callback - returns retrieval results
export function executeServiceTx<
  TSchema extends AnySchema,
  TRetrievalResults extends unknown[],
  THooks extends HooksMap,
>(
  schema: TSchema,
  callbacks: {
    retrieve: (
      uow: TypedUnitOfWork<TSchema, [], unknown, THooks>,
    ) => TypedUnitOfWork<TSchema, TRetrievalResults, unknown, THooks>;
    mutate?: undefined;
  },
  baseUow: IUnitOfWork,
): ServiceTxResult<TRetrievalResults, TRetrievalResults>;

// Implementation
export function executeServiceTx<
  TSchema extends AnySchema,
  TRetrievalResults extends unknown[],
  TMutationResult,
  THooks extends HooksMap,
>(
  schema: TSchema,
  callbacks: LegacyServiceTxCallbacks<TSchema, TRetrievalResults, TMutationResult, THooks>,
  baseUow: IUnitOfWork,
): ServiceTxResult<
  AwaitedPromisesInObject<TMutationResult> | TRetrievalResults,
  TRetrievalResults
> {
  // Deferred promise for retrieval results - resolves when retrieval phase completes
  const {
    promise: retrievalResultPromise,
    resolve: resolveRetrievalResult,
    reject: rejectRetrievalResult,
  } = Promise.withResolvers<TRetrievalResults>();

  // Create the async execution
  const promise = (async () => {
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
      rejectRetrievalResult(error);
      throw error;
    }

    typedUow.signalReadyForRetrieval();

    let results: TRetrievalResults;
    try {
      results = await retrievalUow.retrievalPhase;
    } catch (error) {
      rejectRetrievalResult(error);
      typedUow.signalReadyForMutation();
      throw error;
    }
    // Resolve the retrieval promise for deps pattern to access results early
    resolveRetrievalResult(results);

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

    // If no mutate callback was provided, return retrieval results immediately.
    // This enables the deps pattern where retrieval-only services can be awaited
    // before mutations are executed.
    if (!callbacks.mutate) {
      return results;
    }

    await retrievalUow.mutationPhase;

    return await awaitPromisesInObject(mutationResult);
  })();

  // Build the result object with Promise-like behavior
  return {
    retrievalResult: retrievalResultPromise,
    // eslint-disable-next-line oxlint/no-thenable -- Intentionally thenable for await support
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
    [Symbol.toStringTag]: "ServiceTxResult",
  };
}

/**
 * @deprecated Use createServiceTx with deps callback instead.
 *
 * Execute a transaction for service context with dependencies pattern.
 * Call other services as dependencies, access their results after retrieval, then use in mutate.
 *
 * This enables service-to-service composition within a transaction.
 * Deps can have mutations - we access their `retrievalResult` after retrieval phase,
 * before mutations are executed.
 *
 * @param depsFactory - Factory that returns an array of service results
 * @param callbacks - Object containing mutate callback that receives resolved deps
 * @param baseUow - Base Unit of Work (restricted) to use
 * @returns ServiceTxResult resolving to the mutation result with promises awaited 1 level deep
 *
 * @example
 * ```ts
 * const orderId = await executeServiceTxWithDeps(
 *   () => [userService.getUserById(userId)],
 *   {
 *     mutate: (context, [user]) => {
 *       if (!user) throw new Error("User not found");
 *       return context.forSchema(ordersSchema).create("orders", { userId: user.id });
 *     }
 *   },
 *   baseUow
 * );
 * ```
 */
export function executeServiceTxWithDeps<
  TDepsItems extends readonly (ServiceTxResult<unknown, unknown> | PromiseLike<unknown>)[],
  TMutationResult,
  THooks extends HooksMap,
>(
  depsFactory: () => TDepsItems,
  callbacks: {
    /**
     * Mutation phase callback - receives resolved dependencies (retrieval results), schedules mutations
     * May return a promise to be awaited
     */
    mutate: (
      context: TxPhaseContext<THooks>,
      deps: ExtractDepsRetrievalResults<TDepsItems>,
    ) => TMutationResult;
  },
  baseUow: IUnitOfWork,
): ServiceTxResult<
  AwaitedPromisesInObject<TMutationResult>,
  ExtractDepsRetrievalResults<TDepsItems>
> {
  // Type alias for cleaner internal usage
  type TDeps = ExtractDepsRetrievalResults<TDepsItems>;

  // Deferred promise for retrieval results (deps) - resolves when deps are resolved
  const {
    promise: retrievalResult,
    resolve: resolveRetrievalResult,
    reject: rejectRetrievalResult,
  } = Promise.withResolvers<TDeps>();

  const promise = (async () => {
    // Get a restricted view that signals readiness
    const restrictedUow = baseUow.restrict({ readyFor: "none" });

    // Call deps factory - this invokes other services which schedule their operations
    let depsResults: TDepsItems;
    try {
      depsResults = depsFactory();
    } catch (error) {
      restrictedUow.signalReadyForRetrieval();
      restrictedUow.signalReadyForMutation();
      rejectRetrievalResult(error);
      throw error;
    }

    // Signal ready for retrieval (deps have scheduled their operations)
    restrictedUow.signalReadyForRetrieval();

    // Wait for retrieval phase - handler will execute all scheduled retrievals
    // After this, deps' mutate callbacks have run and retrievalResult is set
    await restrictedUow.retrievalPhase;

    // Extract deps from retrievalResult (for ServiceTxResult) or await (for regular promises)
    const deps = (await Promise.all(
      depsResults.map(async (dep) => {
        if (dep && typeof dep === "object" && "retrievalResult" in dep) {
          return await (dep as ServiceTxResult<unknown>).retrievalResult;
        }
        return await dep;
      }),
    )) as TDeps;

    // Create context for mutate callback
    const context: TxPhaseContext<THooks> = {
      forSchema: <S extends AnySchema, H extends HooksMap = THooks>(schema: S, hooks?: H) => {
        return baseUow.forSchema(schema, hooks);
      },
      nonce: baseUow.nonce,
      currentAttempt: 0, // Service doesn't know the attempt number
    };

    // Resolve the retrieval promise (deps) BEFORE calling mutate
    resolveRetrievalResult(deps);

    // Call mutate with resolved deps
    let mutationResult: TMutationResult;
    try {
      mutationResult = callbacks.mutate(context, deps);
    } catch (error) {
      restrictedUow.signalReadyForMutation();
      throw error;
    }

    // Signal ready for mutation
    restrictedUow.signalReadyForMutation();

    // Wait for mutation phase - handler will execute all scheduled mutations
    await restrictedUow.mutationPhase;

    return await awaitPromisesInObject(mutationResult);
  })();

  return {
    retrievalResult,
    // eslint-disable-next-line oxlint/no-thenable -- Intentionally thenable for await support
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
    [Symbol.toStringTag]: "ServiceTxResult",
  };
}
