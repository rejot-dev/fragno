import type { AnySchema } from "@fragno-dev/db/schema";
import { atom, onMount, type ReadableAtom } from "nanostores";

import type { LofiQueryFindResult } from "../query-types";
import type { LofiFindBuilder } from "../query/read-plan";
import type { LofiRuntime } from "./runtime";

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

type RawLofiQueryStoreOptions<TRaw> = {
  initialData: TRaw;
  map?: undefined;
};

type MappedLofiQueryStoreOptions<TRaw, TData> = {
  initialData: LofiNoInfer<TData>;
  map: (rows: TRaw) => TData;
};

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
  TSchema extends AnySchema,
  TTableName extends keyof TSchema["tables"] & string,
  const TBuilderResult,
  TRaw = LofiQueryRawResult<TSchema, TTableName, TBuilderResult>,
  TData = TRaw,
>(
  runtime: LofiRuntime,
  schema: TSchema,
  table: TTableName,
  builderFn: (builder: LofiFindBuilder<TSchema, TTableName>) => TBuilderResult,
  options: LofiQueryStoreOptions<TRaw, TData>,
): LofiQueryStore<TData> {
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
      const query = runtime.adapter.createQueryEngine(schema);
      const rows = (await query.find(table, builderFn)) as TRaw;
      const data = options.map ? options.map(rows) : (rows as unknown as TData);

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
    const releaseRuntime = runtime.retain();
    const unsubscribeRevision = runtime.$revision.listen(() => {
      void runQuery();
    });

    void runQuery();

    return () => {
      unsubscribeRevision();
      releaseRuntime();
    };
  });

  return queryStore;
}
