import type { AnySchema } from "@fragno-dev/db/schema";
import { atom, onMount, type ReadableAtom } from "nanostores";

import type {
  LofiQueryFindFirstResult,
  LofiQueryFindResult,
  LofiQueryFindWithCursorResult,
} from "../query-types";
import type { LofiFindBuilder } from "../query/read-plan";
import type { LofiMutation, LofiQueryEngineOptions, LofiResolvedTypedMutation } from "../types";
import type { LofiRuntime, LofiRuntimeStatus } from "./runtime";
import {
  isLofiRuntimeTxBuilder,
  type LofiRuntimeTxBuilder,
  type LofiRuntimeTxResolved,
  type LofiRuntimeTxResult,
  type LofiRuntimeTxRetrieveContext,
} from "./tx";

export type LofiQueryState<TData> = {
  data: TData;
  loading: boolean;
  error: Error | null;
  synced: boolean;
  updatedAt?: number;
};

const normalizeLofiQueryError = (error: unknown): Error =>
  error instanceof Error ? error : new Error("Lofi query failed", { cause: error });

export type LofiQueryStore<TData> = ReadableAtom<LofiQueryState<TData>> & {
  refresh: () => Promise<void>;
};

const isLofiRuntimeBootstrappedStatus = (status: LofiRuntimeStatus): boolean =>
  Object.values(status.sources).every((source) => source.status === "bootstrapped");

type LofiNoInfer<T> = [T][T extends T ? 0 : never];

type LofiQueryRawResult<
  TSchema extends AnySchema,
  TTableName extends keyof TSchema["tables"] & string,
  TBuilderResult,
> = LofiQueryFindResult<TSchema["tables"][TTableName], TBuilderResult>;

export type LofiQueryStoreOptions<TRaw, TData = TRaw> = {
  initialData: LofiNoInfer<TData>;
  map?: (rows: TRaw) => TData;
};

export type LofiQueryStoreRetrieveUnit<
  TSchema extends AnySchema,
  TRetrieveResults extends unknown[] = [],
> = {
  /** Type-only retrieval result tuple, matching Fragno UOW retrieve(). */
  readonly $results: TRetrieveResults;

  find: <TTableName extends keyof TSchema["tables"] & string, const TBuilderResult>(
    table: TTableName,
    builderFn: (builder: LofiFindBuilder<TSchema, TTableName>) => TBuilderResult,
  ) => LofiQueryStoreRetrieveUnit<
    TSchema,
    [...TRetrieveResults, LofiQueryFindResult<TSchema["tables"][TTableName], TBuilderResult>]
  >;

  findFirst: <TTableName extends keyof TSchema["tables"] & string, const TBuilderResult>(
    table: TTableName,
    builderFn: (builder: LofiFindBuilder<TSchema, TTableName>) => TBuilderResult,
  ) => LofiQueryStoreRetrieveUnit<
    TSchema,
    [...TRetrieveResults, LofiQueryFindFirstResult<TSchema["tables"][TTableName], TBuilderResult>]
  >;

  findWithCursor: <TTableName extends keyof TSchema["tables"] & string, const TBuilderResult>(
    table: TTableName,
    builderFn: (builder: LofiFindBuilder<TSchema, TTableName>) => TBuilderResult,
  ) => LofiQueryStoreRetrieveUnit<
    TSchema,
    [
      ...TRetrieveResults,
      LofiQueryFindWithCursorResult<TSchema["tables"][TTableName], TBuilderResult>,
    ]
  >;
};

export type LofiQueryStoreRetrieveContext = {
  forSchema: <const TSchema extends AnySchema>(
    schema: TSchema,
    options?: LofiQueryEngineOptions,
  ) => LofiQueryStoreRetrieveUnit<TSchema>;
};

export type LofiQueryStoreResolvedRetrieve<T> = T extends {
  readonly $results: infer TResult extends unknown[];
}
  ? TResult
  : [];

type RawLofiQueryStoreOptions<TRaw> = {
  initialData: TRaw;
  map?: undefined;
};

