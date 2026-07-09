import type { AnySchema } from "@fragno-dev/db/schema";
import { atom, onMount, type ReadableAtom } from "nanostores";

import type {
  LofiQueryFindFirstResult,
  LofiQueryFindResult,
  LofiQueryFindWithCursorResult,
} from "../query-types";
import type { LofiFindBuilder } from "../query/read-plan";
import type { LofiQueryEngineOptions } from "../types";
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
  error: unknown | null;
  synced: boolean;
  updatedAt?: number;
};

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

export interface LofiRuntimeStoreRetrieveBuilder<TRetrieveResult, TData = TRetrieveResult> {
  transformRetrieve<TNewData>(
    fn: (retrieveResult: TRetrieveResult) => TNewData | Promise<TNewData>,
  ): LofiRuntimeStoreRetrieveBuilder<TRetrieveResult, Awaited<TNewData>>;

  withInitialData(initialData: LofiNoInfer<TData>): LofiQueryStore<TData>;
}

export interface LofiRuntimeStoreBuilder {
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

class RuntimeStoreRetrieveBuilder<
  TRetrieveResult,
  TData = TRetrieveResult,
> implements LofiRuntimeStoreRetrieveBuilder<TRetrieveResult, TData> {
  private readonly runtime: LofiRuntime;
  private readonly retrieveFn: (context: LofiRuntimeTxRetrieveContext) => unknown;
  private readonly transformRetrieveFn?: (
    retrieveResult: TRetrieveResult,
  ) => TData | Promise<TData>;

  constructor(
    runtime: LofiRuntime,
    retrieveFn: (context: LofiRuntimeTxRetrieveContext) => unknown,
    transformRetrieveFn?: (retrieveResult: TRetrieveResult) => TData | Promise<TData>,
  ) {
    this.runtime = runtime;
    this.retrieveFn = retrieveFn;
    this.transformRetrieveFn = transformRetrieveFn;
  }

  transformRetrieve<TNewData>(
    fn: (retrieveResult: TRetrieveResult) => TNewData | Promise<TNewData>,
  ): LofiRuntimeStoreRetrieveBuilder<TRetrieveResult, Awaited<TNewData>> {
    return new RuntimeStoreRetrieveBuilder(this.runtime, this.retrieveFn, fn as never);
  }

  withInitialData(initialData: LofiNoInfer<TData>): LofiQueryStore<TData> {
    if (this.transformRetrieveFn) {
      return createLofiQueryStore(this.runtime, () => this.runtime.tx().retrieve(this.retrieveFn), {
        initialData,
        map: this.transformRetrieveFn,
      } as never) as LofiQueryStore<TData>;
    }

    return createLofiQueryStore(this.runtime, () => this.runtime.tx().retrieve(this.retrieveFn), {
      initialData,
    } as never) as LofiQueryStore<TData>;
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

  const $store = atom<LofiQueryState<TData>>({
    data: options.initialData,
    loading: false,
    error: null,
    synced: false,
  });

  let requestId = 0;

  const runQuery = async (): Promise<void> => {
    const currentRequestId = requestId + 1;
    requestId = currentRequestId;

    $store.set({
      ...$store.get(),
      loading: true,
      error: null,
    });

    try {
      const rows = (
        typeof retrieveFn === "function"
          ? await executeRetrieve(runtime, retrieveFn)
          : await runtime.adapter
              .createQueryEngine(retrieveFn)
              .find(optionsOrTable as keyof AnySchema["tables"] & string, builderFn as never)
      ) as TRaw;
      const data = options.map ? await options.map(rows) : (rows as unknown as TData);

      if (requestId !== currentRequestId) {
        return;
      }

      $store.set({
        data,
        loading: false,
        error: null,
        synced: true,
        updatedAt: Date.now(),
      });
    } catch (error) {
      if (requestId !== currentRequestId) {
        return;
      }

      $store.set({
        ...$store.get(),
        loading: false,
        error,
      });
    }
  };

  const queryStore = $store as unknown as LofiQueryStore<TData>;
  queryStore.refresh = runQuery;

  onMount($store, () => {
    let mounted = true;
    const releaseRuntime = runtime.retain();
    const unsubscribeRevision = runtime.$revision.listen(() => {
      if (isLofiRuntimeBootstrappedStatus(runtime.$status.get())) {
        void runQuery();
      }
    });

    $store.set({
      ...$store.get(),
      loading: true,
      error: null,
    });

    void runtime
      .whenBootstrapped()
      .then(() => {
        if (mounted) {
          void runQuery();
        }
      })
      .catch((error) => {
        if (!mounted) {
          return;
        }

        $store.set({
          ...$store.get(),
          loading: false,
          error,
        });
      });

    return () => {
      mounted = false;
      unsubscribeRevision();
      releaseRuntime();
    };
  });

  return queryStore;
}
