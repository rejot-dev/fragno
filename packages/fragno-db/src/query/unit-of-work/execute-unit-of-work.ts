import type { AnySchema } from "../../schema/create";
import type { TypedUnitOfWork, IUnitOfWork } from "./unit-of-work";
import type { HooksMap } from "../../hooks/hooks";
import { ExponentialBackoffRetryPolicy, type RetryPolicy } from "./retry-policy";

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
  callbacks: ServiceTxCallbacks<
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

// ============================================================================
// Builder Pattern Types and Classes
// ============================================================================

/**
 * Extract service retrieve results from service call dependencies.
 * Maps over the array to extract TRetrieveSuccessResult from each TxResult.
 */
export type ExtractServiceRetrieveResults<T extends readonly unknown[]> = {
  [K in keyof T]: ExtractTxRetrieveSuccessResult<T[K]>;
};

/**
 * Extract final results from service call dependencies.
 * Maps over the array to extract the final result type from each TxResult.
 */
export type ExtractServiceFinalResults<T extends readonly unknown[]> = {
  [K in keyof T]: ExtractTxFinalResult<T[K]>;
};

/**
 * Context passed to service-level mutate callback in builder pattern.
 */
export interface ServiceBuilderMutateContext<
  TSchema extends AnySchema,
  TRetrieveSuccessResult,
  TServiceRetrieveResult extends readonly unknown[],
  THooks extends HooksMap,
> {
  /** Unit of work for scheduling mutations */
  uow: TypedUnitOfWork<TSchema, [], unknown, THooks>;
  /** Result from transformRetrieve callback (or raw retrieve results if no transformRetrieve) */
  retrieveResult: TRetrieveSuccessResult;
  /** Array of retrieve results from service call dependencies */
  serviceRetrieveResult: TServiceRetrieveResult;
}

/**
 * Context passed to handler-level mutate callback in builder pattern.
 */
export interface HandlerBuilderMutateContext<
  TRetrieveSuccessResult,
  TServiceRetrieveResult extends readonly unknown[],
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
  attemptCount: number;
  /** Result from transformRetrieve callback (or raw retrieve results if no transformRetrieve) */
  retrieveResult: TRetrieveSuccessResult;
  /** Array of retrieve results from service call dependencies */
  serviceRetrieveResult: TServiceRetrieveResult;
}

/**
 * Context passed to transform callback when mutate IS provided.
 */
export interface BuilderTransformContextWithMutate<
  TRetrieveSuccessResult,
  TMutateResult,
  TServiceResult extends readonly unknown[],
  TServiceRetrieveResult extends readonly unknown[],
> {
  /** Result from transformRetrieve callback (or raw retrieve results if no transformRetrieve) */
  retrieveResult: TRetrieveSuccessResult;
  /** Result from mutate callback */
  mutateResult: TMutateResult;
  /** Array of final results from service call dependencies */
  serviceResult: TServiceResult;
  /** Array of retrieve results from service call dependencies */
  serviceRetrieveResult: TServiceRetrieveResult;
}

/**
 * Context passed to transform callback when mutate is NOT provided.
 */
export interface BuilderTransformContextWithoutMutate<
  TRetrieveSuccessResult,
  TServiceResult extends readonly unknown[],
  TServiceRetrieveResult extends readonly unknown[],