type MappedLofiQueryStoreOptions<TRaw, TData> = {
  initialData: LofiNoInfer<TData>;
  map: (rows: TRaw) => TData | Promise<TData>;
};

export type LofiRuntimeStoreEphemeralContext<TRetrieveResult, TData> = {
  /** Most recent successful durable retrieval, before transformRetrieve is applied. */
  retrieved: TRetrieveResult;
  /** Most recent transformed durable value, without any ephemeral overlays. */
  durableData: TData;
};

export type LofiRuntimeStoreEphemeralOptions<
  TRetrieveResult,
  TData,
  TState,
  TSchema extends AnySchema,
  TTableName extends keyof TSchema["tables"] & string,
> = {
  /**
   * Creates the private accumulator for this ephemeral stream.
   *
   * The accumulator survives durable query refreshes while the store is mounted. Remounting starts
   * from a fresh accumulator and rebuilds recoverable streams through replay.
   */
  initialState: () => TState;

  /**
   * Folds one create from the ephemeral table into the accumulator.
   *
   * Timestamp defaults produced from DbNow are Dates here; unresolved tags are rejected before the
   * callback. Return the updated accumulator when the item was accepted. Return undefined to ignore
   * the item without notifying store subscribers.
   * Items received before the first durable retrieval are queued and reduced once retrieval
   * completes.
   */
  reduce: (
    state: TState,
    item: LofiResolvedTypedMutation<TSchema, TTableName, "create">["values"],
    context: LofiRuntimeStoreEphemeralContext<TRetrieveResult, TData>,
  ) => TState | undefined;

  /**
   * Reconciles accumulated ephemeral state after each successful durable retrieval.
   *
   * Use this to discard streamed state that has become represented by durable rows. The function
   * may mutate and return nothing, or return a replacement accumulator.
   */
  reconcile?: (
    state: TState,
    context: LofiRuntimeStoreEphemeralContext<TRetrieveResult, TData>,
  ) => TState | void;

  /**
   * Combines the current store data with the ephemeral accumulator.
   *
   * This runs after every accepted ephemeral item and after every durable retrieval. The first
   * overlay receives transformed durable data; additional ephemeral bindings receive the result of
   * earlier overlays. The original transformed value remains available as context.durableData.
   */
  overlay: (
    data: TData,
    state: TState,
    context: LofiRuntimeStoreEphemeralContext<TRetrieveResult, TData>,
  ) => TData;
};

export interface LofiRuntimeStoreEphemeralBuilder<TRetrieveResult, TData> {
  /**
   * Adds an append-only ephemeral table stream to this store.
   *
   * Ephemeral creates update the exposed data through reduce and overlay without being persisted
   * or re-running the durable retrieval. Update and delete mutations are intentionally ignored;
   * use runtime.subscribeEphemeral when mutation-level handling is required.
   */
  withEphemeral<
    const TSchema extends AnySchema,
    const TTableName extends keyof TSchema["tables"] & string,
    TState,
  >(
    schema: TSchema,
    table: TTableName,
    options: LofiRuntimeStoreEphemeralOptions<TRetrieveResult, TData, TState, TSchema, TTableName>,
  ): LofiRuntimeStoreEphemeralBuilder<TRetrieveResult, TData>;

  /** Completes the builder with data exposed until the first durable retrieval succeeds. */
  withInitialData(initialData: LofiNoInfer<TData>): LofiQueryStore<TData>;
}

export interface LofiRuntimeStoreRetrieveBuilder<
  TRetrieveResult,
  TData = TRetrieveResult,
> extends LofiRuntimeStoreEphemeralBuilder<TRetrieveResult, TData> {
  /** Maps each durable retrieval before ephemeral state is reconciled and overlaid. */
  transformRetrieve<TNewData>(
    fn: (retrieveResult: TRetrieveResult) => TNewData | Promise<TNewData>,
  ): LofiRuntimeStoreRetrieveBuilder<TRetrieveResult, Awaited<TNewData>>;
}

export interface LofiRuntimeStoreBuilder {
  /** Declares the durable local queries that refresh when the runtime revision changes. */
  retrieve<TSelection>(
    fn: (context: LofiRuntimeTxRetrieveContext) => TSelection,
  ): LofiRuntimeStoreRetrieveBuilder<Awaited<LofiRuntimeTxResolved<TSelection>>>;
}

export type LofiRuntimeStoreFactory = () => LofiRuntimeStoreBuilder;

type LofiQueryOperation = {
  schema: AnySchema;
  options?: LofiQueryEngineOptions;
  method: "find" | "findFirst" | "findWithCursor";
  table: string;
  builderFn: (builder: LofiFindBuilder<AnySchema, string>) => unknown;
};

const createRetrieveUnit = <const TSchema extends AnySchema>(
  operations: LofiQueryOperation[],
  schema: TSchema,
  options?: LofiQueryEngineOptions,
): LofiQueryStoreRetrieveUnit<TSchema> => {
  const unit = {
    get $results(): never {
      throw new Error("LofiQueryStoreRetrieveUnit.$results is type-only.");
    },
    find(table: string, builderFn: (builder: LofiFindBuilder<AnySchema, string>) => unknown) {
      operations.push({ schema, options, method: "find", table, builderFn });
      return unit;
    },
    findFirst(table: string, builderFn: (builder: LofiFindBuilder<AnySchema, string>) => unknown) {
      operations.push({ schema, options, method: "findFirst", table, builderFn });
      return unit;
    },
    findWithCursor(
      table: string,
      builderFn: (builder: LofiFindBuilder<AnySchema, string>) => unknown,
    ) {
      operations.push({ schema, options, method: "findWithCursor", table, builderFn });
      return unit;
    },
  };

  return unit as unknown as LofiQueryStoreRetrieveUnit<TSchema>;
};

type RuntimeStoreEphemeralBinding<TRetrieveResult, TData> = {
  schema: AnySchema;
  table: string;
  initialState: () => unknown;
  reduce: (
    state: unknown,
    item: unknown,
    context: LofiRuntimeStoreEphemeralContext<TRetrieveResult, TData>,
  ) => unknown;
  reconcile?: (
    state: unknown,
    context: LofiRuntimeStoreEphemeralContext<TRetrieveResult, TData>,
  ) => unknown;
  overlay: (
    data: TData,
    state: unknown,
    context: LofiRuntimeStoreEphemeralContext<TRetrieveResult, TData>,
  ) => TData;
};

class RuntimeStoreRetrieveBuilder<
  TRetrieveResult,
  TData = TRetrieveResult,
> implements LofiRuntimeStoreRetrieveBuilder<TRetrieveResult, TData> {
  private readonly runtime: LofiRuntime;
  private readonly retrieveFn: (context: LofiRuntimeTxRetrieveContext) => unknown;
  private readonly transformRetrieveFn?: (
    retrieveResult: TRetrieveResult,
  ) => TData | Promise<TData>;
  private readonly ephemeralBindings: RuntimeStoreEphemeralBinding<TRetrieveResult, TData>[];

  constructor(
    runtime: LofiRuntime,
    retrieveFn: (context: LofiRuntimeTxRetrieveContext) => unknown,
    transformRetrieveFn?: (retrieveResult: TRetrieveResult) => TData | Promise<TData>,
    ephemeralBindings: RuntimeStoreEphemeralBinding<TRetrieveResult, TData>[] = [],
  ) {
    this.runtime = runtime;
    this.retrieveFn = retrieveFn;
    this.transformRetrieveFn = transformRetrieveFn;
    this.ephemeralBindings = ephemeralBindings;
  }

  transformRetrieve<TNewData>(
    fn: (retrieveResult: TRetrieveResult) => TNewData | Promise<TNewData>,
  ): LofiRuntimeStoreRetrieveBuilder<TRetrieveResult, Awaited<TNewData>> {
    return new RuntimeStoreRetrieveBuilder(this.runtime, this.retrieveFn, fn as never);
  }

  withEphemeral<
    const TSchema extends AnySchema,
    const TTableName extends keyof TSchema["tables"] & string,
    TState,
  >(
    schema: TSchema,
    table: TTableName,
    options: LofiRuntimeStoreEphemeralOptions<TRetrieveResult, TData, TState, TSchema, TTableName>,
  ): LofiRuntimeStoreEphemeralBuilder<TRetrieveResult, TData> {
    const binding: RuntimeStoreEphemeralBinding<TRetrieveResult, TData> = {
      schema,
      table,
      initialState: options.initialState,
      reduce: options.reduce as RuntimeStoreEphemeralBinding<TRetrieveResult, TData>["reduce"],
      reconcile: options.reconcile as RuntimeStoreEphemeralBinding<
        TRetrieveResult,
        TData
      >["reconcile"],
      overlay: options.overlay as RuntimeStoreEphemeralBinding<TRetrieveResult, TData>["overlay"],
    };
    return new RuntimeStoreRetrieveBuilder(
      this.runtime,
      this.retrieveFn,
      this.transformRetrieveFn,
      [...this.ephemeralBindings, binding],
    );
  }

  withInitialData(initialData: LofiNoInfer<TData>): LofiQueryStore<TData> {
    return createManagedLofiQueryStore({
      runtime: this.runtime,
      retrieve: () =>
        this.runtime.tx().retrieve(this.retrieveFn).execute() as Promise<TRetrieveResult>,
      transform: this.transformRetrieveFn ?? ((result) => result as unknown as TData),
      initialData,
      ephemeralBindings: this.ephemeralBindings,
    });
  }
}