> {
  /** Result from transformRetrieve callback (or raw retrieve results if no transformRetrieve) */
  retrieveResult: TRetrieveSuccessResult;
  /** No mutate callback was provided */
  mutateResult: undefined;
  /** Array of final results from service call dependencies */
  serviceResult: TServiceResult;
  /** Array of retrieve results from service call dependencies */
  serviceRetrieveResult: TServiceRetrieveResult;
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
 * - Else: TRetrieveResults (raw retrieve results)
 */
export type InferBuilderRetrieveSuccessResult<
  TRetrieveResults extends unknown[],
  TRetrieveSuccessResult,
  HasTransformRetrieve extends boolean,
> = HasTransformRetrieve extends true ? TRetrieveSuccessResult : TRetrieveResults;

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
 * return serviceTxBuilder(schema)
 *   .withServiceCalls(() => [otherService.getData()])
 *   .retrieve((uow) => uow.find("users", ...))
 *   .transformRetrieve(([users]) => users[0])
 *   .mutate(({ uow, retrieveResult, serviceRetrieveResult }) =>
 *     uow.create("records", { ... })
 *   )
 *   .transform(({ mutateResult, serviceResult }) => ({ id: mutateResult }))
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
   * Add service call dependencies to execute before this transaction.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withServiceCalls<TNewServiceCalls extends readonly (TxResult<any, any> | undefined)[]>(
    fn: () => TNewServiceCalls,
  ): ServiceTxBuilder<
    TSchema,
    TNewServiceCalls,
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
      TNewServiceCalls,
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
      serviceRetrieveResult: ExtractServiceRetrieveResults<TServiceCalls>,
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
      HasTransformRetrieve
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
      deps: state.withServiceCallsFn,
      retrieve: state.retrieveFn,
      retrieveSuccess: state.transformRetrieveFn,
      mutate: state.mutateFn
        ? (ctx) => {
            // Map old context field names to new ones
            return state.mutateFn!({
              uow: ctx.uow,
              retrieveResult: ctx.retrieveResult,
              serviceRetrieveResult:
                ctx.depsRetrieveResult as ExtractServiceRetrieveResults<TServiceCalls>,
            });
          }
        : undefined,
      success: state.transformFn
        ? (ctx) => {
            // Map old context field names to new ones
            return state.transformFn!({
              retrieveResult: ctx.retrieveResult,
              mutateResult: ctx.mutateResult,
              serviceResult: ctx.depsResult as ExtractServiceFinalResults<TServiceCalls>,
              serviceRetrieveResult:
                ctx.depsRetrieveResult as ExtractServiceRetrieveResults<TServiceCalls>,
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
        HasTransformRetrieve
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
    attemptCount: number;
  }) => TRetrieveResults | void;
  transformRetrieveFn?: (
    retrieveResult: TRetrieveResults,
    serviceRetrieveResult: ExtractServiceRetrieveResults<TServiceCalls>,
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
 * const result = await handlerTxBuilder()
 *   .withServiceCalls(() => [userService.getUser(id)])
 *   .mutate(({ forSchema, idempotencyKey, attemptCount, serviceRetrieveResult }) => {
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
   * Add service call dependencies to execute before this transaction.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withServiceCalls<TNewServiceCalls extends readonly (TxResult<any, any> | undefined)[]>(
    fn: () => TNewServiceCalls,
  ): HandlerTxBuilder<
    TNewServiceCalls,
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
      TNewServiceCalls,
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
    fn: (context: {
      forSchema: <S extends AnySchema, H extends HooksMap = THooks>(
        schema: S,
        hooks?: H,
      ) => TypedUnitOfWork<S, [], unknown, H>;
      idempotencyKey: string;
      attemptCount: number;
    }) => TNewRetrieveResults | void,
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
      serviceRetrieveResult: ExtractServiceRetrieveResults<TServiceCalls>,
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
      deps: state.withServiceCallsFn,
      retrieve: state.retrieveFn
        ? (context) => {
            // Map old context field names to new ones
            return state.retrieveFn!({
              forSchema: context.forSchema,
              idempotencyKey: context.nonce,
              attemptCount: context.currentAttempt,
            });
          }
        : undefined,
      retrieveSuccess: state.transformRetrieveFn,
      mutate: state.mutateFn
        ? (ctx) => {
            // Map old context field names to new ones
            return state.mutateFn!({
              forSchema: ctx.forSchema,
              idempotencyKey: ctx.nonce,
              attemptCount: ctx.currentAttempt,
              retrieveResult: ctx.retrieveResult,
              serviceRetrieveResult:
                ctx.depsRetrieveResult as ExtractServiceRetrieveResults<TServiceCalls>,
            });
          }
        : undefined,
      success: state.transformFn
        ? (ctx) => {
            // Map old context field names to new ones
            return state.transformFn!({
              retrieveResult: ctx.retrieveResult,
              mutateResult: ctx.mutateResult,
              serviceResult: ctx.depsResult as ExtractServiceFinalResults<TServiceCalls>,
              serviceRetrieveResult:
                ctx.depsRetrieveResult as ExtractServiceRetrieveResults<TServiceCalls>,
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