export const createLofiRuntimeStore = (runtime: LofiRuntime): LofiRuntimeStoreBuilder => ({
  retrieve<TSelection>(fn: (context: LofiRuntimeTxRetrieveContext) => TSelection) {
    return new RuntimeStoreRetrieveBuilder<Awaited<LofiRuntimeTxResolved<TSelection>>>(runtime, fn);
  },
});

const executeRetrieve = async (
  runtime: LofiRuntime,
  retrieveFn: (context: LofiQueryStoreRetrieveContext) => unknown,
): Promise<unknown> => {
  const operations: LofiQueryOperation[] = [];
  const result = retrieveFn({
    forSchema: (schema, options) => createRetrieveUnit(operations, schema, options),
  });

  if (isLofiRuntimeTxBuilder(result)) {
    return await result.execute();
  }

  return await Promise.all(
    operations.map((operation) => {
      const query = runtime.adapter.createQueryEngine(operation.schema, operation.options);
      if (operation.method === "findFirst") {
        return query.findFirst(operation.table, operation.builderFn as never);
      }
      if (operation.method === "findWithCursor") {
        return query.findWithCursor(operation.table, operation.builderFn as never);
      }
      return query.find(operation.table, operation.builderFn as never);
    }),
  );
};

type ManagedLofiQueryStoreOptions<TRetrieveResult, TData> = {
  runtime: LofiRuntime;
  retrieve: () => Promise<TRetrieveResult>;
  transform: (retrieved: TRetrieveResult) => TData | Promise<TData>;
  initialData: TData;
  ephemeralBindings?: RuntimeStoreEphemeralBinding<TRetrieveResult, TData>[];
};

const createManagedLofiQueryStore = <TRetrieveResult, TData>({
  runtime,
  retrieve,
  transform,
  initialData,
  ephemeralBindings = [],
}: ManagedLofiQueryStoreOptions<TRetrieveResult, TData>): LofiQueryStore<TData> => {
  const $store = atom<LofiQueryState<TData>>({
    data: initialData,
    loading: false,
    error: null,
    synced: false,
  });
  let ephemeralStates = ephemeralBindings.map((binding) => binding.initialState());
  const pendingEphemeralItems: Array<{ bindingIndex: number; item: unknown }> = [];
  let requestId = 0;
  let hasRetrieved = false;
  let resetEphemeralStateOnMount = false;
  let latestRetrieved: TRetrieveResult;
  let durableData: TData;

  const ephemeralContext = (): LofiRuntimeStoreEphemeralContext<TRetrieveResult, TData> => ({
    retrieved: latestRetrieved,
    durableData,
  });

  const overlayEphemeralState = (): TData => {
    const context = ephemeralContext();
    return ephemeralBindings.reduce(
      (data, binding, index) => binding.overlay(data, ephemeralStates[index], context),
      durableData,
    );
  };

  const reduceEphemeralItem = (bindingIndex: number, item: unknown): boolean => {
    const nextState = ephemeralBindings[bindingIndex]?.reduce(
      ephemeralStates[bindingIndex],
      item,
      ephemeralContext(),
    );
    if (nextState === undefined) {
      return false;
    }
    ephemeralStates[bindingIndex] = nextState;
    return true;
  };

  const receiveEphemeralMutation = (bindingIndex: number, mutation: LofiMutation): void => {
    if (mutation.op !== "create") {
      return;
    }
    if (!hasRetrieved) {
      pendingEphemeralItems.push({ bindingIndex, item: mutation.values });
      return;
    }
    if (!reduceEphemeralItem(bindingIndex, mutation.values)) {
      return;
    }
    $store.set({ ...$store.get(), data: overlayEphemeralState(), updatedAt: Date.now() });
  };

  const runQuery = async (): Promise<void> => {
    const currentRequestId = requestId + 1;
    requestId = currentRequestId;

    $store.set({ ...$store.get(), loading: true, error: null });

    try {
      const retrieved = await retrieve();
      const transformed = await transform(retrieved);
      if (requestId !== currentRequestId) {
        return;
      }

      latestRetrieved = retrieved;
      durableData = transformed;
      hasRetrieved = true;
      const context = ephemeralContext();
      for (const [index, binding] of ephemeralBindings.entries()) {
        const reconciledState = binding.reconcile?.(ephemeralStates[index], context);
        if (reconciledState !== undefined) {
          ephemeralStates[index] = reconciledState;
        }
      }
      for (const pending of pendingEphemeralItems.splice(0)) {
        reduceEphemeralItem(pending.bindingIndex, pending.item);
      }

      $store.set({
        data: overlayEphemeralState(),
        loading: false,
        error: null,
        synced: true,
        updatedAt: Date.now(),
      });
    } catch (error) {
      if (requestId !== currentRequestId) {
        return;
      }
      $store.set({ ...$store.get(), loading: false, error: normalizeLofiQueryError(error) });
    }
  };

  const queryStore = $store as unknown as LofiQueryStore<TData>;
  queryStore.refresh = runQuery;

  onMount($store, () => {
    let mounted = true;
    if (resetEphemeralStateOnMount) {
      ephemeralStates = ephemeralBindings.map((binding) => binding.initialState());
      resetEphemeralStateOnMount = false;
    }
    const unsubscribeEphemeral = ephemeralBindings.map((binding, index) =>
      runtime.subscribeEphemeral(binding.schema, binding.table as never, (mutation) => {
        if (!mounted) {
          return;
        }
        try {
          receiveEphemeralMutation(index, mutation as LofiMutation);
        } catch (error) {
          $store.set({ ...$store.get(), error: normalizeLofiQueryError(error) });
        }
      }),
    );
    const releaseRuntime = runtime.retain();
    const unsubscribeRevision = runtime.$revision.listen(() => {
      if (isLofiRuntimeBootstrappedStatus(runtime.$status.get())) {
        void runQuery();
      }
    });

    $store.set({ ...$store.get(), loading: true, error: null });

    void runtime
      .whenBootstrapped()
      .then(() => {
        if (mounted) {
          void runQuery();
        }
      })
      .catch((error: unknown) => {
        if (mounted) {
          $store.set({
            ...$store.get(),
            loading: false,
            error: normalizeLofiQueryError(error),
          });
        }
      });

    return () => {
      mounted = false;
      requestId += 1;
      hasRetrieved = false;
      pendingEphemeralItems.length = 0;
      resetEphemeralStateOnMount = true;
      unsubscribeRevision();
      for (const unsubscribe of unsubscribeEphemeral) {
        unsubscribe();
      }
      releaseRuntime();
    };
  });

  return queryStore;
};

export function createLofiQueryStore<const TRetrieveResults extends unknown[]>(
  runtime: LofiRuntime,
  retrieveFn: (context: LofiQueryStoreRetrieveContext) => {
    readonly $results: TRetrieveResults;
  },
  options: RawLofiQueryStoreOptions<TRetrieveResults>,
): LofiQueryStore<TRetrieveResults>;
export function createLofiQueryStore<const TRetrieveResults extends unknown[], TData>(
  runtime: LofiRuntime,
  retrieveFn: (context: LofiQueryStoreRetrieveContext) => {
    readonly $results: TRetrieveResults;
  },
  options: MappedLofiQueryStoreOptions<TRetrieveResults, TData>,
): LofiQueryStore<TData>;
export function createLofiQueryStore<
  TSchema extends AnySchema,
  TTableName extends keyof TSchema["tables"] & string,
  const TBuilderResult,
>(
  runtime: LofiRuntime,
  schema: TSchema,
  table: TTableName,
  builderFn: (builder: LofiFindBuilder<TSchema, TTableName>) => TBuilderResult,
  options: RawLofiQueryStoreOptions<LofiQueryRawResult<TSchema, TTableName, TBuilderResult>>,
): LofiQueryStore<LofiQueryRawResult<TSchema, TTableName, TBuilderResult>>;
export function createLofiQueryStore<
  TSchema extends AnySchema,
  TTableName extends keyof TSchema["tables"] & string,
  const TBuilderResult,
  TData,
>(
  runtime: LofiRuntime,
  schema: TSchema,
  table: TTableName,
  builderFn: (builder: LofiFindBuilder<TSchema, TTableName>) => TBuilderResult,
  options: MappedLofiQueryStoreOptions<
    LofiQueryRawResult<TSchema, TTableName, TBuilderResult>,
    TData
  >,
): LofiQueryStore<TData>;
export function createLofiQueryStore<
  TRetrieveResult,
  TTransformResult,
  HasTransform extends boolean,
>(
  runtime: LofiRuntime,
  retrieveFn: (
    context: LofiQueryStoreRetrieveContext,
  ) => LofiRuntimeTxBuilder<TRetrieveResult, TTransformResult, HasTransform>,
  options: RawLofiQueryStoreOptions<
    LofiRuntimeTxResult<TRetrieveResult, TTransformResult, HasTransform>
  >,
): LofiQueryStore<LofiRuntimeTxResult<TRetrieveResult, TTransformResult, HasTransform>>;
export function createLofiQueryStore<
  TRetrieveResult,
  TTransformResult,
  HasTransform extends boolean,
  TData,
>(
  runtime: LofiRuntime,
  retrieveFn: (
    context: LofiQueryStoreRetrieveContext,
  ) => LofiRuntimeTxBuilder<TRetrieveResult, TTransformResult, HasTransform>,
  options: MappedLofiQueryStoreOptions<
    LofiRuntimeTxResult<TRetrieveResult, TTransformResult, HasTransform>,
    TData
  >,
): LofiQueryStore<TData>;
export function createLofiQueryStore<TRaw, TData = TRaw>(
  runtime: LofiRuntime,
  retrieveFn: ((context: LofiQueryStoreRetrieveContext) => unknown) | AnySchema,
  optionsOrTable: LofiQueryStoreOptions<TRaw, TData> | string,
  builderFn?: (builder: LofiFindBuilder<AnySchema, string>) => unknown,
  legacyOptions?: LofiQueryStoreOptions<TRaw, TData>,
): LofiQueryStore<TData> {
  const options = (typeof retrieveFn === "function" ? optionsOrTable : legacyOptions) as
    | LofiQueryStoreOptions<TRaw, TData>
    | undefined;

  if (!options) {
    throw new Error("createLofiQueryStore requires options.");
  }

  return createManagedLofiQueryStore({
    runtime,
    retrieve: async () =>
      (typeof retrieveFn === "function"
        ? await executeRetrieve(runtime, retrieveFn)
        : await runtime.adapter
            .createQueryEngine(retrieveFn)
            .find(optionsOrTable as keyof AnySchema["tables"], builderFn as never)) as TRaw,
    transform: options.map ?? ((rows) => rows as unknown as TData),
    initialData: options.initialData,
  });
}
